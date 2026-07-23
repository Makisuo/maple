import type { MessageBatch } from "@cloudflare/workers-types"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Database, DatabaseError } from "./lib/DatabaseLive"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "./lib/test-pglite"
import { processPlanetScaleWebhookBatch } from "./planetscale-webhook-runtime"
import type { PlanetScaleWebhookJob } from "./services/planetscale/PlanetScaleWebhookQueue"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const job: PlanetScaleWebhookJob = {
	kind: "planetscale-webhook",
	orgId: "org_1",
	connectionId: "connection_1",
	payload: {
		event: "branch.out_of_memory",
		organization: "acme",
		database: "shop",
		resource: { name: "main" },
	},
	receivedAt: 1_000,
}

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

	it.effect("reclassifies lifecycle events and acknowledges them without persistence", () => {
		const testDb = createTestDb(trackedDbs)
		const delivery = makeBatch({
			...job,
			payload: { ...job.payload, event: "branch.ready" },
		})
		return Effect.gen(function* () {
			yield* processPlanetScaleWebhookBatch(delivery.batch)
			assert.isTrue(delivery.acknowledged())
			assert.isFalse(delivery.retried())
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM error_issues WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.strictEqual(row?.count, 0)
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
