import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, WarehouseQueryResponse } from "@maple/domain/http"
import type { WeeklyDigestProps } from "@maple/email/weekly-digest-core"
import { digestSubscriptions } from "@maple/db"
import { eq } from "drizzle-orm"
import { Database } from "@/platform/DatabaseLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { EdgeCacheService, makeEdgeCacheService, makeMemoryBackend } from "@maple/cache"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
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

interface StubOverviewRow {
	serviceName: string
	environment: string
	serviceNamespace: string
	throughput: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	p95LatencyMs: number
	period: "current" | "previous"
}

const overview = (over: Partial<StubOverviewRow> & { serviceName: string }): StubOverviewRow => ({
	environment: "production",
	serviceNamespace: "",
	throughput: over.estimatedSpanCount ?? 100,
	estimatedSpanCount: 100,
	errorCount: 2,
	estimatedErrorCount: 2,
	p95LatencyMs: 50,
	period: "current",
	...over,
})

/** One current-period service row so hasDigestContent() passes. */
const overviewRow = overview({ serviceName: "checkout-api" })

/** `custom_traces_breakdown` with `group_by_all` — one row for the window. */
const summaryRow = (count: number, errorRate: number, p95Duration: number) => ({
	name: "all",
	count,
	errorRate,
	p95Duration,
})

/** Pipe name → rows. Anything unlisted answers with no rows. */
type WarehouseFixture = Readonly<Record<string, ReadonlyArray<unknown>>>

const defaultFixture = {
	service_overview_compare: [overviewRow],
	custom_traces_breakdown: [summaryRow(100, 0.02, 50)],
} satisfies WarehouseFixture

const makeWarehouseStub = (
	fixture: WarehouseFixture = defaultFixture,
	seen?: Array<{ pipeName: string; params: Record<string, unknown> }>,
) =>
	Layer.succeed(WarehouseQueryService, {
		query: (_tenant, payload) =>
			Effect.sync(() => {
				seen?.push({
					pipeName: payload.pipeName,
					params: (payload.params ?? {}) as Record<string, unknown>,
				})
				return new WarehouseQueryResponse({ data: [...(fixture[payload.pipeName] ?? [])] })
			}),
		sqlQuery: () => Effect.die("sqlQuery not used by DigestService tests"),
		rawSqlQuery: () => Effect.die("rawSqlQuery not used by DigestService tests"),
		compiledQuery: () => Effect.die("compiledQuery not used by DigestService tests"),
		compiledQueryFirst: () => Effect.die("compiledQueryFirst not used by DigestService tests"),
		// The digest warms the route before its fan-out.
		warmRoute: () => Effect.void,
		ingest: () => Effect.die("ingest not used by DigestService tests"),
		asExecutor: () => {
			throw new Error("asExecutor not used by DigestService tests")
		},
	})

const makeHarness = (
	fixture: WarehouseFixture = defaultFixture,
	seen?: Array<{ pipeName: string; params: Record<string, unknown> }>,
) => {
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
		Layer.provide(
			Layer.mergeAll(
				emailStub,
				makeWarehouseStub(fixture, seen),
				Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend())),
			),
		),
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

const ORG_ID = OrgId.make("org_digest_test")

/**
 * The overview query groups by (serviceName, environment) and also carries a
 * namespace, so a service running in two environments arrives as two rows that
 * differ in nothing the old code looked at.
 */
const multiEnvFixture = {
	service_overview_compare: [
		overview({
			serviceName: "api",
			environment: "production",
			serviceNamespace: "edge",
			estimatedSpanCount: 1_000_000,
			estimatedErrorCount: 4_000,
			p95LatencyMs: 120,
			period: "current",
		}),
		overview({
			serviceName: "api",
			environment: "staging",
			serviceNamespace: "edge",
			estimatedSpanCount: 5_000,
			estimatedErrorCount: 500,
			p95LatencyMs: 900,
			period: "current",
		}),
		overview({
			serviceName: "api",
			environment: "production",
			serviceNamespace: "edge",
			estimatedSpanCount: 900_000,
			estimatedErrorCount: 3_000,
			period: "previous",
		}),
		overview({
			serviceName: "api",
			environment: "staging",
			serviceNamespace: "edge",
			estimatedSpanCount: 4_500,
			estimatedErrorCount: 400,
			period: "previous",
		}),
	],
	custom_traces_breakdown: [summaryRow(1_005_000, 0.004, 130)],
} satisfies WarehouseFixture

const findService = (props: WeeklyDigestProps, environment: string) => {
	const match = props.services.find((s) => s.environment === environment)
	assert.isDefined(match, `no service row for environment ${environment}`)
	return match
}

