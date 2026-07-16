import { createHmac } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../../lib/test-pglite"
import {
	classifyPlanetScaleEvent,
	decodePlanetScaleWebhookPayload,
	planetScaleIssueFingerprint,
	upsertPlanetScaleIssue,
	verifyPlanetScaleSignature,
} from "./webhook-events"

const trackedDbs: TestDb[] = []

afterEach(async () => {
	await cleanupTestDbs(trackedDbs)
})

const asOrgId = Schema.decodeUnknownSync(OrgId)

const OOM_PAYLOAD = JSON.stringify({
	timestamp: 1698252879,
	event: "branch.out_of_memory",
	organization: "acme",
	database: "main-db",
	resource: { id: "br_1", type: "Branch", name: "main", production: true },
})

describe("verifyPlanetScaleSignature", () => {
	it("accepts the HMAC-SHA256 hex digest of the raw body", () => {
		const secret = "shh"
		const signature = createHmac("sha256", secret).update(OOM_PAYLOAD, "utf8").digest("hex")
		assert.isTrue(verifyPlanetScaleSignature(OOM_PAYLOAD, secret, signature))
	})

	it("rejects a wrong or missing signature", () => {
		assert.isFalse(verifyPlanetScaleSignature(OOM_PAYLOAD, "shh", "deadbeef"))
		assert.isFalse(verifyPlanetScaleSignature(OOM_PAYLOAD, "shh", undefined))
		const other = createHmac("sha256", "other-secret").update(OOM_PAYLOAD, "utf8").digest("hex")
		assert.isFalse(verifyPlanetScaleSignature(OOM_PAYLOAD, "shh", other))
	})
})

describe("classifyPlanetScaleEvent", () => {
	it("maps health events to issues and lifecycle events to logs", () => {
		assert.strictEqual(classifyPlanetScaleEvent("branch.out_of_memory").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("branch.anomaly").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("cluster.storage").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("keyspace.storage").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("deploy_request.opened").action, "log")
		assert.strictEqual(classifyPlanetScaleEvent("branch.ready").action, "log")
		assert.strictEqual(classifyPlanetScaleEvent("webhook.test").action, "test")
		// Forward-compatible: unknown events are acknowledged, never rejected.
		assert.strictEqual(classifyPlanetScaleEvent("branch.some_future_event").action, "log")
	})
})

