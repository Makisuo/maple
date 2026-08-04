import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "@/services/auth/PlanetScaleOAuthService"
import { PlanetScaleService, deployRequestTimelineRows } from "./PlanetScaleService"
import { insertPlanetScaleEvent } from "./planetscale/webhook-events"
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
			Layer.provide(Layer.mergeAll(scrapeTargetsLive, discoveryLive, oauthLive)),
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
	deployRequestsByDatabase?: Record<string, Array<Record<string, unknown>>>
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
		// Must precede the /databases catch-all, which would otherwise serve the
		// databases fixture to the deploy-request poller — the poller would decode
		// that as deploy requests and silently record nothing.
		const deployRequestsMatch = url.match(/\/databases\/([^/?]+)\/deploy-requests/)
		if (deployRequestsMatch) {
			return json({
				data: fixtures.deployRequestsByDatabase?.[decodeURIComponent(deployRequestsMatch[1])] ?? [],
			})
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
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
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
			const insightUrl = new URL(insightCalls[0]!)
			assert.strictEqual(insightUrl.searchParams.get("sort"), "totalTime")
			assert.strictEqual(insightUrl.searchParams.get("dir"), "desc")
			assert.isNull(result.unavailableReason)
			assert.strictEqual(result.rows.length, 1)
			const row = result.rows[0]!
			assert.strictEqual(row.fingerprint, "abc123")
			assert.strictEqual(row.queryCount, 420)
			assert.strictEqual(row.p99LatencyMillis, 140)
			assert.strictEqual(row.lastRunAt, Date.UTC(2026, 6, 10, 12, 0, 0))
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
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
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("queryInsights soft-fails with a not-found message on 404", () => {
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
			assert.include(result.unavailableReason ?? "", "no insights")
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("queryInsights soft-fails with the upstream status on a 5xx", () => {
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
			assert.include(result.unavailableReason ?? "", "HTTP 500")
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
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
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
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
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})
})

describe("PlanetScaleService.listEvents", () => {
	const T0 = Date.parse("2026-08-04T12:00:00.000Z")

	/** Insert directly — listEvents is the unit under test, not the writer. */
	const seed = (
		testDb: TestDb,
		row: {
			id: string
			orgId?: string
			database?: string
			branch?: string
			category?: string
			eventType?: string
			offsetMs: number
		},
	) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`INSERT INTO planetscale_events
				 (id, org_id, database_id, database_name, branch_name, category, event_type, state,
				  external_id, title, source, occurred_at, created_at)
				 VALUES ($1, $2, '', $3, $4, $5, $6, 'x', $1, $1, 'webhook', $7, $7)`,
				[
					row.id,
					row.orgId ?? "org_1",
					row.database ?? "main-db",
					row.branch ?? "",
					row.category ?? "deploy_request",
					row.eventType ?? "deploy_request.schema_applied",
					new Date(T0 + row.offsetMs).toISOString(),
				],
			),
		)

	const window = { startTime: T0 - 60 * 60_000, endTime: T0 + 60 * 60_000 }

	it.effect("returns newest first and never leaks another org's rows", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seed(testDb, { id: "a", offsetMs: 0 })
			yield* seed(testDb, { id: "b", offsetMs: 1000 })
			yield* seed(testDb, { id: "c", offsetMs: -1000 })
			yield* seed(testDb, { id: "other", orgId: "org_2", offsetMs: 500 })

			const service = yield* PlanetScaleService
			const page = yield* service.listEvents(asOrgId("org_1"), { ...window, limit: 100 })
			assert.deepStrictEqual(
				page.events.map((event) => event.id),
				["b", "a", "c"],
			)
			assert.isNull(page.nextCursor)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("excludes events outside the window", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seed(testDb, { id: "inside", offsetMs: 0 })
			yield* seed(testDb, { id: "before", offsetMs: -2 * 60 * 60_000 })
			yield* seed(testDb, { id: "after", offsetMs: 2 * 60 * 60_000 })

			const service = yield* PlanetScaleService
			const page = yield* service.listEvents(asOrgId("org_1"), { ...window, limit: 100 })
			assert.deepStrictEqual(
				page.events.map((event) => event.id),
				["inside"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("narrows by database and by category", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seed(testDb, { id: "main-deploy", offsetMs: 0 })
			yield* seed(testDb, { id: "other-db", database: "analytics", offsetMs: 1000 })
			yield* seed(testDb, {
				id: "main-branch",
				branch: "dev",
				category: "branch",
				eventType: "branch.ready",
				offsetMs: 2000,
			})

			const service = yield* PlanetScaleService
			const byDatabase = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				database: "main-db",
				limit: 100,
			})
			assert.deepStrictEqual([...byDatabase.events.map((e) => e.id)].sort(), [
				"main-branch",
				"main-deploy",
			])

			const byCategory = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				database: "main-db",
				categories: ["branch"],
				limit: 100,
			})
			assert.deepStrictEqual(
				byCategory.events.map((event) => event.id),
				["main-branch"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps deploy requests visible under a branch filter", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// A deploy request spans two branches and carries none, so a branch
			// filter must narrow branch-scoped rows WITHOUT hiding the deploy that
			// most likely explains what that branch did.
			yield* seed(testDb, { id: "deploy", branch: "", offsetMs: 0 })
			yield* seed(testDb, {
				id: "main-ready",
				branch: "main",
				category: "branch",
				eventType: "branch.ready",
				offsetMs: 1000,
			})
			yield* seed(testDb, {
				id: "dev-ready",
				branch: "dev",
				category: "branch",
				eventType: "branch.ready",
				offsetMs: 2000,
			})

			const service = yield* PlanetScaleService
			const page = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				branch: "main",
				limit: 100,
			})
			assert.deepStrictEqual([...page.events.map((e) => e.id)].sort(), ["deploy", "main-ready"])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("pages by keyset with no overlap and no gap", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			for (let i = 0; i < 5; i++) {
				yield* seed(testDb, { id: `e${i}`, offsetMs: i * 1000 })
			}

			const service = yield* PlanetScaleService
			const first = yield* service.listEvents(asOrgId("org_1"), { ...window, limit: 2 })
			assert.deepStrictEqual(
				first.events.map((event) => event.id),
				["e4", "e3"],
			)
			assert.isNotNull(first.nextCursor)

			const second = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				limit: 2,
				cursor: first.nextCursor ?? undefined,
			})
			assert.deepStrictEqual(
				second.events.map((event) => event.id),
				["e2", "e1"],
			)

			const third = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				limit: 2,
				cursor: second.nextCursor ?? undefined,
			})
			assert.deepStrictEqual(
				third.events.map((event) => event.id),
				["e0"],
			)
			// Last page: the limit+1 probe found nothing beyond it.
			assert.isNull(third.nextCursor)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("breaks a same-timestamp tie by id so paging can't loop or skip", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// occurredAt is truncated to the second, so ties are routine, not exotic.
			yield* seed(testDb, { id: "aaa", offsetMs: 0 })
			yield* seed(testDb, { id: "bbb", offsetMs: 0 })
			yield* seed(testDb, { id: "ccc", offsetMs: 0 })

			const service = yield* PlanetScaleService
			const first = yield* service.listEvents(asOrgId("org_1"), { ...window, limit: 2 })
			assert.deepStrictEqual(
				first.events.map((event) => event.id),
				["ccc", "bbb"],
			)
			const second = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				limit: 2,
				cursor: first.nextCursor ?? undefined,
			})
			assert.deepStrictEqual(
				second.events.map((event) => event.id),
				["aaa"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("treats a malformed cursor as page one rather than an error", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seed(testDb, { id: "a", offsetMs: 0 })
			const service = yield* PlanetScaleService
			// A stale or hand-edited link should show the first page, not a 500.
			const page = yield* service.listEvents(asOrgId("org_1"), {
				...window,
				limit: 10,
				cursor: "garbage",
			})
			assert.deepStrictEqual(
				page.events.map((event) => event.id),
				["a"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})

describe("PlanetScaleService deploy-request backfill", () => {
	const deployRequest = (over: Record<string, unknown> = {}) => ({
		number: 42,
		state: "closed",
		branch: "feature",
		into_branch: "main",
		html_url: "https://app.planetscale.com/acme/main-db/deploy-requests/42",
		actor: { display_name: "ada" },
		created_at: "2026-08-04T10:00:00Z",
		updated_at: "2026-08-04T10:20:00Z",
		closed_at: "2026-08-04T10:20:00Z",
		deployment: {
			state: "complete",
			started_at: "2026-08-04T10:10:00Z",
			finished_at: "2026-08-04T10:15:00Z",
		},
		...over,
	})

	const countEvents = (testDb: TestDb) =>
		Effect.promise(() =>
			queryFirstRow<{ n: number }>(testDb, "SELECT count(*)::int AS n FROM planetscale_events"),
		)

	it.effect("fans a deploy request into its transitions, then re-polls idempotently", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
			deployRequestsByDatabase: { "main-db": [deployRequest()] },
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService

			// The backfill runs BEFORE the inventory claim, so the first tick has no
			// databases to walk — the timeline fills on the following tick.
			const first = yield* service.pollAllOrgs()
			assert.strictEqual(first.deployEvents, 0)
			assert.strictEqual(first.refreshed, 1)

			const second = yield* service.pollAllOrgs()
			assert.strictEqual(second.deployEvents, 4)

			const states = yield* Effect.promise(() =>
				queryFirstRow<{ states: string }>(
					testDb,
					`SELECT string_agg(state, ',' ORDER BY occurred_at) AS states
					 FROM planetscale_events WHERE org_id = 'org_1'`,
				),
			)
			assert.strictEqual(states?.states, "opened,in_progress,schema_applied,closed")

			const detail = yield* Effect.promise(() =>
				queryFirstRow<{
					external_id: string
					source: string
					actor_login: string | null
					url: string | null
					branch_name: string
					database_id: string
				}>(
					testDb,
					`SELECT external_id, source, actor_login, url, branch_name, database_id
					 FROM planetscale_events WHERE state = 'schema_applied'`,
				),
			)
			assert.strictEqual(detail?.external_id, "42")
			assert.strictEqual(detail?.source, "backfill")
			assert.strictEqual(detail?.actor_login, "ada")
			assert.isNotNull(detail?.url)
			// A deploy request spans two branches, so it is pinned to neither.
			assert.strictEqual(detail?.branch_name, "")
			// Inventory ran on the first tick, so identity resolves by now.
			assert.strictEqual(detail?.database_id, "db_1")

			// Same upstream on a third tick: the watermark and the dedupe index
			// between them must add nothing.
			const third = yield* service.pollAllOrgs()
			assert.strictEqual(third.deployEvents, 0)
			assert.strictEqual((yield* countEvents(testDb))?.n, 4)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("converges with a webhook delivery of the same transition", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
			deployRequestsByDatabase: {
				"main-db": [
					deployRequest({
						created_at: null,
						closed_at: null,
						deployment: { state: "complete", finished_at: "2026-08-04T10:15:00Z" },
					}),
				],
			},
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			yield* service.pollAllOrgs()

			// A webhook already recorded this exact transition, at the second
			// precision PlanetScale delivers.
			yield* insertPlanetScaleEvent({
				orgId: asOrgId("org_1"),
				databaseName: "main-db",
				branchName: "",
				category: "deploy_request",
				eventType: "deploy_request.schema_applied",
				state: "schema_applied",
				externalId: "42",
				title: "Deploy request #42 applied its schema",
				source: "webhook",
				occurredAtMs: Date.parse("2026-08-04T10:15:00Z"),
				createdAtMs: Date.parse("2026-08-04T10:15:00Z"),
			})

			yield* service.pollAllOrgs()
			// One marker, not two: the dedupe index is what makes the live and the
			// backfilled source converge instead of double-drawing every deploy.
			assert.strictEqual((yield* countEvents(testDb))?.n, 1)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			// testDb.layer is merged in as well as provided to the services:
			// insertPlanetScaleEvent is called directly here, so the test body needs
			// Database in its own context, not just inside the service graph.
			Effect.provide(
				Layer.mergeAll(makeLayer(testDb), testDb.layer, Layer.succeed(FetchHttpClient.Fetch, stub)),
			),
		)
	})

	it.effect("records nothing for a deploy request the payload never timestamps", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
			// An open deploy request with no deployment yet. A marker here would sit
			// at a guessed moment, inviting the wrong deploy to be blamed for a cliff.
			deployRequestsByDatabase: {
				"main-db": [{ number: 7, state: "open", updated_at: "2026-08-04T10:00:00Z" }],
			},
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			yield* service.pollAllOrgs()
			yield* service.pollAllOrgs()
			assert.strictEqual((yield* countEvents(testDb))?.n, 0)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("keeps the inventory refresh alive when the payload shape is wrong", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubApi({
			databases: [{ id: "db_1", name: "main-db" }],
			branchesByDatabase: { "main-db": [{ id: "br_1", name: "main", production: true }] },
			// The REST shape came from public docs, not a captured response. A wrong
			// guess must cost markers, never the inventory the service map depends on.
			deployRequestsByDatabase: { "main-db": [{ unexpected: "shape" }] },
		})

		return Effect.gen(function* () {
			yield* connect("org_1")
			const service = yield* PlanetScaleService
			const first = yield* service.pollAllOrgs()
			assert.strictEqual(first.refreshed, 1)
			assert.strictEqual(first.failures, 0)

			const second = yield* service.pollAllOrgs()
			assert.strictEqual(second.failures, 0)
			assert.strictEqual((yield* countEvents(testDb))?.n, 0)
			// The inventory still landed despite the unusable deploy payload.
			const rows = yield* service.listDatabases(asOrgId("org_1"))
			assert.strictEqual(rows.length, 1)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})
})

describe("deployRequestTimelineRows", () => {
	it("emits one row per transition the payload actually timestamps", () => {
		const rows = deployRequestTimelineRows({
			number: 42,
			state: "closed",
			created_at: "2026-08-01T10:00:00Z",
			closed_at: "2026-08-01T10:20:00Z",
			deployment: {
				state: "complete",
				started_at: "2026-08-01T10:10:00Z",
				finished_at: "2026-08-01T10:15:00Z",
			},
		})
		assert.deepStrictEqual(
			rows.map((row) => row.state),
			["opened", "in_progress", "schema_applied", "closed"],
		)
		// The event types must match the webhook vocabulary exactly, or the two
		// sources stop colliding on the dedupe index and every marker doubles.
		assert.deepStrictEqual(
			rows.map((row) => row.eventType),
			[
				"deploy_request.opened",
				"deploy_request.in_progress",
				"deploy_request.schema_applied",
				"deploy_request.closed",
			],
		)
		assert.strictEqual(rows[0]?.occurredAtMs, Date.parse("2026-08-01T10:00:00Z"))
	})

	it("emits nothing for transitions the payload doesn't timestamp", () => {
		// A marker at a guessed moment invites blaming the wrong deploy for a
		// latency cliff — silence is the safer failure.
		const rows = deployRequestTimelineRows({ number: 7, state: "open" })
		assert.deepStrictEqual(rows, [])
	})

	it("distinguishes a failed deployment from an applied one", () => {
		const rows = deployRequestTimelineRows({
			number: 8,
			deployment: { state: "error", finished_at: "2026-08-01T10:15:00Z" },
		})
		assert.deepStrictEqual(
			rows.map((row) => row.state),
			["errored"],
		)
	})

	it("distinguishes a revert from an ordinary close", () => {
		const reverted = deployRequestTimelineRows({
			number: 9,
			state: "reverted",
			closed_at: "2026-08-01T11:00:00Z",
		})
		assert.deepStrictEqual(
			reverted.map((row) => row.state),
			["reverted"],
		)
	})

	it("ignores unparseable timestamps rather than emitting an epoch-0 marker", () => {
		const rows = deployRequestTimelineRows({ number: 10, created_at: "not-a-date" })
		assert.deepStrictEqual(rows, [])
	})
})
