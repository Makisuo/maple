import { randomUUID } from "node:crypto"
import { Retry } from "@distilled.cloud/cloudflare"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { clickHouseSchemaVersion } from "@maple/domain/clickhouse"
import { cloudflareAnalyticsState, oauthConnections, orgClickHouseSettings } from "@maple/db"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { WarehouseQueryService, type WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { CloudflareAnalyticsService, hasAnalyticsScopes } from "./CloudflareAnalyticsService"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import { OrgClickHouseSettingsService } from "./OrgClickHouseSettingsService"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import type { MetricGaugeRow, MetricSumRow } from "./cloudflare-analytics/mapping"
import type { OtlpMetricsPayload } from "./cloudflare-analytics/otlp"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_cf")
const ACCOUNT_ID = "acct-1"
const ZONE_ID = "zone-1"
const ZONE_NAME = "example.com"

/** Fixed test wall-clock: 2026-07-02T12:00:00Z. */
const T0 = Date.parse("2026-07-02T12:00:00Z")
const MIN = 60_000

const ANALYTICS_SCOPE =
	"account-settings.read account-analytics.read analytics.read zone.read workers-scripts.read"

const ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString("base64")

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
	CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id",
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const BUCKET = "2026-07-02T11:35:00Z"

const zoneFixture = {
	id: ZONE_ID,
	name: ZONE_NAME,
	status: "active",
	account: { id: ACCOUNT_ID, name: "Test Account" },
	activated_on: "2025-01-01T00:00:00Z",
	created_on: "2025-01-01T00:00:00Z",
	development_mode: 0,
	meta: {},
	modified_on: "2025-01-01T00:00:00Z",
	name_servers: ["ns1.example.com"],
	original_dnshost: null,
	original_name_servers: null,
	original_registrar: null,
	owner: { id: null, name: null, type: null },
	plan: { id: "free", name: "Free" },
	paused: false,
	type: "full",
}

const settingsData = {
	viewer: {
		zones: [
			{
				zoneTag: ZONE_ID,
				settings: {
					httpRequestsAdaptiveGroups: {
						enabled: true,
						// 2h retention keeps the first-poll backfill to a couple of windows.
						notOlderThan: 7200,
						maxDuration: 3600,
						availableFields: ["edgeTimeToFirstByteMsP50", "count"],
					},
				},
			},
		],
		accounts: [
			{
				settings: {
					workersInvocationsAdaptive: {
						enabled: true,
						notOlderThan: 7200,
						maxDuration: 3600,
						availableFields: ["cpuTimeP50", "requests"],
					},
				},
			},
		],
	},
}

const httpData = {
	viewer: {
		zones: [
			{
				zoneTag: ZONE_ID,
				groups: [
					{
						count: 10,
						avg: { sampleInterval: 10 },
						sum: { edgeResponseBytes: 5000, visits: 8 },
						dimensions: {
							datetimeFiveMinutes: BUCKET,
							cacheStatus: "hit",
							edgeResponseStatus: 200,
						},
					},
				],
				latency: [
					{
						count: 10,
						quantiles: {
							edgeTimeToFirstByteMsP50: 42,
							edgeTimeToFirstByteMsP95: 180,
							edgeTimeToFirstByteMsP99: 400,
							originResponseDurationMsP50: 12,
							originResponseDurationMsP95: 90,
							originResponseDurationMsP99: 300,
						},
						dimensions: { datetimeFiveMinutes: BUCKET },
					},
				],
			},
		],
	},
}

const workersData = {
	viewer: {
		accounts: [
			{
				invocations: [
					{
						sum: { requests: 42, errors: 2, subrequests: 5 },
						quantiles: {
							cpuTimeP50: 1500,
							cpuTimeP99: 9000,
							durationP50: 0.002,
							durationP99: 0.05,
						},
						dimensions: {
							datetimeFiveMinutes: BUCKET,
							scriptName: "my-worker",
							status: "success",
						},
					},
				],
			},
		],
	},
}

interface OtlpCall {
	readonly authorization: string
	readonly payload: OtlpMetricsPayload
}

interface FetchOptions {
	readonly zones?: ReadonlyArray<typeof zoneFixture>
	readonly zonesStatus?: number
	readonly graphqlErrors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }>
	/** Live Worker scripts the REST enumeration returns (default: my-worker). */
	readonly workerScripts?: ReadonlyArray<{ id: string }>
	/** When set, OTLP metrics POSTs to the ingest gateway (`/v1/metrics`) are captured here. */
	readonly otlpCalls?: Array<OtlpCall>
	/** HTTP status the mock gateway returns for `/v1/metrics` (default 200). */
	readonly metricsStatus?: number
}

/** Read the outbound request body regardless of how the HttpClient encodes it (string/bytes/stream). */
const readRequestBody = async (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: RequestInit,
): Promise<string> => {
	if (init?.body != null) {
		if (typeof init.body === "string") return init.body
		return await new Response(init.body as BodyInit).text()
	}
	return input instanceof Request ? await input.text() : "{}"
}

