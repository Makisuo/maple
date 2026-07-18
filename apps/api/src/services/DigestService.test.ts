import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { WarehouseQueryResponse } from "@maple/domain/http"
import { digestSubscriptions } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/lib/DatabaseLive"
import { EmailService } from "@/lib/EmailService"
import { Env } from "@/lib/Env"
import { WarehouseQueryService } from "@/lib/WarehouseQueryService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { DigestService } from "./DigestService"

const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3476",
			MCP_PORT: "3477",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

// Monday 2026-07-06 08:00 UTC — getUTCDay() === 1, matching the default
// subscription dayOfWeek. All seeded timestamps derive from this epoch so
// rows and the service (which reads Clock.currentTimeMillis) share one
// time base.
const TICK_MS = Date.UTC(2026, 6, 6, 8, 0, 0)

/** One current-period service row so hasDigestContent() passes. */
const overviewRow = {
	serviceName: "checkout-api",
	throughput: 100,
	errorCount: 2,
	p95LatencyMs: 50,
	period: "current",
}

const warehouseStub = Layer.succeed(WarehouseQueryService, {
	query: (_tenant, payload) =>
		Effect.succeed(
			new WarehouseQueryResponse({
				data: payload.pipeName === "service_overview_compare" ? [overviewRow] : [],
			}),
		),
	sqlQuery: () => Effect.die("sqlQuery not used by DigestService tests"),
	rawSqlQuery: () => Effect.die("rawSqlQuery not used by DigestService tests"),
	compiledQuery: () => Effect.die("compiledQuery not used by DigestService tests"),
	compiledQueryFirst: () => Effect.die("compiledQueryFirst not used by DigestService tests"),
	ingest: () => Effect.die("ingest not used by DigestService tests"),
	asExecutor: () => {
		throw new Error("asExecutor not used by DigestService tests")
	},
})

const makeHarness = () => {
	const sends: string[] = []
	const emailStub = Layer.succeed(EmailService, {
		isConfigured: true,
		send: (to) =>
			Effect.sync(() => {
				sends.push(to)
			}),
	})
	const testDb = createTestDb(createdDbs)
	const base = testDb.layer.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig()))
	const layer = DigestService.layer.pipe(
		Layer.provide(Layer.mergeAll(emailStub, warehouseStub)),
		Layer.provideMerge(base),
	)
	return { sends, layer }
}

const seedSub = (overrides: Partial<typeof digestSubscriptions.$inferInsert> & { email: string }) =>
	Effect.gen(function* () {
		const database = yield* Database
		const id = overrides.id ?? randomUUID()
		yield* database.execute((db) =>
			db.insert(digestSubscriptions).values({
				id,
				orgId: "org_digest_test",
				userId: `user-${id}`,
				enabled: true,
				dayOfWeek: 1,
				timezone: "UTC",
				createdAt: new Date(TICK_MS),
				updatedAt: new Date(TICK_MS),
				...overrides,
			}),
		)
		return id
	})

const getSub = (id: string) =>
	Effect.gen(function* () {
		const database = yield* Database
		const rows = yield* database.execute((db) =>
			db.select().from(digestSubscriptions).where(eq(digestSubscriptions.id, id)),
		)
		const row = rows[0]
		if (!row) {
			return yield* Effect.die(`subscription ${id} not found`)
		}
		return row
	})

describe("DigestService.runDigestTick", () => {
	it.effect("sends exactly one email per due subscription and records timestamps", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const aId = yield* seedSub({ email: "a@example.com" })
			const bId = yield* seedSub({ email: "b@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends.sort(), ["a@example.com", "b@example.com"])
			assert.strictEqual(result.sentCount, 2)
			assert.strictEqual(result.errorCount, 0)

			for (const id of [aId, bId]) {
				const row = yield* getSub(id)
				assert.strictEqual(row.lastSentAt?.getTime(), TICK_MS)
				assert.strictEqual(row.lastAttemptedAt?.getTime(), TICK_MS)
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not re-send to a sub already attempted today when another sub is claimed", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			// B was attempted earlier today but its lastSentAt never landed
			// (e.g. bookkeeping write failed after the email went out). It still
			// looks "due" by lastSentAt but must NOT be claimed again today.
			yield* seedSub({
				email: "b@example.com",
				lastAttemptedAt: new Date(TICK_MS - 15 * 60 * 1000),
			})
			// D is a fresh subscription (never attempted) — claimable.
			yield* seedSub({ email: "d@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, ["d@example.com"])
			assert.strictEqual(result.sentCount, 1)
			assert.strictEqual(result.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a second tick the same day sends nothing", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub({ email: "a@example.com" })

			const digest = yield* DigestService
			yield* digest.runDigestTick()
			assert.deepStrictEqual(sends, ["a@example.com"])

			yield* TestClock.setTime(TICK_MS + 15 * 60 * 1000)
			const second = yield* digest.runDigestTick()

			assert.deepStrictEqual(sends, ["a@example.com"])
			assert.strictEqual(second.sentCount, 0)
			assert.strictEqual(second.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})
})
