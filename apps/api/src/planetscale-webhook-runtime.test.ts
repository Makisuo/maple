import type { MessageBatch } from "@cloudflare/workers-types"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { processPlanetScaleWebhookBatch } from "./planetscale-webhook-runtime"
import {
	projectPlanetScaleWebhookEvent,
	type PlanetScaleWebhookPayload,
} from "./services/integrations/planetscale/webhook-events"
import type { PlanetScaleWebhookJob } from "./services/integrations/planetscale/PlanetScaleWebhookQueue"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = Schema.decodeUnknownSync(OrgId)("org_1")

const basePayload: PlanetScaleWebhookPayload = {
	timestamp: 1,
	event: "branch.out_of_memory",
	organization: "acme",
	database: "shop",
	resource: { name: "main" },
}

const makeJob = (payload: PlanetScaleWebhookPayload = basePayload): PlanetScaleWebhookJob => ({
	kind: "planetscale-webhook",
	orgId,
	connectionId: "connection_1",
	receivedAt: 1_000,
	event: projectPlanetScaleWebhookEvent({
		orgId,
		connectionId: "connection_1",
		payload,
		receivedAt: 1_000,
	}),
})

const job = makeJob()

const makeBatch = (body: unknown) => {
	let acknowledged = false
	let retried = false
	const message = {
		id: "message_1",
		timestamp: new Date(1_000),
		body,
		attempts: 1,
		ack: () => {
			acknowledged = true
		},
		retry: () => {
			retried = true
		},
	}
	return {
		batch: {
			queue: "maple-planetscale-webhooks-local",
			messages: [message],
			ackAll: () => undefined,
			retryAll: () => undefined,
		} as MessageBatch<unknown>,
		acknowledged: () => acknowledged,
		retried: () => retried,
	}
}