/** Read an outbound request header regardless of whether it's on the Request or the init. */
const readHeader = (
	input: Parameters<typeof globalThis.fetch>[0],
	init: RequestInit | undefined,
	name: string,
): string => {
	if (init?.headers) {
		const value = new Headers(init.headers as HeadersInit).get(name)
		if (value != null) return value
	}
	if (input instanceof Request) {
		const value = input.headers.get(name)
		if (value != null) return value
	}
	return ""
}

const mockCloudflareFetch =
	(options: FetchOptions = {}): typeof globalThis.fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.includes("/v1/metrics")) {
			options.otlpCalls?.push({
				authorization: readHeader(input, init, "authorization"),
				payload: JSON.parse(await readRequestBody(input, init)) as OtlpMetricsPayload,
			})
			return jsonResponse({}, options.metricsStatus ?? 200)
		}
		if (url.includes("/graphql")) {
			const body = JSON.parse(await readRequestBody(input, init)) as { query: string }
			if (options.graphqlErrors) {
				return jsonResponse({ data: null, errors: options.graphqlErrors })
			}
			if (body.query.includes("MapleCfDatasetSettings")) return jsonResponse({ data: settingsData })
			if (body.query.includes("MapleCfZoneAnalytics")) return jsonResponse({ data: httpData })
			if (body.query.includes("MapleCfAccountAnalytics")) return jsonResponse({ data: workersData })
			return jsonResponse({ data: null, errors: [{ message: "unknown query" }] })
		}
		if (url.includes("/workers/scripts")) {
			const page = Number(new URL(url).searchParams.get("page") ?? "1")
			const scripts = page === 1 ? (options.workerScripts ?? [{ id: "my-worker" }]) : []
			return jsonResponse({
				success: true,
				errors: [],
				messages: [],
				result: scripts,
				result_info: { count: scripts.length, page, per_page: 100, total_count: scripts.length },
			})
		}
		if (url.includes("/zones")) {
			if (options.zonesStatus) {
				return jsonResponse(
					{
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
						messages: [],
						result: null,
					},
					options.zonesStatus,
				)
			}
			const page = Number(new URL(url).searchParams.get("page") ?? "1")
			const zones = page === 1 ? (options.zones ?? [zoneFixture]) : []
			return jsonResponse({
				success: true,
				errors: [],
				messages: [],
				result: zones,
				result_info: { count: zones.length, page, per_page: 50, total_count: zones.length },
			})
		}
		return jsonResponse({ success: false, errors: [], messages: [], result: null }, 404)
	}

interface CapturedIngest {
	datasource: string
	orgId: string
	rows: Array<MetricSumRow | MetricGaugeRow>
}

interface CompiledQueryStub {
	rows: ReadonlyArray<Record<string, unknown>>
	calls: Array<{
		sql: string
		orgId: string
		options: { pinToIngestConfig?: boolean; profile?: string; context?: string } | undefined
	}>
}

const makeWarehouseStub = (
	captured: CapturedIngest[],
	queryStub?: CompiledQueryStub,
): WarehouseQueryServiceShape =>
	({
		ingest: (
			tenant: { orgId: string },
			datasource: string,
			rows: ReadonlyArray<MetricSumRow | MetricGaugeRow>,
		) =>
			Effect.sync(() => {
				captured.push({ datasource, orgId: tenant.orgId, rows: [...rows] })
			}),
		compiledQuery: (
			tenant: { orgId: string },
			compiled: {
				sql: string
				decodeRows: (
					rows: ReadonlyArray<Record<string, unknown>>,
				) => Effect.Effect<ReadonlyArray<unknown>, unknown>
			},
			options?: CompiledQueryStub["calls"][number]["options"],
		) =>
			// Mirror the real executor: run the compiled query's `decodeRows` so a
			// query's `rowSchema` (e.g. cloudflareUsageRowSchema's CHNumber coercion)
			// is actually exercised instead of passing raw stub rows straight through.
			Effect.sync(() => {
				queryStub?.calls.push({ sql: compiled.sql, orgId: tenant.orgId, options })
			}).pipe(
				Effect.flatMap(() => compiled.decodeRows(queryStub?.rows ?? [])),
				Effect.orDie,
			),
	}) as unknown as WarehouseQueryServiceShape

const makeLayer = (
	testDb: TestDb,
	captured: CapturedIngest[],
	fetchOptions: FetchOptions = {},
	configOverrides: Record<string, string> = {},
	queryStub?: CompiledQueryStub,
) =>
	CloudflareAnalyticsService.layer.pipe(
		Layer.provideMerge(CloudflareOAuthService.layer),
		Layer.provideMerge(OrgIngestKeysService.layer),
		Layer.provideMerge(OrgClickHouseSettingsService.layer),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseStub(captured, queryStub))),
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provideMerge(
			ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...configOverrides })),
		),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mockCloudflareFetch(fetchOptions))),
		// Disable the distilled retry policy: its backoff sleeps never resolve under the
		// TestClock, so a retryable failure would hang the suite instead of failing the test.
		Layer.provideMerge(Layer.succeed(Retry.Retry, { while: () => false })),
	)

