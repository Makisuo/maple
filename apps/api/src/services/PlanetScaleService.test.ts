import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "./PlanetScaleOAuthService"
import { PlanetScaleService } from "./PlanetScaleService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id",
			PLANETSCALE_OAUTH_CLIENT_SECRET: "ps-client-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const oauthLive = PlanetScaleOAuthService.layer
	const discoveryLive = PlanetScaleDiscoveryService.layer.pipe(Layer.provide(oauthLive))
	const scrapeTargetsLive = ScrapeTargetsService.layer.pipe(
		Layer.provide(Layer.mergeAll(discoveryLive, oauthLive)),
	)
	return Layer.mergeAll(
		PlanetScaleService.layer.pipe(Layer.provide(oauthLive)),
		PlanetScaleConnectionService.layer.pipe(
			Layer.provide(Layer.mergeAll(scrapeTargetsLive, oauthLive)),
		),
		oauthLive,
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

/**
 * Stub the management API: databases/branches listings return the given
 * fixtures; everything else (the connect probes) returns 200.
 */
const stubApi = (fixtures: {
	databases: Array<{ id: string; name: string; kind?: string }>
	branchesByDatabase: Record<string, Array<{ id: string; name: string; production?: boolean }>>
}) => {
	const stub = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		if (url.includes("/oauth/token")) {
			return json({
				access_token: "ps-access-token",
				refresh_token: "ps-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			})
		}
		if (url.includes("/v1/user")) {
			return json({ id: "psuser_1" })
		}
		if (/\/v1\/organizations\?/.test(url)) {
			return json({ data: [{ id: "psorg_1", name: "acme" }] })
		}
		const branchesMatch = url.match(/\/databases\/([^/?]+)\/branches/)
		if (branchesMatch) {
			return json({ data: fixtures.branchesByDatabase[decodeURIComponent(branchesMatch[1])] ?? [] })
		}
		if (url.includes("/databases")) {
			return json({ data: fixtures.databases })
		}
		return json([])
	}) as typeof fetch
	globalThis.fetch = stub
	return stub
}

/** Store the OAuth grant (start + exchange) and bind it to the "acme" org. */
const connect = (orgId: string) =>
	Effect.gen(function* () {
		const oauth = yield* PlanetScaleOAuthService
		const connections = yield* PlanetScaleConnectionService
		const { state } = yield* oauth.startConnect(asOrgId(orgId), asUserId("user_1"), {
			callbackUrl: "https://api.example.com/api/integrations/planetscale/callback",
		})
		yield* oauth.completeConnect("auth-code", state)
		yield* connections.finalizeOrgSelection(asOrgId(orgId), { organization: "acme" })
	})

describe("PlanetScaleService", () => {
	it.effect("pollAllOrgs refreshes inventory and lists databases", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [
				{ id: "db_1", name: "main-db" },
				{ id: "db_2", name: "analytics", kind: "postgresql" },
			],
			branchesByDatabase: {
				"main-db": [
					{ id: "br_1", name: "main", production: true },
					{ id: "br_2", name: "dev" },
				],
				analytics: [{ id: "br_3", name: "main", production: true }],
			},
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService

			const summary = yield* service.pollAllOrgs()
			assert.strictEqual(summary.orgs, 1)
			assert.strictEqual(summary.refreshed, 1)
			assert.strictEqual(summary.failures, 0)

			const rows = yield* service.listDatabases(asOrgId("org_1"))
			assert.strictEqual(rows.length, 2)
			const main = rows.find((row) => row.name === "main-db")
			assert.strictEqual(main?.kind, "mysql")
			assert.strictEqual(main?.branchesJson?.length, 2)
			assert.isTrue(main?.branchesJson?.some((branch) => branch.name === "main" && branch.production))
			const analytics = rows.find((row) => row.name === "analytics")
			assert.strictEqual(analytics?.kind, "postgresql")

			// The connection carries the freshness marker for the status endpoint.
			const connection = yield* Effect.promise(() =>
				queryFirstRow<{ last_inventory_at: string | null }>(
					testDb,
					"SELECT last_inventory_at FROM planetscale_connections WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.isNotNull(connection?.last_inventory_at)

			// A second tick inside the TTL skips (no lease churn, no API refetch).
			const second = yield* service.pollAllOrgs()
			assert.strictEqual(second.skipped, 1)
			assert.strictEqual(second.refreshed, 0)
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect("queryInsights proxies top queries, defaulting to the production branch", () => {
		const testDb = createTestDb(trackedDbs)
		const insightCalls: string[] = []
		const baseStub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: {
				"main-db": [
					{ id: "br_1", name: "dev" },
					{ id: "br_2", name: "main", production: true },
				],
			},
		})
		const stub = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/insights")) {
				insightCalls.push(url)
				return new Response(
					JSON.stringify({
						data: [
							{
								fingerprint: "abc123",
								normalized_sql: "select * from users where id = ?",
								statement_type: "SELECT",
								query_count: 420,
								error_count: 2,
								sum_total_duration_millis: 12000,
								time_per_query: 28.5,
								p50_latency: 12,
								p99_latency: 140,
								rows_read_per_query: 3.2,
								rows_returned_per_query: 1,
								last_run_at: "2026-07-10T12:00:00Z",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)
			}
			return baseStub(input)
		}) as typeof fetch
		globalThis.fetch = stub

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			yield* service.pollAllOrgs()

			const result = yield* service.queryInsights(asOrgId("org_1"), {
				database: "main-db",
				startTime: Date.UTC(2026, 6, 10, 0, 0, 0),
				endTime: Date.UTC(2026, 6, 10, 12, 0, 0),
			})

			// Branch defaulted to the inventory's production branch.
			assert.strictEqual(result.branch, "main")
			assert.isTrue(insightCalls[0]?.includes("/databases/main-db/branches/main/insights"))
			assert.isNull(result.unavailableReason)
			assert.strictEqual(result.rows.length, 1)
			const row = result.rows[0]!
			assert.strictEqual(row.fingerprint, "abc123")
			assert.strictEqual(row.queryCount, 420)
			assert.strictEqual(row.p99LatencyMillis, 140)
			assert.strictEqual(row.lastRunAt, Date.UTC(2026, 6, 10, 12, 0, 0))
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect("queryInsights soft-fails when the token lacks read_database", () => {
		const testDb = createTestDb(trackedDbs)
		const baseStub = stubApi({ databases: [], branchesByDatabase: {} })
		const stub = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/insights")) {
				return new Response("{}", { status: 403, headers: { "content-type": "application/json" } })
			}
			return baseStub(input)
		}) as typeof fetch
		globalThis.fetch = stub

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService

			const result = yield* service.queryInsights(asOrgId("org_1"), {
				database: "main-db",
				branch: "main",
				startTime: 0,
				endTime: 60_000,
			})

			assert.strictEqual(result.rows.length, 0)
			assert.include(result.unavailableReason ?? "", "read_database")
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect('queryInsights soft-fails with a not-found message on 404', () => {
		const testDb = createTestDb(trackedDbs)
		const baseStub = stubApi({ databases: [], branchesByDatabase: {} })
		const stub = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/insights")) {
				return new Response("{}", { status: 404, headers: { "content-type": "application/json" } })
			}
			return baseStub(input)
		}) as typeof fetch
		globalThis.fetch = stub

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService

			const result = yield* service.queryInsights(asOrgId("org_1"), {
				database: "main-db",
				branch: "main",
				startTime: 0,
				endTime: 60_000,
			})

			assert.strictEqual(result.rows.length, 0)
			assert.include(result.unavailableReason ?? "", 'no insights')
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect('queryInsights soft-fails with the upstream status on a 5xx', () => {
		const testDb = createTestDb(trackedDbs)
		const baseStub = stubApi({ databases: [], branchesByDatabase: {} })
		const stub = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/insights")) {
				return new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
			}
			return baseStub(input)
		}) as typeof fetch
		globalThis.fetch = stub

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService

			const result = yield* service.queryInsights(asOrgId("org_1"), {
				database: "main-db",
				branch: "main",
				startTime: 0,
				endTime: 60_000,
			})

			assert.strictEqual(result.rows.length, 0)
			assert.include(result.unavailableReason ?? "", 'HTTP 500')
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect("queryInsights defaults to the first inventoried branch when none is production", () => {
		const testDb = createTestDb(trackedDbs)
		const insightCalls: string[] = []
		const baseStub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "dev" }] },
		})
		const stub = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/insights")) {
				insightCalls.push(url)
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			}
			return baseStub(input)
		}) as typeof fetch
		globalThis.fetch = stub

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			yield* service.pollAllOrgs()

			// No branch requested and the inventory has no production branch → the
			// first inventoried branch ("dev") is used, not the "main" hard fallback.
			const result = yield* service.queryInsights(asOrgId("org_1"), {
				database: "main-db",
				startTime: 0,
				endTime: 60_000,
			})

			assert.strictEqual(result.branch, "dev")
			assert.isTrue(insightCalls[0]?.includes("/branches/dev/insights"))
			assert.isNull(result.unavailableReason)
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})

	it.effect("a missing grant fails the org's tick without killing the fleet", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const oauth = yield* PlanetScaleOAuthService
			const service = yield* PlanetScaleService

			// The grant vanishes (revoked / cleaned up) while the binding row stays.
			yield* oauth.disconnect(asOrgId("org_1"))

			const summary = yield* service.pollAllOrgs()
			assert.strictEqual(summary.orgs, 1)
			assert.strictEqual(summary.failures, 1)
			assert.strictEqual(summary.refreshed, 0)

			// The failure lands on the connection row for the status endpoint.
			const connection = yield* Effect.promise(() =>
				queryFirstRow<{ last_inventory_error: string | null }>(
					testDb,
					"SELECT last_inventory_error FROM planetscale_connections WHERE org_id = $1",
					["org_1"],
				),
			)
			assert.isNotNull(connection?.last_inventory_error)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("soft-deletes databases that disappeared upstream", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			yield* service.pollAllOrgs()

			// A previously-seen database that no longer exists upstream.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO planetscale_databases (id, org_id, database_id, name, kind, created_at, updated_at)
					 VALUES ('row_gone', 'org_1', 'db_gone', 'legacy-db', 'mysql', now(), now())`,
				),
			)
			// Expire the TTL + lease so the next tick refreshes. The test clock sits
			// at epoch 0, so "2 hours ago" is relative to that.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE planetscale_poll_state SET last_success_at = to_timestamp(0) - interval '2 hours', lease_until = NULL`,
				),
			)

			const summary = yield* service.pollAllOrgs()
			assert.strictEqual(summary.refreshed, 1)

			const gone = yield* Effect.promise(() =>
				queryFirstRow<{ deleted_at: string | null }>(
					testDb,
					"SELECT deleted_at FROM planetscale_databases WHERE database_id = $1",
					["db_gone"],
				),
			)
			assert.isNotNull(gone?.deleted_at)

			// listDatabases hides soft-deleted rows.
			const rows = yield* service.listDatabases(asOrgId("org_1"))
			assert.deepStrictEqual(
				rows.map((row) => row.name),
				["main-db"],
			)
		}).pipe(Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))))
	})
})
