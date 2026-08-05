import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { runPlanetScaleEventRetention } from "./planetscale-event-retention"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

// `it.live` rather than `it.effect`: the latter installs a TestClock frozen at
// epoch 0, so a 90-day cutoff lands in 1969 and retention deletes nothing.
const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000

const insertEvent = (testDb: TestDb, id: string, orgId: string, occurredAt: Date) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO planetscale_events
			 (id, org_id, database_id, database_name, branch_name, category, event_type, state,
			  external_id, title, source, occurred_at, created_at)
			 VALUES ($1, $2, '', 'main-db', '', 'deploy_request', 'deploy_request.schema_applied',
			         'schema_applied', $1, 'Deploy request', 'webhook', $3, $3)`,
			[id, orgId, occurredAt.toISOString()],
		),
	)

const countEvents = (testDb: TestDb, orgId?: string) =>
	Effect.promise(() =>
		queryFirstRow<{ n: number }>(
			testDb,
			orgId === undefined
				? "SELECT count(*)::int AS n FROM planetscale_events"
				: "SELECT count(*)::int AS n FROM planetscale_events WHERE org_id = $1",
			orgId === undefined ? [] : [orgId],
		),
	)

describe("runPlanetScaleEventRetention", () => {
	it.live("drops events past the 90-day window and keeps the rest", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* insertEvent(testDb, "fresh", "org_1", new Date(NOW - 10 * DAY_MS))
			yield* insertEvent(testDb, "edge", "org_1", new Date(NOW - 89 * DAY_MS))
			yield* insertEvent(testDb, "stale", "org_1", new Date(NOW - 91 * DAY_MS))
			yield* insertEvent(testDb, "ancient", "org_2", new Date(NOW - 400 * DAY_MS))

			yield* runPlanetScaleEventRetention

			assert.strictEqual((yield* countEvents(testDb))?.n, 2)
			// Retention is org-agnostic on age — org_2's only row was ancient.
			assert.strictEqual((yield* countEvents(testDb, "org_2"))?.n, 0)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.live("is a no-op on an empty table", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* runPlanetScaleEventRetention
			assert.strictEqual((yield* countEvents(testDb))?.n, 0)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.live("leaves an org under the row cap untouched", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// Well under 20k: the cap probe must not fire, and nothing may be lost.
			for (let i = 0; i < 5; i++) {
				yield* insertEvent(testDb, `e${i}`, "org_1", new Date(NOW - i * 1000))
			}
			yield* runPlanetScaleEventRetention
			assert.strictEqual((yield* countEvents(testDb, "org_1"))?.n, 5)
		}).pipe(Effect.provide(testDb.layer))
	})
})