/** Insert a connected Cloudflare org with a non-expiring encrypted access token. */
const seedConnection = (scope: string = ANALYTICS_SCOPE) =>
	Effect.gen(function* () {
		const database = yield* Database
		const key = yield* parseBase64Aes256GcmKey(ENCRYPTION_KEY_B64, (message) => new Error(message))
		const accessEnc = yield* encryptAes256Gcm("cf-access-token", key, (message) => new Error(message))
		yield* database.execute((db) =>
			db.insert(oauthConnections).values({
				id: randomUUID(),
				orgId: ORG,
				provider: "cloudflare",
				externalUserId: ACCOUNT_ID,
				externalAccountName: "Test Account",
				connectedByUserId: "user_1",
				scope,
				accessTokenCiphertext: accessEnc.ciphertext,
				accessTokenIv: accessEnc.iv,
				accessTokenTag: accessEnc.tag,
				expiresAt: null,
				createdAt: new Date(T0 - 60 * MIN),
				updatedAt: new Date(T0 - 60 * MIN),
			}),
		)
	})

/**
 * Insert a BYO-ClickHouse settings row for ORG. `schemaVersion` defaults to the
 * running `clickHouseSchemaVersion` and `syncStatus` to "connected" — i.e. a
 * write-ready org whose gateway-written metrics land in its own CH. Override
 * either to simulate schema drift / a disconnected cluster.
 */
const seedByoClickHouse = (overrides: { syncStatus?: string; schemaVersion?: string | null } = {}) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(orgClickHouseSettings).values({
				orgId: ORG,
				chUrl: "https://ch.example.com",
				chUser: "default",
				chDatabase: "maple",
				syncStatus: overrides.syncStatus ?? "connected",
				schemaVersion:
					overrides.schemaVersion === undefined ? clickHouseSchemaVersion : overrides.schemaVersion,
				createdAt: new Date(T0 - 60 * MIN),
				updatedAt: new Date(T0 - 60 * MIN),
				createdBy: "user_1",
				updatedBy: "user_1",
			}),
		)
	})

const seedStateRow = (values: Partial<typeof cloudflareAnalyticsState.$inferInsert> & { dataset: string }) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.insert(cloudflareAnalyticsState).values({
				id: randomUUID(),
				orgId: ORG,
				zoneId: "",
				createdAt: new Date(T0 - 60 * MIN),
				updatedAt: new Date(T0 - 60 * MIN),
				...values,
			}),
		)
	})

const loadStateRows = Effect.gen(function* () {
	const database = yield* Database
	return yield* database.execute((db) => db.select().from(cloudflareAnalyticsState))
})

interface FlatMetric {
	readonly name: string
	readonly value: number
	readonly serviceName: string
	readonly kind: "sum" | "gauge"
}

/** Flatten captured OTLP payloads into per-datapoint facts for assertions. */
const flattenOtlp = (calls: ReadonlyArray<OtlpCall>): FlatMetric[] => {
	const out: FlatMetric[] = []
	for (const call of calls) {
		for (const rm of call.payload.resourceMetrics) {
			const serviceName =
				rm.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue ?? ""
			for (const sm of rm.scopeMetrics) {
				for (const metric of sm.metrics) {
					const kind = metric.sum ? "sum" : "gauge"
					const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? []
					for (const dp of dataPoints) {
						out.push({ name: metric.name, value: dp.asDouble, serviceName, kind })
					}
				}
			}
		}
	}
	return out
}

describe("hasAnalyticsScopes", () => {
	it("requires every analytics scope", () => {
		assert.isTrue(hasAnalyticsScopes(ANALYTICS_SCOPE))
		assert.isFalse(hasAnalyticsScopes("account-settings.read workers-scripts.read"))
		assert.isFalse(hasAnalyticsScopes(""))
	})

	it("is not satisfied by zone.read alone — zone analytics needs analytics.read", () => {
		// Regression: zone.read lists zones but does NOT authorize httpRequestsAdaptiveGroups, so a
		// token with account+zone read but no analytics.read polled workers fine while every zone
		// query was rejected "not authorized". Such a token must read as not analytics-capable.
		assert.isFalse(hasAnalyticsScopes("account-analytics.read zone.read"))
		assert.isTrue(hasAnalyticsScopes("account-analytics.read analytics.read zone.read"))
	})
})

