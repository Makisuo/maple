import { createHmac } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import {
	PlanetScaleWebhookPayload,
	classifyPlanetScaleEvent,
	decodePlanetScaleWebhookPayload,
	deployRequestNumber,
	insertPlanetScaleEvent,
	planetScaleIssueFingerprint,
	truncateToSecond,
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
	it("maps health events to issues and lifecycle events to timeline rows", () => {
		assert.strictEqual(classifyPlanetScaleEvent("branch.out_of_memory").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("branch.anomaly").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("cluster.storage").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("keyspace.storage").action, "issue")
		assert.strictEqual(classifyPlanetScaleEvent("deploy_request.opened").action, "timeline")
		assert.strictEqual(classifyPlanetScaleEvent("deploy_request.schema_applied").action, "timeline")
		assert.strictEqual(classifyPlanetScaleEvent("branch.ready").action, "timeline")
		assert.strictEqual(classifyPlanetScaleEvent("database.access_request").action, "timeline")
		assert.strictEqual(classifyPlanetScaleEvent("webhook.test").action, "test")
		// Forward-compatible: unknown events are acknowledged, never rejected.
		assert.strictEqual(classifyPlanetScaleEvent("branch.some_future_event").action, "log")
	})

	it("gives health events a timeline spec too — they belong on the chart as well as in triage", () => {
		const oom = classifyPlanetScaleEvent("branch.out_of_memory")
		assert.strictEqual(oom.action, "issue")
		if (oom.action !== "issue") return
		assert.strictEqual(oom.timeline.category, "branch")
		assert.strictEqual(oom.timeline.state, "out_of_memory")
	})

	it("derives the lifecycle state from the event name", () => {
		const applied = classifyPlanetScaleEvent("deploy_request.schema_applied")
		assert.strictEqual(applied.action, "timeline")
		if (applied.action !== "timeline") return
		assert.strictEqual(applied.timeline.category, "deploy_request")
		assert.strictEqual(applied.timeline.state, "schema_applied")
	})
})

describe("deployRequestNumber", () => {
	const payload = (resource: Record<string, unknown> | null) =>
		Schema.decodeUnknownSync(PlanetScaleWebhookPayload)({
			event: "deploy_request.opened",
			database: "main-db",
			resource,
		})

	it("prefers the deploy-request number the PlanetScale UI shows", () => {
		assert.strictEqual(deployRequestNumber(payload({ number: 42, id: "dr_x" })), "42")
		assert.strictEqual(deployRequestNumber(payload({ number: "42" })), "42")
	})

	it("falls back to the id, then to empty", () => {
		assert.strictEqual(deployRequestNumber(payload({ id: "dr_x" })), "dr_x")
		assert.strictEqual(deployRequestNumber(payload({})), "")
		assert.strictEqual(deployRequestNumber(payload(null)), "")
	})
})

describe("truncateToSecond", () => {
	it("collapses the webhook's second precision and the backfill's millisecond precision", () => {
		// Same transition, two sources — must produce one dedupe key.
		assert.strictEqual(truncateToSecond(1_698_252_879_000).getTime(), 1_698_252_879_000)
		assert.strictEqual(truncateToSecond(1_698_252_879_412).getTime(), 1_698_252_879_000)
	})
})