describe("DigestService.generateDigestData", () => {
	it.effect("compares each service against its own environment, not the last row seen", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// Keyed on the service name alone, production (1,000,000) would have
			// been compared against the staging previous row (4,500) — a +22,122%
			// chip on a service that actually grew 11%.
			const production = findService(props, "production")
			assert.deepStrictEqual(production.requestsDelta, {
				kind: "pct",
				value: ((1_000_000 - 900_000) / 900_000) * 100,
			})

			const staging = findService(props, "staging")
			assert.deepStrictEqual(staging.requestsDelta, {
				kind: "pct",
				value: ((5_000 - 4_500) / 4_500) * 100,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("carries environment and namespace onto every service row", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(
				props.services.map((s) => `${s.name}/${s.namespace}/${s.environment}`).sort(),
				["api/edge/production", "api/edge/staging"],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("groups services by environment with per-group subtotals", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(
				props.environmentGroups.map((g) => [g.environment, g.requests]),
				[
					["production", 1_000_000],
					["staging", 5_000],
				],
			)
			// Subtotals cover the rendered rows, so they add up to what a reader sees.
			for (const group of props.environmentGroups) {
				assert.strictEqual(
					group.requests,
					group.services.reduce((sum, s) => sum + s.requests, 0),
				)
			}
		}).pipe(Effect.provide(layer))
	})

	it.effect("breaks totals down by environment and by namespace", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(
				props.breakdown.environments.map((r) => [r.label, r.requests]),
				[
					["production", 1_000_000],
					["staging", 5_000],
				],
			)
			// Both environments share one namespace, so it collapses to a single row.
			assert.deepStrictEqual(
				props.breakdown.namespaces.map((r) => [r.label, r.requests]),
				[["edge", 1_005_000]],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reports a service with no previous week as new rather than +100%", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			service_overview_compare: [
				overview({ serviceName: "fresh", estimatedSpanCount: 50_000, period: "current" }),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(props.services[0]?.requestsDelta, { kind: "new" })
		}).pipe(Effect.provide(layer))
	})

	it.effect("suppresses a percentage computed off a negligible previous week", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			service_overview_compare: [
				overview({ serviceName: "spiky", estimatedSpanCount: 40_000, period: "current" }),
				overview({ serviceName: "spiky", estimatedSpanCount: 3, period: "previous" }),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// The honest answer is "+1,333,233%", which is not worth an email chip.
			assert.deepStrictEqual(props.services[0]?.requestsDelta, { kind: "none" })
		}).pipe(Effect.provide(layer))
	})

	it.effect("takes P95 from the merged-quantile summary, never a weighted mean", () => {
		const { layer } = makeHarness(multiEnvFixture)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// A throughput-weighted mean of the per-service P95s (120ms at 1M and
			// 900ms at 5k) lands near 124ms. The summary row says 130ms, and that
			// is the only one of the two that is actually a quantile.
			assert.strictEqual(props.summary.p95Latency.valueMs, 130)
		}).pipe(Effect.provide(layer))
	})

	it.effect("uses sample-weighted counts, so requests match the sparkline's source", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			custom_traces_timeseries: [
				{ bucket: "2026-06-29 00:00:00", count: 500_000, errorRate: 0.004 },
				{ bucket: "2026-06-30 00:00:00", count: 505_000, errorRate: 0.004 },
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// Both come from the same day-aligned window and the same weighted
			// count, so the bars add up to the headline number.
			assert.strictEqual(
				props.series.reduce((sum, point) => sum + point.requests, 0),
				props.summary.requests.value,
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("scopes every warehouse query when the subscription names a slice", () => {
		const seen: Array<{ pipeName: string; params: Record<string, unknown> }> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID, {
				environments: ["production"],
				namespaces: ["edge"],
			})

			const scoped = seen.filter((call) =>
				["service_overview_compare", "custom_traces_breakdown", "custom_traces_timeseries"].includes(
					call.pipeName,
				),
			)
			assert.isAbove(scoped.length, 0)
			for (const call of scoped) {
				assert.strictEqual(call.params.environments, "production")
				assert.strictEqual(call.params.namespaces, "edge")
			}

			// `errors_by_type` has a deployment_envs param but no namespace one.
			const errors = seen.find((call) => call.pipeName === "errors_by_type")
			assert.strictEqual(errors?.params.deployment_envs, "production")

			// `service_usage` has neither column, so the scope is approximated by
			// service membership and the email says so.
			const usage = seen.find((call) => call.pipeName === "get_service_usage_compare")
			assert.strictEqual(usage?.params.services, "api")
			assert.isTrue(props.ingestion.approximate)
			assert.deepStrictEqual(props.scope, { environments: ["production"], namespaces: ["edge"] })
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves an unscoped digest unfiltered and exact", () => {
		const seen: Array<{ pipeName: string; params: Record<string, unknown> }> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			for (const call of seen) {
				assert.isUndefined(call.params.environments)
				assert.isUndefined(call.params.namespaces)
				assert.isUndefined(call.params.services)
			}
			assert.isFalse(props.ingestion.approximate)
		}).pipe(Effect.provide(layer))
	})
})
