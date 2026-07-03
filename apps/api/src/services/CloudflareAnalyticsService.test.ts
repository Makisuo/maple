import { randomUUID } from "node:crypto"
import { Retry } from "@distilled.cloud/cloudflare"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { cloudflareAnalyticsState, oauthConnections } from "@maple/db"
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

const ANALYTICS_SCOPE = "account-settings.read account-analytics.read zone.read workers-scripts.read"

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
						dimensions: { datetimeFiveMinutes: BUCKET, cacheStatus: "hit", edgeResponseStatus: 200 },
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
						quantiles: { cpuTimeP50: 1500, cpuTimeP99: 9000, durationP50: 0.002, durationP99: 0.05 },
						dimensions: { datetimeFiveMinutes: BUCKET, scriptName: "my-worker", status: "success" },
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
	readonly graphqlErrors?: ReadonlyArray<{ message: string }>
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
			if (body.query.includes("MapleCfHttpAnalytics")) return jsonResponse({ data: httpData })
			if (body.query.includes("MapleCfWorkersAnalytics")) return jsonResponse({ data: workersData })
			return jsonResponse({ data: null, errors: [{ message: "unknown query" }] })
		}
		if (url.includes("/zones")) {
			if (options.zonesStatus) {
				return jsonResponse(
					{ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null },
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
		ingest: (tenant: { orgId: string }, datasource: string, rows: ReadonlyArray<MetricSumRow | MetricGaugeRow>) =>
			Effect.sync(() => {
				captured.push({ datasource, orgId: tenant.orgId, rows: [...rows] })
			}),
		compiledQuery: (
			tenant: { orgId: string },
			compiled: { sql: string },
			options?: CompiledQueryStub["calls"][number]["options"],
		) =>
			Effect.sync(() => {
				queryStub?.calls.push({ sql: compiled.sql, orgId: tenant.orgId, options })
				return queryStub?.rows ?? []
			}),
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
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseStub(captured, queryStub))),
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...configOverrides }))),
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
			const serviceName = rm.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue ?? ""
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
			assert.strictEqual(rows.length, 1)
			assert.include(rows[0]!.lastError ?? "", "scopes")
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
			// Caught up to the safety-lag horizon: watermark = floor(now - 10min, 5min) = 11:50.
			const horizon = Date.parse("2026-07-02T11:50:00Z")
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), horizon)
			assert.strictEqual(workersRow!.watermarkAt?.getTime(), horizon)
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

			assert.isDefined(metrics.find((m) => m.name === "cloudflare.http.edge.ttfb" && m.kind === "gauge"))
			assert.isDefined(metrics.find((m) => m.name === "cloudflare.worker.cpu_time" && m.kind === "gauge"))
			// Every gateway POST is authenticated with the org's public ingest key (which routes
			// the org to its own warehouse — managed Tinybird or BYO ClickHouse).
			assert.isAbove(otlpCalls.length, 0)
			assert.isTrue(otlpCalls.every((call) => call.authorization.startsWith("Bearer maple_pk_")))
			// Nothing bypassed the gateway via a direct warehouse ingest.
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { otlpCalls })))
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
			const rows = yield* loadStateRows
			const httpRow = rows.find((row) => row.dataset === "http_requests")
			assert.include(httpRow!.lastError ?? "", "quota exceeded")
			assert.strictEqual(httpRow!.watermarkAt?.getTime(), T0 - 30 * MIN)
			assert.strictEqual(captured.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb, captured, { graphqlErrors: [{ message: "quota exceeded" }] })))
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
			assert.strictEqual(summary.skipped, "zone discovery failed: @maple/http/errors/IntegrationsRevokedError")
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
			yield* seedStateRow({ dataset: "workers_invocations", lastError: "boom", lastErrorAt: new Date(T0) })
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

			// Metrics now flow through the ingest gateway per-org, so the usage read resolves via
			// the default (per-org) config — BYO-CH orgs read their own warehouse, not a Tinybird pin.
			assert.strictEqual(queryStub.calls.length, 1)
			assert.isUndefined(queryStub.calls[0]?.options?.pinToIngestConfig)
			assert.strictEqual(queryStub.calls[0]?.options?.profile, "aggregation")
			assert.strictEqual(queryStub.calls[0]?.orgId, ORG)
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