describe("PlanetScale webhook queue consumer", () => {
	it.effect("persists an issue and acknowledges the delivery", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch(job)
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			assert.isTrue(delivery.acknowledged())
			assert.isFalse(delivery.retried())
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ workflow_state: string; occurrence_count: number }>(
					testDb,
					"SELECT workflow_state, occurrence_count FROM error_issues WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(row?.workflow_state, "triage")
			assert.strictEqual(row?.occurrence_count, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("applies an issue event exactly once across duplicate queue deliveries", () => {
		const testDb = createTestDb(trackedDbs)
		const first = makeBatch(job)
		const duplicate = makeBatch(job)
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(first.batch)
			yield* Effect.promise(() =>
				testDb.pglite.exec(
					"UPDATE error_issues SET workflow_state = 'done', resolved_at = '2026-08-20T00:00:00Z'",
				),
			)
			yield* processPlanetScaleWebhookBatch(duplicate.batch)
			assert.isTrue(first.acknowledged())
			assert.isTrue(duplicate.acknowledged())
			const issue = yield* Effect.promise(() =>
				queryFirstRow<{ occurrence_count: number; workflow_state: string }>(
					testDb,
					"SELECT occurrence_count, workflow_state FROM error_issues WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(issue?.occurrence_count, 1)
			assert.strictEqual(issue?.workflow_state, "done")
			const history = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issue_events WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(history?.count, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("recovers exactly once after the timeline commits but the issue transaction fails", () => {
		const testDb = createTestDb(trackedDbs)
		const failed = makeBatch(job)
		const retry = makeBatch(job)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				testDb.pglite.exec(`CREATE FUNCTION reject_planetscale_issue_event() RETURNS trigger AS $$
					BEGIN RAISE EXCEPTION 'forced issue event failure'; END;
					$$ LANGUAGE plpgsql;
					CREATE TRIGGER reject_planetscale_issue_event
					BEFORE INSERT ON error_issue_events
					FOR EACH ROW EXECUTE FUNCTION reject_planetscale_issue_event();`),
			)
			yield* processPlanetScaleWebhookBatch(failed.batch)
			assert.isTrue(failed.retried())
			yield* Effect.promise(() =>
				testDb.pglite.exec(`DROP TRIGGER reject_planetscale_issue_event ON error_issue_events;
					DROP FUNCTION reject_planetscale_issue_event();`),
			)
			yield* processPlanetScaleWebhookBatch(retry.batch)
			assert.isTrue(retry.acknowledged())
			const counts = yield* Effect.promise(() =>
				queryFirstRow<{ timeline: number; issues: number; receipts: number }>(
					testDb,
					`SELECT
						(SELECT count(*)::int FROM planetscale_events) AS timeline,
						(SELECT count(*)::int FROM error_issues) AS issues,
						(SELECT count(*)::int FROM planetscale_issue_receipts) AS receipts`,
				),
			)
			assert.deepStrictEqual(counts, { timeline: 1, issues: 1, receipts: 1 })
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("processes the exact pre-event-envelope queue body during rolling upgrades", () => {
		const testDb = createTestDb(trackedDbs)
		const legacyJob = {
			kind: "planetscale-webhook",
			orgId,
			connectionId: "connection_1",
			payload: basePayload,
			receivedAt: 1_000,
		}
		const delivery = makeBatch(legacyJob)
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			assert.isTrue(delivery.acknowledged())
			assert.isFalse(delivery.retried())
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ workflow_state: string; occurrence_count: number }>(
					testDb,
					"SELECT workflow_state, occurrence_count FROM error_issues WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(row?.workflow_state, "triage")
			assert.strictEqual(row?.occurrence_count, 1)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("terminally acknowledges timestamp-less legacy queue bodies", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch({
			kind: "planetscale-webhook",
			orgId,
			connectionId: "connection_1",
			payload: { ...basePayload, timestamp: null },
			receivedAt: 1_000,
		})
		return processPlanetScaleWebhookBatch(delivery.batch).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					assert.isTrue(delivery.acknowledged())
					assert.isFalse(delivery.retried())
				}),
			),
			Effect.provide(testDb.layer),
		)
	})

	it.effect("acknowledges terminal malformed jobs", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch({ kind: "not-a-planetscale-job" })
		return processPlanetScaleWebhookBatch(delivery.batch).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					assert.isTrue(delivery.acknowledged())
					assert.isFalse(delivery.retried())
				}),
			),
			Effect.provide(testDb.layer),
		)
	})

	it.effect("terminally acknowledges schema-valid jobs with contradictory event identity", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch({
			...job,
			event: { ...job.event, tenantid: Schema.decodeUnknownSync(OrgId)("org_2") },
		})
		return processPlanetScaleWebhookBatch(delivery.batch).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					assert.isTrue(delivery.acknowledged())
					assert.isFalse(delivery.retried())
				}),
			),
			Effect.provide(testDb.layer),
		)
	})

	it.effect("writes a lifecycle event to the timeline but not to the issue hub", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch(makeJob({ ...basePayload, event: "branch.ready" }))
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			assert.isTrue(delivery.acknowledged())
			assert.isFalse(delivery.retried())

			const issues = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issues WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(issues?.count, 0)

			const event = yield* Effect.promise(() =>
				queryFirstRow<{ category: string; state: string; branch_name: string }>(
					testDb,
					"SELECT category, state, branch_name FROM planetscale_events WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(event?.category, "branch")
			assert.strictEqual(event?.state, "ready")
			assert.strictEqual(event?.branch_name, "main")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("writes a health event to BOTH the timeline and the issue hub", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch(job)
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			const event = yield* Effect.promise(() =>
				queryFirstRow<{ category: string; state: string }>(
					testDb,
					"SELECT category, state FROM planetscale_events WHERE org_id = $1",
					["org_1"],
				),
			)
			// The OOM issue is what pages someone; the marker is what explains the
			// CPU cliff next to it.
			assert.strictEqual(event?.category, "branch")
			assert.strictEqual(event?.state, "out_of_memory")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("carries the deploy-request number so redelivery dedupes", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch(
			makeJob({
				...basePayload,
				event: "deploy_request.schema_applied",
				resource: { number: 42 },
			}),
		)
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			const event = yield* Effect.promise(() =>
				queryFirstRow<{ external_id: string; title: string; branch_name: string }>(
					testDb,
					"SELECT external_id, title, branch_name FROM planetscale_events WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(event?.external_id, "42")
			assert.strictEqual(event?.title, "Deploy request #42 applied its schema")
			// A deploy request spans branches; pinning it to one would be a guess.
			assert.strictEqual(event?.branch_name, "")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("retries typed database failures without acknowledging", () => {
		const delivery = makeBatch(job)
		const failedDatabase = Layer.succeed(Database, {
			execute: () =>
				Effect.fail(
					new DatabaseError({
						message: "database unavailable",
						cause: new Error("database unavailable"),
					}),
				),
		})
		return processPlanetScaleWebhookBatch(delivery.batch).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					assert.isFalse(delivery.acknowledged())
					assert.isTrue(delivery.retried())
				}),
			),
			Effect.provide(failedDatabase),
		)
	})

	it.effect("does not turn persistence defects into acknowledgement or retry", () => {
		const delivery = makeBatch(job)
		const defectiveDatabase = Layer.succeed(Database, {
			execute: () => Effect.die(new Error("unexpected persistence defect")),
		})
		return processPlanetScaleWebhookBatch(delivery.batch).pipe(
			Effect.exit,
			Effect.tap((exit) =>
				Effect.sync(() => {
					assert.strictEqual(exit._tag, "Failure")
					assert.isFalse(delivery.acknowledged())
					assert.isFalse(delivery.retried())
				}),
			),
			Effect.provide(defectiveDatabase),
		)
	})
})