describe("CloudflareAnalyticsService", () => {
	it.effect("pollOrg skips when Cloudflare is not connected", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "not connected")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg records missing analytics scopes instead of calling the API", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection("account-settings.read workers-scripts.read")
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "missing analytics scopes")
			assert.strictEqual(summary.callsMade, 0)
			const rows = yield* loadStateRows
			// One row per account-scoped dataset (workers + queues×2 + durable objects).
			assert.strictEqual(rows.length, 4)
			for (const row of rows) assert.include(row.lastError ?? "", "scopes")
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg discovers zones, emits metrics to the gateway, and advances watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)
			assert.isAbove(summary.callsMade, 0)
			assert.isAbove(summary.rowsIngested, 0)

			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			const workersRow = rows.find((row) => row.dataset === "workers_invocations")
			assert.isDefined(httpRow)
			assert.isDefined(workersRow)
			assert.strictEqual(httpRow!.zoneId, ZONE_ID)
			assert.strictEqual(httpRow!.zoneName, ZONE_NAME)
			assert.isTrue(httpRow!.enabled)
			assert.isNull(httpRow!.lastError)
			// Head caught up to the safety-lag horizon: watermark = floor(now - 10min, 5min) = 11:50.
			const horizon = Date.parse("2026-07-02T11:50:00Z")
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), horizon)
			assert.strictEqual(workersRow!.watermarkAt?.getTime(), horizon)
			// The backfill frontier filled in behind the head and, under the plan's 2h retention,
			// reached its floor (floor(now-2h)+1bucket = 10:05) within the same tick.
			const retentionFloor = Date.parse("2026-07-02T10:05:00Z")
			assert.strictEqual(httpRow!.backfillAt?.getTime(), retentionFloor)
			assert.strictEqual(workersRow!.backfillAt?.getTime(), retentionFloor)
			// Settings were interrogated and cached.
			assert.include(httpRow!.settingsJson ?? "", "notOlderThan")
			// Lease released after the tick.
			assert.isNull(workersRow!.leaseUntil)

			const metrics = flattenOtlp(otlpCalls)
			const requests = metrics.find((m) => m.name === "cloudflare.http.requests")
			assert.isDefined(requests)
			assert.strictEqual(requests!.value, 100) // count 10 × sampleInterval 10
			assert.strictEqual(requests!.serviceName, `cloudflare/${ZONE_NAME}`)
			const workerRequests = metrics.find((m) => m.name === "cloudflare.worker.requests")
			assert.strictEqual(workerRequests!.value, 42)

			assert.isDefined(
				metrics.find((m) => m.name === "cloudflare.http.edge.ttfb" && m.kind === "gauge"),
			)
			assert.isDefined(
				metrics.find((m) => m.name === "cloudflare.worker.cpu_time" && m.kind === "gauge"),
			)
			// Every gateway POST is authenticated with the org's public ingest key (which routes
			// the org to its own warehouse — managed Tinybird or BYO ClickHouse).
			assert.isAbove(otlpCalls.length, 0)
			assert.isTrue(otlpCalls.every((call) => call.authorization.startsWith("Bearer maple_pk_")))
			// Nothing bypassed the gateway via a direct warehouse ingest.
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls })))
	})

	// Seed a workers anchor (discovery + settings pre-stamped fresh so the whole call budget goes to
	// polling) plus `zoneCount` http zone rows with null settingsJson ⇒ no retention cap ⇒ the full
	// 24h backfill. >10 zones means the 24h history can't fit in one 50-call tick.
	const seedManyZones = (zoneCount: number) =>
		Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "workers_invocations",
				zoneId: "",
				discoveredAt: new Date(T0 - 5 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			for (let i = 0; i < zoneCount; i++) {
				yield* seedStateRow({
					dataset: "http_requests",
					zoneId: `zone-${i}`,
					zoneName: `zone-${i}.example.com`,
					settingsFetchedAt: new Date(T0 - 5 * MIN),
				})
			}
		})

	// floor(now - 10min - 24h) — the 24h backfill floor when the plan imposes no retention cap.
	const BACKFILL_FLOOR = Date.parse("2026-07-01T11:50:00Z")
	const HORIZON = Date.parse("2026-07-02T11:50:00Z")

	it.effect(
		"prioritizes live data: the head reaches the horizon in one tick while the 24h backfill stays in progress",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				yield* seedManyZones(12)

				const service = yield* CloudflareAnalyticsService
				const summary = yield* service.pollOrg(ORG)
				assert.isNull(summary.skipped)

				const httpRows = (yield* loadStateRows).filter((row) => row.dataset === "http_requests")
				assert.strictEqual(httpRows.length, 12)
				for (const row of httpRows) {
					// Head is live within the FIRST tick — the newest window landed immediately, so the
					// integration card reads "just now" instead of hours ago.
					assert.strictEqual(row.watermarkAt?.getTime(), HORIZON)
					// History is still filling in behind it: the backfill frontier started walking down
					// from the seed but couldn't reach the 24h floor under the per-tick call budget.
					assert.isNotNull(row.backfillAt)
					assert.isAbove(row.backfillAt!.getTime(), BACKFILL_FLOOR)
					assert.isBelow(row.backfillAt!.getTime(), HORIZON)
				}
				// Budget-bound tick (that's WHY history is incomplete) — the head still won the race.
				assert.isAbove(summary.callsMade, 40)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect("the backfill frontier walks down to the 24h floor over subsequent ticks, then stops", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedManyZones(12)

			const service = yield* CloudflareAnalyticsService
			// Same wall-clock across ticks: the head stays put at the horizon; each tick drains more
			// history until the backfill frontier bottoms out at the 24h floor.
			yield* Effect.forEach([1, 2, 3, 4, 5], () => service.pollOrg(ORG), { discard: true })

			const httpRows = (yield* loadStateRows).filter((row) => row.dataset === "http_requests")
			for (const row of httpRows) {
				assert.strictEqual(row.watermarkAt?.getTime(), HORIZON)
				assert.strictEqual(row.backfillAt?.getTime(), BACKFILL_FLOOR)
			}
			// One more tick is a no-op: caught up on both frontiers, nothing left to ingest.
			const idle = yield* service.pollOrg(ORG)
			assert.strictEqual(idle.rowsIngested, 0)
			assert.strictEqual(idle.callsMade, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg disables state rows for vanished zones", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: "gone-zone",
				zoneName: "gone.example.com",
				watermarkAt: new Date(T0 - 20 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			const gone = rows.find((row) => row.zoneId === "gone-zone")
			assert.isDefined(gone)
			assert.isFalse(gone!.enabled)
			assert.include(gone!.lastError ?? "", "no longer present")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg skips when another tick holds the lease", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: new Date(T0 + 3 * MIN) })
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.skipped, "lease held by another tick")
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg reclaims a far-future (corrupt) lease instead of skipping forever", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// A live lease is always bounded by now+LEASE_MS (4min); anything beyond 2x that (8min)
			// can't come from normal operation — e.g. a crashed writer left a bogus far-future value
			// — so it must be treated as corrupt and reclaimed rather than wedging the org forever.
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: new Date(T0 + 60 * MIN) })
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isNull(summary.skipped)
			assert.isAbove(summary.rowsIngested, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollAllOrgs rollup reports skip counts and per-org reasons", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Reuse the lease-held skip scenario: a live 3min lease means this tick's pollOrg call
			// skips instead of polling.
			yield* seedStateRow({ dataset: "workers_invocations", leaseUntil: new Date(T0 + 3 * MIN) })
			const service = yield* CloudflareAnalyticsService
			const result = yield* service.pollAllOrgs()
			assert.strictEqual(result.rowsIngested, 0)
			assert.strictEqual(result.skipped, 1)
			assert.strictEqual(result.perOrg.length, 1)
			assert.strictEqual(result.perOrg[0]!.skipped, "lease held by another tick")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("resetOrgState re-enables disabled rows and clears error/discovery state", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "workers_invocations",
				enabled: false,
				lastError: "token revoked",
				lastErrorAt: new Date(T0 - 10 * MIN),
				discoveredAt: new Date(T0 - 10 * MIN),
			})
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				enabled: false,
				lastError: "token revoked",
				lastErrorAt: new Date(T0 - 10 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			yield* service.resetOrgState(ORG)

			const rows = yield* loadStateRows
			assert.strictEqual(rows.length, 2)
			for (const row of rows) {
				assert.isTrue(row.enabled)
				assert.isNull(row.lastError)
				assert.isNull(row.lastErrorAt)
			}
			const anchor = rows.find((row) => row.dataset === "workers_invocations")
			assert.isNull(anchor!.discoveredAt)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect("pollOrg records GraphQL errors without advancing watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.rowsIngested, 0)
			// The failure is now a first-class value on the summary (the seam turns it into an
			// exception event + ERROR log), not just a silent DB write.
			assert.isAbove(summary.failures.length, 0)
			assert.isTrue(summary.failures.some((failure) => failure.message.includes("quota exceeded")))
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "quota exceeded")
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), T0 - 30 * MIN)
			assert.strictEqual(captured.length, 0)
		}).pipe(
			Effect.provide(makeLayer(testDb, captured, { graphqlErrors: [{ message: "quota exceeded" }] })),
		)
	})

	it.effect("pollOrg surfaces a zone authz failure as an observable failure, not just a DB write", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// Regression for the invisible outage: a Cloudflare "not authorized" on the zone dataset
			// used to be written ONLY to cloudflare_analytics_state.lastError with zero telemetry, so a
			// fully-broken integration was invisible to find_errors/logs for hours. It must now be a
			// classified, first-class failure on the summary (which the seam turns into an exception
			// event + ERROR log through Maple's own error pipeline).
			const authz = summary.failures.find((failure) => failure.kind === "authz")
			assert.isDefined(authz)
			assert.strictEqual(authz!.scope, "zone")
			assert.strictEqual(authz!.datasetId, "http_requests")
			assert.include(authz!.message, "not authorized")
			assert.strictEqual(summary.rowsIngested, 0)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "not authorized")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [{ message: "not authorized to access these fields" }],
				}),
			),
		)
	})

	it.effect("an unattributed 'disabled' error does not cascade across a batched document", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Two zone datasets sharing one window → one batched document with two parts.
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: new Date(T0 - 30 * MIN),
					settingsFetchedAt: new Date(T0 - 5 * MIN),
				})
			}
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// The pathless "not enabled" error can't be attributed to either selection —
			// disabling both healthy datasets on that ambiguity would be destructive, so it
			// must degrade to a retryable failure instead.
			assert.isAbove(summary.failures.length, 0)
			const rows = yield* loadStateRows
			for (const dataset of ["http_requests", "firewall_events"]) {
				const row = rows.find((r) => r.dataset === dataset && r.zoneId === ZONE_ID)
				assert.isTrue(row!.enabled, `${dataset} must stay enabled`)
			}
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [{ message: "this dataset is not enabled for your zone" }],
				}),
			),
		)
	})

	it.effect("a path-attributed 'disabled' error disables only the owning dataset", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: new Date(T0 - 30 * MIN),
					settingsFetchedAt: new Date(T0 - 5 * MIN),
				})
			}
			const service = yield* CloudflareAnalyticsService
			yield* service.pollOrg(ORG)
			const rows = yield* loadStateRows
			const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
			const http = rows.find((r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID)
			assert.isFalse(firewall!.enabled)
			assert.isTrue(http!.enabled)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message: "firewallEventsAdaptiveGroups is not enabled for this zone",
							path: ["viewer", "zones", 0, "firewall"],
						},
					],
				}),
			),
		)
	})

	it.effect(
		"a plan-gated 'does not have access to the path' error disables the dataset without telemetry",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(T0)
				yield* seedConnection()
				for (const dataset of ["http_requests", "firewall_events"]) {
					yield* seedStateRow({
						dataset,
						zoneId: ZONE_ID,
						zoneName: ZONE_NAME,
						watermarkAt: new Date(T0 - 30 * MIN),
						settingsFetchedAt: new Date(T0 - 5 * MIN),
					})
				}
				const service = yield* CloudflareAnalyticsService
				const summary = yield* service.pollOrg(ORG)
				// Cloudflare gates firewall_events behind the zone's plan ("does not have access to the
				// path ... access controls"). That is an expected per-plan degradation — the dataset must
				// be quietly disabled (like a "not enabled" error), NOT raised as an AnalyticsPollError.
				assert.strictEqual(summary.failures.length, 0)
				const rows = yield* loadStateRows
				const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
				const http = rows.find((r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID)
				assert.isFalse(firewall!.enabled, "plan-gated dataset must be disabled")
				// The clean sibling wasn't the problem — Cloudflare voids the whole batch's `data` when one
				// selection is gated. It must not be dragged into a "carried no data" failure.
				assert.isTrue(http!.enabled, "clean sibling must stay enabled")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, captured, {
						graphqlErrors: [
							{
								message:
									"zone 'z' does not have access to the path. Refer to this page for more details about access controls: https://developers.cloudflare.com/analytics/graphql-api/errors/",
								path: ["viewer", "zones", 0, "firewall"],
							},
						],
					}),
				),
			)
		},
	)

	it.effect("a genuine error alongside a plan-gated one still fails the clean siblings", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			for (const dataset of ["http_requests", "firewall_events"]) {
				yield* seedStateRow({
					dataset,
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					watermarkAt: new Date(T0 - 30 * MIN),
					settingsFetchedAt: new Date(T0 - 5 * MIN),
				})
			}
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// firewall is plan-gated (disabled), but the batch also carried a genuine "quota exceeded"
			// error. Because not ALL errors are plan-gating, the clean sibling (http) must still surface
			// a failure — the plan-gating skip must never swallow a real outage.
			const rows = yield* loadStateRows
			const firewall = rows.find((r) => r.dataset === "firewall_events" && r.zoneId === ZONE_ID)
			assert.isFalse(firewall!.enabled)
			assert.isAbove(summary.failures.length, 0)
			assert.isTrue(summary.failures.some((failure) => failure.message.includes("quota exceeded")))
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message: "zone 'z' does not have access to the path. access controls",
							path: ["viewer", "zones", 0, "firewall"],
						},
						{ message: "quota exceeded" },
					],
				}),
			),
		)
	})

	it.effect("a plan-gated latency field on http_requests downgrades quantiles instead of disabling", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// Only the timing-quantile field is gated ("does not have access to the field
			// 'edgetimetofirstbytemsp50'"). The counters (requests/errors) still work, so the dataset
			// must stay enabled and merely drop quantiles — NOT be wholesale-disabled — with no telemetry.
			assert.strictEqual(summary.failures.length, 0)
			const http = (yield* loadStateRows).find(
				(r) => r.dataset === "http_requests" && r.zoneId === ZONE_ID,
			)
			assert.isTrue(http!.enabled, "counters still work — dataset must stay enabled")
			assert.isFalse(http!.quantilesAvailable, "gated latency field must downgrade quantiles")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, captured, {
					graphqlErrors: [
						{
							message:
								"zone 'z' does not have access to the field 'edgetimetofirstbytemsp50' from the path",
							path: ["viewer", "zones", 0, "groups"],
						},
					],
				}),
			),
		)
	})

	it.effect("pollOrg records a zones-list auth failure, disables rows, and holds watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			// A 401 on the zones list means Cloudflare no longer honors the token: the tick
			// aborts before any GraphQL/ingest work and flags the org for reconnect.
			assert.strictEqual(
				summary.skipped,
				"zone discovery failed: @maple/http/errors/IntegrationsRevokedError",
			)
			assert.strictEqual(summary.callsMade, 0)
			assert.strictEqual(summary.rowsIngested, 0)

			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.isDefined(httpRow)
			// Revocation records the error on every state row and disables them until reconnect…
			assert.include(httpRow!.lastError ?? "", "reconnect")
			assert.isFalse(httpRow!.enabled)
			// …while the watermark holds, so a reconnect resumes from where polling stopped.
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), T0 - 30 * MIN)
			assert.strictEqual(otlpCalls.length, 0)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, zonesStatus: 401 })))
	})

	it.effect("pollOrg emits OTLP sum/gauge metrics to the ingest gateway", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.isAbove(summary.rowsIngested, 0)
			assert.isAbove(otlpCalls.length, 0)

			// Attributed to the org via its public ingest key → the gateway routes it per-org
			// (managed Tinybird or the org's BYO ClickHouse), and meters it there.
			assert.isTrue(otlpCalls.every((call) => call.authorization.startsWith("Bearer maple_pk_")))

			// A well-formed OTLP envelope: request counts are a DELTA-temporality monotonic sum.
			const requestsMetric = otlpCalls
				.flatMap((call) => call.payload.resourceMetrics)
				.flatMap((rm) => rm.scopeMetrics)
				.flatMap((sm) => sm.metrics)
				.find((metric) => metric.name === "cloudflare.http.requests")
			assert.isDefined(requestsMetric)
			assert.isDefined(requestsMetric!.sum)
			assert.strictEqual(requestsMetric!.sum!.aggregationTemporality, 1)
			assert.strictEqual(requestsMetric!.sum!.isMonotonic, true)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls })))
	})

	it.effect("pollOrg records a gateway ingest failure without advancing watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const otlpCalls: OtlpCall[] = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				watermarkAt: new Date(T0 - 30 * MIN),
				settingsFetchedAt: new Date(T0 - 5 * MIN),
			})
			const service = yield* CloudflareAnalyticsService
			const summary = yield* service.pollOrg(ORG)
			assert.strictEqual(summary.rowsIngested, 0)
			// The gateway was called and rejected the batch; the watermark holds for a retry.
			assert.isAbove(otlpCalls.length, 0)
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "ingest returned 500")
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), T0 - 30 * MIN)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls, metricsStatus: 500 })))
	})

	it.effect("getStatus reflects zone and workers state rows", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				lastSuccessAt: new Date(T0 - 5 * MIN),
				watermarkAt: new Date(T0 - 15 * MIN),
			})
			yield* seedStateRow({
				dataset: "workers_invocations",
				lastError: "boom",
				lastErrorAt: new Date(T0),
			})
			const service = yield* CloudflareAnalyticsService
			const status = yield* service.getStatus(ORG)
			assert.strictEqual(status.zones.length, 1)
			assert.deepStrictEqual(status.zones[0], {
				id: ZONE_ID,
				name: ZONE_NAME,
				enabled: true,
				lastSyncedAt: T0 - 5 * MIN,
				lastError: null,
				watermarkAt: T0 - 15 * MIN,
			})
			assert.strictEqual(status.workers?.lastError, "boom")
			assert.strictEqual(status.workers?.watermarkAt, null)
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})

	it.effect(
		"getIntegrationStatus returns a disconnected status and ignores state rows when not connected",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				// A leftover state row must not leak into the response once the OAuth connection is gone —
				// getIntegrationStatus short-circuits before reading analytics state.
				yield* seedStateRow({ dataset: "http_requests", zoneId: ZONE_ID, zoneName: ZONE_NAME })
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isFalse(status.connected)
				assert.strictEqual(status.accountId, null)
				assert.strictEqual(status.accountName, null)
				assert.strictEqual(status.connectedByUserId, null)
				assert.strictEqual(status.scope, null)
				assert.isFalse(status.analyticsCapable)
				assert.deepStrictEqual(status.zones, [])
				assert.strictEqual(status.workers, null)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect(
		"getIntegrationStatus merges the OAuth connection with analytics state for a connected org",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				yield* seedConnection()
				yield* seedStateRow({
					dataset: "http_requests",
					zoneId: ZONE_ID,
					zoneName: ZONE_NAME,
					lastSuccessAt: new Date(T0 - 5 * MIN),
					watermarkAt: new Date(T0 - 15 * MIN),
				})
				yield* seedStateRow({
					dataset: "workers_invocations",
					lastError: "boom",
					lastErrorAt: new Date(T0),
				})
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isTrue(status.connected)
				assert.strictEqual(status.accountId, ACCOUNT_ID)
				assert.strictEqual(status.accountName, "Test Account")
				assert.strictEqual(status.connectedByUserId, "user_1")
				assert.strictEqual(status.scope, ANALYTICS_SCOPE)
				// Full analytics scope → the card unlocks the analytics UI.
				assert.isTrue(status.analyticsCapable)
				assert.strictEqual(status.zones.length, 1)
				assert.strictEqual(status.zones[0]?.id, ZONE_ID)
				assert.strictEqual(status.zones[0]?.name, ZONE_NAME)
				assert.strictEqual(status.zones[0]?.lastSyncedAt, T0 - 5 * MIN)
				assert.strictEqual(status.workers?.lastError, "boom")
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect(
		"getIntegrationStatus reports analyticsCapable=false and null workers for a scope-limited token",
		() => {
			const testDb = createTestDb(trackedDbs)
			const captured: CapturedIngest[] = []
			return Effect.gen(function* () {
				// Connected, but the token lacks analytics.read — connected yet not analytics-capable,
				// and with no workers state row the workers block maps to null.
				yield* seedConnection("account-settings.read workers-scripts.read")
				const service = yield* CloudflareAnalyticsService
				const status = yield* service.getIntegrationStatus(ORG)
				assert.isTrue(status.connected)
				assert.isFalse(status.analyticsCapable)
				assert.deepStrictEqual(status.zones, [])
				assert.strictEqual(status.workers, null)
			}).pipe(Effect.provide(makeLayer(testDb, captured)))
		},
	)

	it.effect("getUsage folds warehouse rows into per-service usage", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = {
			rows: [
				{
					serviceName: "cloudflare-worker/my-worker",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: 42.4,
					datapoints: 12,
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: 100.2,
					datapoints: 24,
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T11:00:00.000Z",
					requests: 50,
					datapoints: 10,
					lastTimeUnix: "2026-07-02T11:40:00.000Z",
				},
			],
			calls: [],
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)

			assert.strictEqual(usage.windowEnd, T0)
			assert.strictEqual(usage.windowStart, T0 - 24 * 60 * MIN)
			assert.strictEqual(usage.bucketSeconds, 3600)
			assert.strictEqual(usage.totalRequests, 192)

			assert.strictEqual(usage.services.length, 2)
			const zone = usage.services[0]!
			assert.strictEqual(zone.kind, "zone")
			assert.strictEqual(zone.serviceName, "cloudflare/example.com")
			assert.strictEqual(zone.displayName, "example.com")
			assert.strictEqual(zone.totalRequests, 150)
			assert.strictEqual(zone.totalDatapoints, 34)
			assert.strictEqual(zone.lastDataAt, Date.parse("2026-07-02T11:40:00.000Z"))
			assert.strictEqual(zone.buckets.length, 2)
			assert.strictEqual(zone.buckets[0]?.bucketStart, Date.parse("2026-07-02T10:00:00.000Z"))
			assert.strictEqual(zone.buckets[0]?.requests, 100)

			const worker = usage.services[1]!
			assert.strictEqual(worker.kind, "worker")
			assert.strictEqual(worker.displayName, "my-worker")
			assert.strictEqual(worker.totalRequests, 42)

			// This org has no BYO-CH settings row (managed/Tinybird), so the gateway wrote its
			// metrics to Tinybird — the usage read must pin to the ingest config to find them.
			assert.strictEqual(queryStub.calls.length, 1)
			assert.strictEqual(queryStub.calls[0]?.options?.pinToIngestConfig, true)
			assert.strictEqual(queryStub.calls[0]?.options?.profile, "aggregation")
			assert.strictEqual(queryStub.calls[0]?.orgId, ORG)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage reads the org's own warehouse for a write-ready BYO-CH org", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Connected + schema_version == running version → gateway routes metrics to the
			// org's own ClickHouse, so the read must NOT pin to the ingest (Tinybird) config.
			yield* seedByoClickHouse()
			const service = yield* CloudflareAnalyticsService
			yield* service.getUsage(ORG)

			assert.strictEqual(queryStub.calls.length, 1)
			assert.notStrictEqual(queryStub.calls[0]?.options?.pinToIngestConfig, true)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage pins to ingest config for a drifted (not-ready) BYO-CH org", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			// Stale schema_version → gateway falls back to Tinybird for this org's metrics,
			// so the read must pin to the ingest config (its own CH would be empty).
			yield* seedByoClickHouse({ schemaVersion: "stale-schema-version" })
			const service = yield* CloudflareAnalyticsService
			yield* service.getUsage(ORG)

			assert.strictEqual(queryStub.calls.length, 1)
			assert.strictEqual(queryStub.calls[0]?.options?.pinToIngestConfig, true)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage coerces ClickHouse string-encoded counts (BYO-CH raw-CH response)", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		// Raw ClickHouse `FORMAT JSON` serializes count()/UInt64 as STRINGS (Tinybird
		// returns numbers). A ready BYO-CH org reads its own CH, so `datapoints` (and
		// defensively `requests`) arrive as strings — they must be coerced, not thrown
		// inside the `CloudflareUsageBucket` Schema.Class (which would 500 with no body).
		const queryStub: CompiledQueryStub = {
			rows: [
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T10:00:00.000Z",
					requests: "100.2",
					datapoints: "24",
					lastTimeUnix: "2026-07-02T10:55:00.000Z",
				},
				{
					serviceName: "cloudflare/example.com",
					bucket: "2026-07-02T11:00:00.000Z",
					requests: "50",
					datapoints: "10",
					lastTimeUnix: "2026-07-02T11:40:00.000Z",
				},
			],
			calls: [],
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			yield* seedConnection()
			yield* seedByoClickHouse()
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)

			assert.strictEqual(usage.services.length, 1)
			const zone = usage.services[0]!
			assert.strictEqual(zone.totalRequests, 150)
			assert.strictEqual(zone.totalDatapoints, 34)
			assert.strictEqual(zone.buckets.length, 2)
			assert.strictEqual(zone.buckets[0]?.datapoints, 24)
			assert.strictEqual(zone.buckets[0]?.requests, 100)
			assert.strictEqual(usage.totalRequests, 150)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})

	it.effect("getUsage returns an empty window when not connected", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		const queryStub: CompiledQueryStub = { rows: [], calls: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(T0)
			const service = yield* CloudflareAnalyticsService
			const usage = yield* service.getUsage(ORG)
			assert.strictEqual(usage.totalRequests, 0)
			assert.strictEqual(usage.services.length, 0)
			assert.strictEqual(usage.windowEnd, T0)
			// Not connected → no warehouse query at all.
			assert.strictEqual(queryStub.calls.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, {}, {}, queryStub)))
	})
})
