import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { cloudflareAnalyticsState, oauthConnections } from "@maple/db"
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { WarehouseQueryService, type WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { CloudflareAnalyticsService, hasAnalyticsScopes } from "./CloudflareAnalyticsService"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import type { MetricGaugeRow, MetricSumRow } from "./cloudflare-analytics/mapping"

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

interface FetchOptions {
	readonly zones?: ReadonlyArray<typeof zoneFixture>
	readonly zonesStatus?: number
	readonly graphqlErrors?: ReadonlyArray<{ message: string }>
}

const mockCloudflareFetch =
	(options: FetchOptions = {}): typeof globalThis.fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.includes("/graphql")) {
			const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}"))) as {
				query: string
			}
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

const makeWarehouseStub = (captured: CapturedIngest[]): WarehouseQueryServiceShape =>
	({
		ingest: (tenant: { orgId: string }, datasource: string, rows: ReadonlyArray<MetricSumRow | MetricGaugeRow>) =>
			Effect.sync(() => {
				captured.push({ datasource, orgId: tenant.orgId, rows: [...rows] })
			}),
	}) as unknown as WarehouseQueryServiceShape

const makeLayer = (testDb: TestDb, captured: CapturedIngest[], fetchOptions: FetchOptions = {}) =>
	CloudflareAnalyticsService.layer.pipe(
		Layer.provideMerge(CloudflareOAuthService.layer),
		Layer.provideMerge(Layer.succeed(WarehouseQueryService, makeWarehouseStub(captured))),
		Layer.provideMerge(testDb.layer),
		Layer.provideMerge(Env.layer),
		Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(baseConfig))),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mockCloudflareFetch(fetchOptions))),
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

	it.effect("pollOrg discovers zones, ingests metrics, and advances watermarks", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
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

			const sumBatch = captured.filter((entry) => entry.datasource === "metrics_sum").flatMap((entry) => entry.rows)
			const requests = sumBatch.find((row) => row.metric_name === "cloudflare.http.requests")
			assert.isDefined(requests)
			assert.strictEqual(requests!.value, 100) // count 10 × sampleInterval 10
			assert.strictEqual(requests!.service_name, `cloudflare/${ZONE_NAME}`)
			const workerRequests = sumBatch.find((row) => row.metric_name === "cloudflare.worker.requests")
			assert.strictEqual(workerRequests!.value, 42)

			const gaugeBatch = captured
				.filter((entry) => entry.datasource === "metrics_gauge")
				.flatMap((entry) => entry.rows)
			assert.isDefined(gaugeBatch.find((row) => row.metric_name === "cloudflare.http.edge.ttfb"))
			assert.isDefined(gaugeBatch.find((row) => row.metric_name === "cloudflare.worker.cpu_time"))
			assert.strictEqual(captured.every((entry) => entry.orgId === ORG), true)
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

	it.effect("getStatus reflects zone and workers state rows", () => {
		const testDb = createTestDb(trackedDbs)
		const captured: CapturedIngest[] = []
		return Effect.gen(function* () {
			yield* seedStateRow({
				dataset: "http_requests",
				zoneId: ZONE_ID,
				zoneName: ZONE_NAME,
				lastSuccessAt: new Date(T0 - 5 * MIN),
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
			})
			assert.strictEqual(status.workers?.lastError, "boom")
		}).pipe(Effect.provide(makeLayer(testDb, captured)))
	})
})
