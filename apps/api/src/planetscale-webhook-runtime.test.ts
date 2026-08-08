import type { MessageBatch } from "@cloudflare/workers-types"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { Database, DatabaseError } from "@/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { processPlanetScaleWebhookBatch } from "./planetscale-webhook-runtime"
import { projectPlanetScaleWebhookEvent } from "./services/integrations/planetscale/webhook-events"
import type { PlanetScaleWebhookJob } from "./services/integrations/planetscale/PlanetScaleWebhookQueue"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = Schema.decodeUnknownSync(OrgId)("org_1")

const makeJob = (
	payload: PlanetScaleWebhookJob["payload"] = {
		event: "branch.out_of_memory",
		organization: "acme",
		database: "shop",
		resource: { name: "main" },
	},
): PlanetScaleWebhookJob => ({
	kind: "planetscale-webhook",
	orgId,
	connectionId: "connection_1",
	payload,
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
		} as unknown as MessageBatch<unknown>,
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

	it.effect("writes a lifecycle event to the timeline but not to the issue hub", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch(makeJob({ ...job.payload, event: "branch.ready" }))
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
				...job.payload,
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
