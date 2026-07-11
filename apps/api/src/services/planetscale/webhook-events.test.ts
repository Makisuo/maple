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
})
