import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { CreateScrapeTargetRequest, OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "./PlanetScaleOAuthService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"

const trackedDbs: TestDb[] = []
const originalFetch = globalThis.fetch

// create() forks a detached probe that uses the global fetch; stub it before
// EVERY test (afterEach restores the real fetch, so a module-level stub would
// only protect the first test) so the tests never touch the real network.
beforeEach(() => {
	globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch
})

afterEach(async () => {
	globalThis.fetch = originalFetch
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
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

// Single memoized discovery layer shared by both services, mirroring app.ts.
// `fetchStub` (when given) is provided as the FetchHttpClient.Fetch reference at
// layer scope so it also reaches the OAuth service's layer-built client.
const makeLayer = (testDb: TestDb, fetchStub?: typeof globalThis.fetch) => {
	const oauthLive = PlanetScaleOAuthService.layer
	const discoveryLive = PlanetScaleDiscoveryService.layer.pipe(Layer.provide(oauthLive))
	const composed = Layer.mergeAll(
		discoveryLive,
		ScrapeTargetsService.layer.pipe(Layer.provide(Layer.mergeAll(discoveryLive, oauthLive))),
		oauthLive,
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))
	return fetchStub
		? Layer.mergeAll(composed, Layer.succeed(FetchHttpClient.Fetch, fetchStub))
		: composed
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const SD_PAYLOAD = [
	{
		targets: ["branch-1.metrics.psdb.cloud:443"],
		labels: {
			__metrics_path__: "/metrics",
			planetscale_database_branch_id: "branch-1",
			planetscale_database: "mydb",
		},
	},
	{
		targets: ["branch-2.metrics.psdb.cloud:443"],
		labels: {
			planetscale_database_branch_id: "branch-2",
			planetscale_database: "mydb",
		},
	},
	{
		// SSRF guard: a discovered link-local target must be dropped.
		targets: ["169.254.169.254:80"],
		labels: { planetscale_database_branch_id: "evil" },
	},
]

interface RecordedRequest {
	readonly url: string
	readonly authorization: string | null
}

const stubFetch =
	(recorded: Array<RecordedRequest>, respond: () => Response): typeof fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
		recorded.push({ url, authorization: headers.get("authorization") })
		return respond()
	}

const createPlanetScaleTargetRow = (
	organization: string,
	branchFilters?: { includeBranches?: string[]; excludeBranches?: string[] },
) =>
	Effect.gen(function* () {
		const service = yield* ScrapeTargetsService
		const created = yield* service.create(
			asOrgId("org_1"),
			new CreateScrapeTargetRequest({
				name: "PlanetScale Prod",
				targetType: "planetscale",
				organization,
				authCredentials: JSON.stringify({ tokenId: "tok_id", tokenSecret: "tok_secret" }),
				...(branchFilters?.includeBranches ? { includeBranches: branchFilters.includeBranches } : {}),
				...(branchFilters?.excludeBranches ? { excludeBranches: branchFilters.excludeBranches } : {}),
			}),
		)
		const rows = yield* service.listAllEnabled()
		const row = rows.find((candidate) => candidate.id === created.id)
		if (!row) return yield* Effect.die("created row not found")
		return row
	})

const BRANCHES_SD_PAYLOAD = ["main", "stg", "pr-12", "pr-13"].map((branch) => ({
	targets: [`${branch}.metrics.psdb.cloud:443`],
	labels: {
		__metrics_path__: "/metrics",
		planetscale_database_branch_id: branch,
		planetscale_database: "mydb",
	},
}))

describe("PlanetScaleDiscoveryService", () => {
	it.effect("discovers sub-targets with the token auth scheme and strips meta labels", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(SD_PAYLOAD)),
				),
			)

			assert.strictEqual(recorded[0]?.url, "https://api.planetscale.com/v1/organizations/my-org/metrics")
			assert.strictEqual(recorded[0]?.authorization, "token tok_id:tok_secret")

			// The 169.254.* target is dropped by the SSRF guard.
			assert.deepStrictEqual(entries.map((entry) => entry.subTargetKey), ["branch-1", "branch-2"])
			assert.strictEqual(entries[0]?.url, "https://branch-1.metrics.psdb.cloud:443/metrics")
			assert.strictEqual(entries[1]?.url, "https://branch-2.metrics.psdb.cloud:443/metrics")
			// `__`-prefixed Prometheus meta labels are stripped; SD labels survive.
			assert.deepStrictEqual(entries[0]?.labels, {
				planetscale_database_branch_id: "branch-1",
				planetscale_database: "mydb",
			})
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("collapses groups that fall back to the same host key into one sub-target", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			// Prod hazard: an http_sd payload with several groups that carry no
			// `planetscale_database_branch_id`, so subTargetKey falls back to the
			// shared host+path. Without dedup these become N rows with the SAME
			// (id, subTargetKey) and the scraper forks a leaking loop fiber per row.
			const DUP_HOST_PAYLOAD = [
				{ targets: ["metrics.psdb.cloud:443"], labels: { planetscale_database: "mydb" } },
				{ targets: ["metrics.psdb.cloud:443"], labels: { planetscale_database: "other" } },
				{ targets: ["metrics.psdb.cloud:443"], labels: {} },
			]

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(DUP_HOST_PAYLOAD)),
				),
			)

			assert.strictEqual(entries.length, 1)
			assert.strictEqual(entries[0]?.subTargetKey, "metrics.psdb.cloud:443/metrics")
			assert.strictEqual(entries[0]?.url, "https://metrics.psdb.cloud:443/metrics")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps branch-id-less groups distinct when they differ only by metrics path", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			// Same host, distinct `__metrics_path__` per group, no branch-id label —
			// a bare-host fallback key would collapse these to ONE endpoint and
			// silently drop the other's metrics.
			const PATH_ONLY_PAYLOAD = [
				{ targets: ["metrics.psdb.cloud:443"], labels: { __metrics_path__: "/metrics/db-a" } },
				{ targets: ["metrics.psdb.cloud:443"], labels: { __metrics_path__: "/metrics/db-b" } },
			]

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(PATH_ONLY_PAYLOAD)),
				),
			)

			assert.deepStrictEqual(
				entries.map((entry) => entry.subTargetKey),
				["metrics.psdb.cloud:443/metrics/db-a", "metrics.psdb.cloud:443/metrics/db-b"],
			)
			assert.deepStrictEqual(
				entries.map((entry) => entry.url),
				[
					"https://metrics.psdb.cloud:443/metrics/db-a",
					"https://metrics.psdb.cloud:443/metrics/db-b",
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("promotes __param_* meta labels to signed scrape-url query params", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			// PlanetScale authenticates the metrics data plane with a signed, expiring
			// URL: the http_sd group carries `__param_sig`/`__param_exp`, which
			// Prometheus promotes to `?sig=&exp=` on the scrape URL. Dropping them
			// yields `403 invalid signature` on every scrape (the real prod outage).
			const SIGNED_PAYLOAD = [
				{
					targets: ["metrics.psdb.cloud"],
					labels: {
						__metrics_path__: "/metrics/branch/3a1nf2gvu9rf",
						__scheme__: "https",
						__param_sig: "abc-_signature123",
						__param_exp: "1784238737",
						planetscale_branch_name: "main",
						planetscale_database_name: "mydb",
					},
				},
			]

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(SIGNED_PAYLOAD)),
				),
			)

			assert.strictEqual(entries.length, 1)
			// Base url + fiber-identity key stay param-free so identity is stable as
			// PlanetScale rotates the signature each refresh.
			assert.strictEqual(entries[0]?.url, "https://metrics.psdb.cloud/metrics/branch/3a1nf2gvu9rf")
			assert.strictEqual(
				entries[0]?.subTargetKey,
				"metrics.psdb.cloud/metrics/branch/3a1nf2gvu9rf",
			)
			// signedUrl carries the auth params the data plane actually verifies.
			assert.strictEqual(
				entries[0]?.signedUrl,
				"https://metrics.psdb.cloud/metrics/branch/3a1nf2gvu9rf?sig=abc-_signature123&exp=1784238737",
			)
			// The signed params must never leak into the metric labels.
			assert.deepStrictEqual(entries[0]?.labels, {
				planetscale_branch_name: "main",
				planetscale_database_name: "mydb",
			})
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("caches discovery for the TTL and refreshes after it elapses", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")
			const fetchStub = stubFetch(recorded, () => Response.json(SD_PAYLOAD))

			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.strictEqual(recorded.length, 1)

			yield* TestClock.adjust(Duration.minutes(11))
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.strictEqual(recorded.length, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("serves stale entries when a refresh fails and records the error", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(SD_PAYLOAD)),
				),
			)

			yield* TestClock.adjust(Duration.minutes(11))
			const stale = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => new Response("nope", { status: 503 })),
				),
			)

			assert.deepStrictEqual(stale.map((entry) => entry.subTargetKey), ["branch-1", "branch-2"])
			const lastError = yield* discovery.lastError(row.id)
			assert.include(lastError ?? "", "HTTP 503")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("maps a rejected service token to ScrapeTargetAuthError when no cache exists", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			const error = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("unauthorized", { status: 401 })),
				),
				Effect.flip,
			)

			// Credential rejection is an auth failure (502 taxonomy), not the
			// persistence 503 — the reason keys the UI's remediation copy.
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetAuthError")
			if (error._tag === "@maple/http/errors/ScrapeTargetAuthError") {
				assert.strictEqual(error.reason, "config")
			}
			assert.include(error.message, "read_metrics_endpoints")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("maps a non-auth upstream failure to ScrapeTargetUpstreamError with the status", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")

			const error = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("boom", { status: 500 })),
				),
				Effect.flip,
			)

			// A provider 5xx is an upstream failure (502 taxonomy), NOT our-DB
			// persistence (503) — the class carries the status so downstream never
			// has to regex it back out of the message.
			assert.strictEqual(error._tag, "@maple/http/errors/ScrapeTargetUpstreamError")
			if (error._tag === "@maple/http/errors/ScrapeTargetUpstreamError") {
				assert.strictEqual(error.status, 500)
			}
			assert.include(error.message, "HTTP 500")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("collapses concurrent TTL-miss refreshes into a single SD fetch", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")
			const fetchStub = stubFetch(recorded, () => Response.json(SD_PAYLOAD))

			// N per-branch scrapes miss the cold cache together — without the
			// in-flight collapse each would issue its own fetch against
			// PlanetScale's rate-limited SD endpoint.
			const [first, second, third] = yield* Effect.all(
				[discovery.discover(row), discovery.discover(row), discovery.discover(row)],
				{ concurrency: "unbounded" },
			).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			assert.strictEqual(recorded.length, 1)
			assert.deepStrictEqual(first?.map((entry) => entry.subTargetKey), ["branch-1", "branch-2"])
			assert.deepStrictEqual(second, first)
			assert.deepStrictEqual(third, first)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("excludes branches matching an exclude glob (e.g. pr-*)", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org", { excludeBranches: ["pr-*"] })

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(BRANCHES_SD_PAYLOAD)),
				),
			)

			assert.deepStrictEqual(entries.map((entry) => entry.subTargetKey), ["main", "stg"])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps only branches matching an include glob", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org", { includeBranches: ["main", "stg"] })

			const entries = yield* discovery.discover(row).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json(BRANCHES_SD_PAYLOAD)),
				),
			)

			assert.deepStrictEqual(entries.map((entry) => entry.subTargetKey), ["main", "stg"])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a managed planetscale_oauth row discovers with the grant's Bearer token", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		// One stub serves the OAuth token exchange, the org probes, and the SD call.
		const stub: typeof fetch = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			const headers = new Headers(
				init?.headers ?? (input instanceof Request ? input.headers : undefined),
			)
			recorded.push({ url, authorization: headers.get("authorization") })
			if (url.includes("/oauth/token")) {
				return Response.json({
					access_token: "ps-access-token",
					refresh_token: "ps-refresh-token",
					token_type: "Bearer",
					expires_in: 3600,
				})
			}
			if (url.includes("/v1/user")) {
				return Response.json({ id: "psuser_1" })
			}
			if (/\/v1\/organizations\?/.test(url)) {
				return Response.json({ data: [{ id: "psorg_1", name: "my-org" }] })
			}
			return Response.json(SD_PAYLOAD)
		}
		return Effect.gen(function* () {
			const oauth = yield* PlanetScaleOAuthService
			const targets = yield* ScrapeTargetsService
			const discovery = yield* PlanetScaleDiscoveryService

			// Store a grant for the org, then create a managed (credential-less) row.
			const { state } = yield* oauth.startConnect(asOrgId("org_1"), asUserId("user_1"), {
				callbackUrl: "https://api.example.com/api/integrations/planetscale/callback",
			})
			yield* oauth.completeConnect("auth-code", state)
			const created = yield* targets.create(
				asOrgId("org_1"),
				new CreateScrapeTargetRequest({
					name: "Managed PlanetScale",
					targetType: "planetscale",
					organization: "my-org",
					authType: "planetscale_oauth",
				}),
			)
			const rows = yield* targets.listAllEnabled()
			const row = rows.find((candidate) => candidate.id === created.id)
			if (!row) return yield* Effect.die("created row not found")

			const entries = yield* discovery.discover(row)

			const sdCall = recorded.find((call) => call.url.includes("/my-org/metrics"))
			assert.strictEqual(sdCall?.authorization, "Bearer ps-access-token")
			assert.deepStrictEqual(entries.map((entry) => entry.subTargetKey), ["branch-1", "branch-2"])
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(makeLayer(testDb, stub)),
		)
	})

	it.effect("invalidate drops the cache so the next discover refetches", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded: Array<RecordedRequest> = []
		return Effect.gen(function* () {
			const discovery = yield* PlanetScaleDiscoveryService
			const row = yield* createPlanetScaleTargetRow("my-org")
			const fetchStub = stubFetch(recorded, () => Response.json(SD_PAYLOAD))

			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			yield* discovery.invalidate(row.id)
			yield* discovery.discover(row).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))
			assert.strictEqual(recorded.length, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