describe("insertPlanetScaleEvent", () => {
	const input = (over: Record<string, unknown> = {}) => ({
		orgId: asOrgId("org_events"),
		databaseName: "main-db",
		branchName: "",
		category: "deploy_request" as const,
		eventType: "deploy_request.schema_applied",
		state: "schema_applied",
		externalId: "42",
		title: "Deploy request #42 applied its schema",
		source: "webhook" as const,
		occurredAtMs: 1_698_252_879_000,
		createdAtMs: 1_698_252_880_000,
		...over,
	})

	const countRows = (testDb: TestDb) =>
		Effect.promise(() =>
			queryFirstRow<{ n: number }>(testDb, "SELECT count(*)::int AS n FROM planetscale_events"),
		)

	it.effect("inserts once, and queue redelivery of the same transition is a no-op", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const first = yield* insertPlanetScaleEvent(input())
			assert.isTrue(first.inserted)

			const second = yield* insertPlanetScaleEvent(input())
			assert.isFalse(second.inserted)

			assert.strictEqual((yield* countRows(testDb))?.n, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("collapses a webhook row and a backfill row of the same transition", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertPlanetScaleEvent(input())
			// The REST backfill carries millisecond precision for the same second;
			// without truncation this would insert a duplicate marker.
			const backfilled = yield* insertPlanetScaleEvent(
				input({ source: "backfill", occurredAtMs: 1_698_252_879_631 }),
			)
			assert.isFalse(backfilled.inserted)
			assert.strictEqual((yield* countRows(testDb))?.n, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("keeps distinct transitions of the same deploy request apart", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertPlanetScaleEvent(input())
			yield* insertPlanetScaleEvent(input({ eventType: "deploy_request.closed", state: "closed" }))
			assert.strictEqual((yield* countRows(testDb))?.n, 2)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("resolves the database id from the inventory, and tolerates its absence", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// Unknown to the inventory: the read path keys on the name anyway.
			yield* insertPlanetScaleEvent(input())
			const unresolved = yield* Effect.promise(() =>
				queryFirstRow<{ database_id: string }>(
					testDb,
					"SELECT database_id FROM planetscale_events LIMIT 1",
				),
			)
			assert.strictEqual(unresolved?.database_id, "")

			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO planetscale_databases
					 (id, org_id, database_id, name, kind, created_at, updated_at)
					 VALUES ('row1', 'org_events', 'db_abc', 'main-db', 'mysql', now(), now())`,
				),
			)
			yield* insertPlanetScaleEvent(input({ eventType: "deploy_request.closed", state: "closed" }))
			const resolved = yield* Effect.promise(() =>
				queryFirstRow<{ database_id: string }>(
					testDb,
					"SELECT database_id FROM planetscale_events WHERE event_type = 'deploy_request.closed'",
				),
			)
			assert.strictEqual(resolved?.database_id, "db_abc")
		}).pipe(Effect.provide(testDb.layer))
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

	it.effect("rolls back issue creation when its audit event fails, then retries cleanly", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const payload = yield* decodePlanetScaleWebhookPayload(OOM_PAYLOAD)
			const input = {
				orgId: asOrgId("org_1"),
				payload,
				severity: "high" as const,
				title: "PlanetScale branch out of memory",
				description: "Branch main of main-db was restarted after running out of memory.",
				timestamp: 1_000,
			}
			yield* Effect.promise(() =>
				testDb.pglite.exec(`CREATE FUNCTION reject_planetscale_issue_event() RETURNS trigger AS $$
						BEGIN RAISE EXCEPTION 'forced event failure'; END;
						$$ LANGUAGE plpgsql;
						CREATE TRIGGER reject_planetscale_issue_event
						BEFORE INSERT ON error_issue_events
						FOR EACH ROW EXECUTE FUNCTION reject_planetscale_issue_event();`),
			)

			const error = yield* upsertPlanetScaleIssue(input).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/api/lib/DatabaseError")
			const afterFailure = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issues WHERE org_id = $1",
					[input.orgId],
				),
			)
			assert.strictEqual(afterFailure?.count, 0)

			yield* Effect.promise(() =>
				testDb.pglite.exec(`DROP TRIGGER reject_planetscale_issue_event ON error_issue_events;
						DROP FUNCTION reject_planetscale_issue_event();`),
			)
			const retry = yield* upsertPlanetScaleIssue(input)
			assert.strictEqual(retry.action, "created")
			const event = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issue_events WHERE issue_id = $1 AND type = 'created'",
					[retry.issueId],
				),
			)
			assert.strictEqual(event?.count, 1)
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