describe("upsertPlanetScaleIssue", () => {
	it.effect("creates a kind=integration issue, dedupes repeats, and reopens resolved ones", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const payload = yield* decodePlanetScaleWebhookPayload(OOM_PAYLOAD)
			const orgId = asOrgId("org_1")
			const base = {
				orgId,
				payload,
				severity: "high" as const,
				title: "PlanetScale branch out of memory",
				description: "Branch main of main-db was restarted after running out of memory.",
			}

			const first = yield* upsertPlanetScaleIssue({ ...base, timestamp: 1_000 })
			assert.strictEqual(first.action, "created")
			assert.isNotNull(first.issueId)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ kind: string; fingerprint_hash: string; occurrence_count: number }>(
					testDb,
					"SELECT kind, fingerprint_hash, occurrence_count FROM error_issues WHERE id = $1",
					[first.issueId],
				),
			)
			assert.strictEqual(row?.kind, "integration")
			assert.strictEqual(
				row?.fingerprint_hash,
				planetScaleIssueFingerprint("main-db", "branch.out_of_memory"),
			)

			// Repeat firing dedupes into the same issue and bumps the count.
			const second = yield* upsertPlanetScaleIssue({ ...base, timestamp: 2_000 })
			assert.strictEqual(second.action, "refreshed")
			assert.strictEqual(second.issueId, first.issueId)

			// A resolved issue re-opens on the next firing.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE error_issues SET workflow_state = 'done' WHERE id = $1", [
					first.issueId,
				]),
			)
			const third = yield* upsertPlanetScaleIssue({ ...base, timestamp: 3_000 })
			assert.strictEqual(third.action, "reopened")

			const reopened = yield* Effect.promise(() =>
				queryFirstRow<{ workflow_state: string; occurrence_count: number }>(
					testDb,
					"SELECT workflow_state, occurrence_count FROM error_issues WHERE id = $1",
					[first.issueId],
				),
			)
			assert.strictEqual(reopened?.workflow_state, "triage")
			assert.strictEqual(reopened?.occurrence_count, 3)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("leaves a wontfix issue with an active snooze entirely alone", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const payload = yield* decodePlanetScaleWebhookPayload(OOM_PAYLOAD)
			const orgId = asOrgId("org_1")
			const base = {
				orgId,
				payload,
				severity: "high" as const,
				title: "PlanetScale branch out of memory",
				description: "Branch main of main-db was restarted after running out of memory.",
			}

			const first = yield* upsertPlanetScaleIssue({ ...base, timestamp: 1_000 })
			assert.strictEqual(first.action, "created")

			// Operator marks it wontfix with a snooze that has not yet expired.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE error_issues SET workflow_state = 'wontfix', snooze_until = $2 WHERE id = $1",
					[first.issueId, new Date(10_000).toISOString()],
				),
			)

			const second = yield* upsertPlanetScaleIssue({ ...base, timestamp: 5_000 })
			assert.strictEqual(second.action, "skipped")
			assert.strictEqual(second.issueId, first.issueId)

			// The skipped branch returns before any write: state, snooze,
			// occurrence count, and last-seen are all untouched.
			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					workflow_state: string
					occurrence_count: number
					snooze_null: boolean
					last_seen_ms: number
				}>(
					testDb,
					"SELECT workflow_state, occurrence_count, snooze_until IS NULL AS snooze_null, (EXTRACT(EPOCH FROM last_seen_at) * 1000)::int AS last_seen_ms FROM error_issues WHERE id = $1",
					[first.issueId],
				),
			)
			assert.strictEqual(row?.workflow_state, "wontfix")
			assert.strictEqual(row?.occurrence_count, 1)
			assert.strictEqual(row?.snooze_null, false)
			assert.strictEqual(row?.last_seen_ms, 1_000)

			// No state_change/regression events were recorded for the skipped firing.
			const events = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issue_events WHERE issue_id = $1 AND type <> 'created'",
					[first.issueId],
				),
			)
			assert.strictEqual(events?.count, 0)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("treats wontfix with no snooze deadline as snoozed indefinitely", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const payload = yield* decodePlanetScaleWebhookPayload(OOM_PAYLOAD)
			const orgId = asOrgId("org_1")
			const base = {
				orgId,
				payload,
				severity: "high" as const,
				title: "PlanetScale branch out of memory",
				description: "Branch main of main-db was restarted after running out of memory.",
			}

			const first = yield* upsertPlanetScaleIssue({ ...base, timestamp: 1_000 })
			assert.strictEqual(first.action, "created")

			// "Won't fix" with snooze_until NULL means "stop resurfacing this" —
			// no timestamp, however far in the future, ever reopens it.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE error_issues SET workflow_state = 'wontfix', snooze_until = NULL WHERE id = $1",
					[first.issueId],
				),
			)

			const farFuture = Date.UTC(2099, 0, 1)
			const second = yield* upsertPlanetScaleIssue({ ...base, timestamp: farFuture })
			assert.strictEqual(second.action, "skipped")
			assert.strictEqual(second.issueId, first.issueId)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ workflow_state: string; occurrence_count: number }>(
					testDb,
					"SELECT workflow_state, occurrence_count FROM error_issues WHERE id = $1",
					[first.issueId],
				),
			)
			assert.strictEqual(row?.workflow_state, "wontfix")
			assert.strictEqual(row?.occurrence_count, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("reopens a wontfix issue once its snooze has expired", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const payload = yield* decodePlanetScaleWebhookPayload(OOM_PAYLOAD)
			const orgId = asOrgId("org_1")
			const base = {
				orgId,
				payload,
				severity: "high" as const,
				title: "PlanetScale branch out of memory",
				description: "Branch main of main-db was restarted after running out of memory.",
			}

			const first = yield* upsertPlanetScaleIssue({ ...base, timestamp: 1_000 })
			assert.strictEqual(first.action, "created")

			// Snooze deadline is before the next firing's timestamp → expired.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE error_issues SET workflow_state = 'wontfix', snooze_until = $2 WHERE id = $1",
					[first.issueId, new Date(5_000).toISOString()],
				),
			)

			const second = yield* upsertPlanetScaleIssue({ ...base, timestamp: 10_000 })
			assert.strictEqual(second.action, "reopened")
			assert.strictEqual(second.issueId, first.issueId)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					workflow_state: string
					occurrence_count: number
					snooze_null: boolean
				}>(
					testDb,
					"SELECT workflow_state, occurrence_count, snooze_until IS NULL AS snooze_null FROM error_issues WHERE id = $1",
					[first.issueId],
				),
			)
			assert.strictEqual(row?.workflow_state, "triage")
			assert.strictEqual(row?.occurrence_count, 2)
			// Reopening clears the stale snooze deadline.
			assert.strictEqual(row?.snooze_null, true)

			// The reopen is audited as a state_change from wontfix plus a regression.
			const stateChange = yield* Effect.promise(() =>
				queryFirstRow<{ from_state: string; to_state: string }>(
					testDb,
					"SELECT from_state, to_state FROM error_issue_events WHERE issue_id = $1 AND type = 'state_change'",
					[first.issueId],
				),
			)
			assert.strictEqual(stateChange?.from_state, "wontfix")
			assert.strictEqual(stateChange?.to_state, "triage")
			const regression = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issue_events WHERE issue_id = $1 AND type = 'regression'",
					[first.issueId],
				),
			)
			assert.strictEqual(regression?.count, 1)
		}).pipe(Effect.provide(testDb.layer))
	})
})

describe("decodePlanetScaleWebhookPayload", () => {
	it.effect("fails to decode a body that is not valid JSON", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(decodePlanetScaleWebhookPayload("not json {"))
			assert.strictEqual(failure._tag, "SchemaError")
		}),
	)

	it.effect("fails to decode a body missing the required event field", () =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				decodePlanetScaleWebhookPayload(JSON.stringify({ database: "main-db" })),
			)
			assert.strictEqual(failure._tag, "SchemaError")
		}),
	)
})
