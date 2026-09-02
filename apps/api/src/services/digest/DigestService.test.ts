import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId, WarehouseQueryError, WarehouseQueryResponse } from "@maple/domain/http"
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

/**
 * Fixture key → rows. Anything unlisted answers with no rows.
 *
 * `custom_traces_breakdown` is issued at two different grains, so its key
 * carries the grouping: `custom_traces_breakdown:all` for the summary row and
 * `custom_traces_breakdown:namespace` for the namespace table.
 */
type WarehouseFixture = Readonly<Record<string, ReadonlyArray<unknown>>>

const fixtureKey = (pipeName: string, params: Record<string, unknown>): string => {
	// The previous-window error lookup is the fingerprint-filtered one.
	if (pipeName === "errors_by_type") {
		return params.fingerprint_hashes != null ? "errors_by_type:previous" : "errors_by_type"
	}
	if (pipeName !== "custom_traces_breakdown") return pipeName
	if (params.group_by_namespace != null) return "custom_traces_breakdown:namespace"
	return "custom_traces_breakdown:all"
}

const defaultFixture = {
	service_overview_compare: [overviewRow],
	"custom_traces_breakdown:all": [summaryRow(100, 0.02, 50)],
} satisfies WarehouseFixture

const makeWarehouseStub = (
	fixture: WarehouseFixture = defaultFixture,
	seen?: Array<{ pipeName: string; params: Record<string, unknown> }>,
	/** Fixture keys whose query should fail, simulating a warehouse blip. */
	failing: ReadonlySet<string> = new Set(),
) =>
	Layer.succeed(WarehouseQueryService, {
		query: (_tenant, payload) =>
			Effect.suspend(() => {
				const params = (payload.params ?? {}) as Record<string, unknown>
				const key = fixtureKey(payload.pipeName, params)
				seen?.push({ pipeName: payload.pipeName, params })
				if (failing.has(key)) {
					return Effect.fail(
						new WarehouseQueryError({
							message: `stubbed failure for ${key}`,
							pipeName: payload.pipeName,
						}),
					)
				}
				return Effect.succeed(new WarehouseQueryResponse({ data: [...(fixture[key] ?? [])] }))
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
	failing?: ReadonlySet<string>,
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
				makeWarehouseStub(fixture, seen, failing),
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
	"custom_traces_breakdown:all": [summaryRow(1_005_000, 0.004, 130)],
	// True namespace grain — a service's traffic can be split across namespaces,
	// which is exactly what summing the overview rows could not express.
	"custom_traces_breakdown:namespace": [
		{ name: "edge", count: 700_000, errorRate: 0.003, p95Duration: 110 },
		{ name: "checkout", count: 305_000, errorRate: 0.006, p95Duration: 210 },
	],
	"custom_traces_breakdown:namespace:previous": [],
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
			// With fewer services than the render cap the header total and the
			// visible rows coincide; the >10 case is covered separately.
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

			// Environment IS a grouping key on the overview query, so summing its
			// rows is exact.
			assert.deepStrictEqual(
				props.breakdown.environments.map((r) => [r.label, r.requests]),
				[
					["production", 1_000_000],
					["staging", 5_000],
				],
			)
			// Namespace is NOT: the overview reports only a dominant `argMax`
			// namespace ("edge" on every row here), so summing those rows would file
			// all 1,005,000 requests under "edge". The namespace-grouped query shows
			// the traffic is really split with "checkout".
			assert.deepStrictEqual(
				props.breakdown.namespaces.map((r) => [r.label, r.requests]),
				[
					["edge", 700_000],
					["checkout", 305_000],
				],
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

describe("DigestService.generateDigestData — comparison identity", () => {
	it.effect("still matches a service whose dominant namespace changed week to week", () => {
		// `serviceOverviewQuery` reports `argMax(cServiceNamespace, …)` — the
		// busiest namespace, display metadata rather than row identity. Keying the
		// comparison on it made a service whose busiest namespace shifted look new.
		const { layer } = makeHarness({
			...multiEnvFixture,
			service_overview_compare: [
				overview({
					serviceName: "api",
					serviceNamespace: "checkout",
					estimatedSpanCount: 1_000_000,
					period: "current",
				}),
				overview({
					serviceName: "api",
					serviceNamespace: "edge",
					estimatedSpanCount: 900_000,
					period: "previous",
				}),
			],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.deepStrictEqual(props.services[0]?.requestsDelta, {
				kind: "pct",
				value: ((1_000_000 - 900_000) / 900_000) * 100,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("compares whole environments, not the rendered top ten against everything", () => {
		// Twelve services in one environment: only ten are rendered, but the header
		// total and its delta must cover the environment, or a flat week reports a
		// decline purely because two rows did not fit.
		const many = (period: "current" | "previous") =>
			Array.from({ length: 12 }, (_, index) =>
				overview({
					serviceName: `svc-${index}`,
					estimatedSpanCount: 10_000,
					period,
				}),
			)
		const { layer } = makeHarness({
			...multiEnvFixture,
			service_overview_compare: [...many("current"), ...many("previous")],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			const group = props.environmentGroups[0]
			assert.strictEqual(group?.services.length, 10, "renders the top ten")
			assert.strictEqual(group?.requests, 120_000, "but totals all twelve")
			assert.deepStrictEqual(group?.requestsDelta, { kind: "pct", value: 0 })
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.generateDigestData — scope containment", () => {
	it.effect("scopes errors by service membership, not just by environment", () => {
		// `error_events` has no namespace column, so a namespace-only scope would
		// otherwise pull top errors from the whole org into a scoped digest.
		const seen: Array<{ pipeName: string; params: Record<string, unknown> }> = []
		const { layer } = makeHarness(multiEnvFixture, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			yield* digest.generateDigestData(ORG_ID, { environments: [], namespaces: ["edge"] })

			const errors = seen.find((call) => call.pipeName === "errors_by_type")
			assert.strictEqual(errors?.params.services, "api")
			assert.isUndefined(errors?.params.deployment_envs, "no environment in this scope")
		}).pipe(Effect.provide(layer))
	})

	it.effect("treats a scope that matches nothing as empty, not as unfiltered", () => {
		const seen: Array<{ pipeName: string; params: Record<string, unknown> }> = []
		const { layer } = makeHarness({ ...multiEnvFixture, service_overview_compare: [] }, seen)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID, {
				environments: [],
				namespaces: ["nonexistent"],
			})

			// Dropping the filter here would have shown org-wide ingestion and
			// org-wide errors inside a digest claiming to cover one namespace.
			assert.isUndefined(seen.find((call) => call.pipeName === "get_service_usage_compare"))
			assert.isUndefined(seen.find((call) => call.pipeName === "errors_by_type"))
			assert.strictEqual(props.ingestion.totalBytes, 0)
			assert.deepStrictEqual(props.topErrors, [])
		}).pipe(Effect.provide(layer))
	})

	const errorRow = {
		fingerprintHash: "111",
		errorLabel: "Boom",
		sampleMessage: "Boom",
		count: 10,
		affectedServicesCount: 1,
		firstSeen: "2026-07-01 00:00:00",
		lastSeen: "2026-07-05 00:00:00",
	}

	it.effect("badges an error new only when the previous window genuinely lacks it", () => {
		const { layer } = makeHarness({
			...multiEnvFixture,
			errors_by_type: [errorRow],
			"errors_by_type:previous": [],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			assert.strictEqual(props.topErrors[0]?.isNew, true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not badge every error new when the previous-window lookup fails", () => {
		const { layer } = makeHarness(
			{ ...multiEnvFixture, errors_by_type: [errorRow], "errors_by_type:previous": [] },
			undefined,
			new Set(["errors_by_type:previous"]),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const props = yield* digest.generateDigestData(ORG_ID)

			// A warehouse blip must not invent first-seen badges. Losing the badge is
			// the safe direction; the digest itself still sends.
			assert.strictEqual(props.topErrors[0]?.isNew, false)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService.runDigestTick — stored scope handling", () => {
	it.effect("a malformed scope column widens that digest instead of aborting the tick", () => {
		const { sends, layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			yield* seedSub({ email: "broken@example.com", namespacesJson: "{not json" })
			yield* seedSub({ email: "fine@example.com" })

			const digest = yield* DigestService
			const result = yield* digest.runDigestTick()

			// A throw while partitioning subscriptions would have taken the healthy
			// subscriber down with the bad row.
			assert.deepStrictEqual(sends.sort(), ["broken@example.com", "fine@example.com"])
			assert.strictEqual(result.errorCount, 0)
		}).pipe(Effect.provide(layer))
	})
})

describe("DigestService — subscriber opt-out", () => {
	it.effect("the Clerk sweep re-enables a returning member but not one who opted out", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const database = yield* Database

			const optedOut = yield* seedSub({ email: "opted-out@example.com" })
			const departed = yield* seedSub({ email: "departed@example.com" })
			const optedOutUser = UserId.make(`user-${optedOut}`)
			const departedUser = UserId.make(`user-${departed}`)

			yield* digest.upsertSubscription(ORG_ID, optedOutUser, {
				email: "opted-out@example.com",
				enabled: false,
			})
			// What the sweep itself does to a member it no longer sees in the org.
			yield* database.execute((db) =>
				db
					.update(digestSubscriptions)
					.set({ enabled: false })
					.where(eq(digestSubscriptions.id, departed)),
			)

			yield* digest.reconcileSubscriptions([
				{ orgId: ORG_ID, userId: optedOutUser, email: "opted-out@example.com" },
				{ orgId: ORG_ID, userId: departedUser, email: "departed@example.com" },
			])

			assert.strictEqual((yield* getSub(optedOut)).enabled, false)
			assert.strictEqual((yield* getSub(departed)).enabled, true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("deleting a subscription records the opt-out instead of erasing it", () => {
		const { layer } = makeHarness()
		return Effect.gen(function* () {
			yield* TestClock.setTime(TICK_MS)
			const digest = yield* DigestService
			const id = yield* seedSub({ email: "gone@example.com" })
			const userId = UserId.make(`user-${id}`)

			yield* digest.deleteSubscription(ORG_ID, userId)
			yield* digest.reconcileSubscriptions([{ orgId: ORG_ID, userId, email: "gone@example.com" }])

			// A hard delete here would be undone by the very next sweep.
			const row = yield* getSub(id)
			assert.strictEqual(row.enabled, false)
			assert.notStrictEqual(row.optedOutAt, null)
		}).pipe(Effect.provide(layer))
	})
})
