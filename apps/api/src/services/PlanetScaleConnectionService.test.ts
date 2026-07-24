import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { CreateScrapeTargetRequest, OrgId, PlanetScaleMetricsTokenRequest, UserId } from "@maple/domain/http"
import { FetchHttpClient } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
import { PlanetScaleOAuthService } from "./PlanetScaleOAuthService"
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
		PlanetScaleConnectionService.layer.pipe(
			Layer.provide(Layer.mergeAll(scrapeTargetsLive, discoveryLive, oauthLive)),
		),
		scrapeTargetsLive,
		oauthLive,
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const CALLBACK_URL = "https://api.example.com/api/integrations/planetscale/callback"

/**
 * Stub the PlanetScale OAuth token endpoint plus the management API: 2xx
 * everywhere except paths listed in `deny` (which get that status). Records
 * authorization headers per URL. Also assigned to globalThis.fetch so the
 * FetchHttpClient.Fetch reference default and safeFetch paths agree.
 */
const stubPlanetScaleApi = (options?: {
	readonly deny?: Record<string, number>
	readonly calls?: Array<{ url: string; authorization: string | null }>
	readonly organizations?: ReadonlyArray<{ id: string; name: string }>
	/**
	 * Model PlanetScale's real metrics-endpoint behavior: OAuth bearers (and
	 * unknown/bad service tokens) 403, only `token tok_good:*` passes.
	 */
	readonly denyBearerMetrics?: boolean
	/** http_sd payload served by the control-plane SD endpoint (any auth). */
	readonly sdGroups?: ReadonlyArray<{
		targets: ReadonlyArray<string>
		labels?: Record<string, string>
	}>
	/**
	 * Prod-faithful data-plane split: discovered metrics hosts (anything off
	 * api.planetscale.com) 403 everything but the service-token scheme — the
	 * behavior that made OAuth-auth'd scrapes fail while the SD probe passed.
	 */
	readonly denyDataPlaneBearer?: boolean
}) => {
	const organizations = options?.organizations ?? [{ id: "psorg_1", name: "acme" }]
	const stub = (async (input: string | URL | Request, init?: RequestInit) => {
		const requestUrl =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(
			init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
		)
		options?.calls?.push({ url: requestUrl, authorization: headers.get("authorization") })
		if (requestUrl.includes("/oauth/token")) {
			return new Response(
				JSON.stringify({
					access_token: "ps-access-token",
					refresh_token: "ps-refresh-token",
					token_type: "Bearer",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}
		const denied = Object.entries(options?.deny ?? {}).find(([needle]) => requestUrl.includes(needle))
		if (denied) {
			return new Response("{}", { status: denied[1], headers: { "content-type": "application/json" } })
		}
		if (!requestUrl.includes("api.planetscale.com") && options?.denyDataPlaneBearer) {
			const authorization = headers.get("authorization") ?? ""
			return authorization.startsWith("token ")
				? new Response("up 1\n", { status: 200 })
				: new Response("forbidden", { status: 403 })
		}
		if (
			options?.sdGroups &&
			requestUrl.includes("api.planetscale.com") &&
			requestUrl.includes("/metrics")
		) {
			return new Response(JSON.stringify(options.sdGroups), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (options?.denyBearerMetrics && requestUrl.includes("/metrics")) {
			const authorization = headers.get("authorization") ?? ""
			if (!authorization.startsWith("token tok_good:")) {
				return new Response("{}", { status: 403, headers: { "content-type": "application/json" } })
			}
		}
		if (requestUrl.includes("/v1/user")) {
			return new Response(JSON.stringify({ id: "psuser_1", email: "dev@acme.test" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (/\/v1\/organizations\?/.test(requestUrl)) {
			return new Response(JSON.stringify({ data: organizations }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	// The services read fetch through the FetchHttpClient.Fetch reference (whose
	// process-wide default caches the first globalThis.fetch it sees), so tests
	// must inject it per-effect; safeFetch paths still read globalThis.fetch.
	globalThis.fetch = stub
	return stub
}

/** Run the real OAuth start + callback exchange so a grant exists for the org. */
const storeGrant = (orgId: OrgId) =>
	Effect.gen(function* () {
		const oauth = yield* PlanetScaleOAuthService
		const { state } = yield* oauth.startConnect(orgId, asUserId("user_1"), {
			callbackUrl: CALLBACK_URL,
		})
		return yield* oauth.completeConnect("auth-code", state)
	})

describe("PlanetScaleConnectionService", () => {
	it.effect("finalizeOrgSelection provisions a managed scrape target and persists the binding", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []
		const stub = stubPlanetScaleApi({ calls })

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const status = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })

			assert.isTrue(status.connected)
			assert.isFalse(status.pendingOrgSelection)
			assert.strictEqual(status.organization, "acme")
			assert.strictEqual(status.connectedByUserId, "user_1")
			assert.deepStrictEqual(status.detectedPermissions, {
				readOrganization: true,
				readMetricsEndpoints: true,
				readDatabases: true,
			})
			assert.isNotNull(status.scrapeTarget)
			assert.isTrue(status.scrapeTarget!.enabled)
			assert.strictEqual(status.metricsAuth, "oauth")

			// The probes hit the management API with the OAuth Bearer header.
			const probeCalls = calls.filter((call) => call.url.includes("/v1/organizations/acme"))
			assert.isAbove(probeCalls.length, 0)
			assert.isTrue(probeCalls.every((call) => call.authorization === "Bearer ps-access-token"))

			// The managed target row carries the ownership marker and grant-resolved
			// auth — no stored credentials.
			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					managed_by: string | null
					target_type: string
					auth_type: string
					auth_credentials_ciphertext: string | null
				}>(
					testDb,
					"SELECT managed_by, target_type, auth_type, auth_credentials_ciphertext FROM scrape_targets WHERE id = $1",
					[status.scrapeTarget!.id],
				),
			)
			assert.strictEqual(row?.target_type, "planetscale")
			assert.match(row?.managed_by ?? "", /^planetscale:/)
			assert.strictEqual(row?.auth_type, "planetscale_oauth")
			assert.isNull(row?.auth_credentials_ciphertext)

			// The webhook HMAC secret is minted at first binding, encrypted at rest.
			const connection = yield* Effect.promise(() =>
				queryFirstRow<{ webhook_secret_ciphertext: string | null }>(
					testDb,
					"SELECT webhook_secret_ciphertext FROM planetscale_connections WHERE org_id = $1",
					[orgId],
				),
			)
			assert.isDefined(connection)
			assert.isNotNull(connection!.webhook_secret_ciphertext)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("a stored grant with no binding reports pendingOrgSelection", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({
			organizations: [
				{ id: "psorg_1", name: "acme" },
				{ id: "psorg_2", name: "beta" },
			],
		})

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			const before = yield* service.getStatus(orgId)
			assert.isFalse(before.connected)
			assert.isFalse(before.pendingOrgSelection)

			yield* storeGrant(orgId)

			const after = yield* service.getStatus(orgId)
			assert.isFalse(after.connected)
			assert.isTrue(after.pendingOrgSelection)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("finalizeOrgSelection rejects an organization outside the grant", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi()

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const error = yield* service
				.finalizeOrgSelection(orgId, { organization: "not-granted" })
				.pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "not-granted")

			const status = yield* service.getStatus(orgId)
			assert.isFalse(status.connected)
			assert.isTrue(status.pendingOrgSelection)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("binds with paused metrics when the bearer probe fails, until a service token arrives", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []
		// PlanetScale's metrics endpoints only accept service tokens: the bearer
		// probe 403s, the `token id:secret` scheme succeeds.
		const stub = stubPlanetScaleApi({ calls, denyBearerMetrics: true })

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			// The binding still succeeds — inventory/insights/webhooks run on the
			// grant; only scraping is paused.
			const bound = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })
			assert.isTrue(bound.connected)
			assert.strictEqual(bound.metricsAuth, "missing")
			assert.isFalse(bound.scrapeTarget!.enabled)
			assert.deepStrictEqual(bound.detectedPermissions, {
				readOrganization: true,
				readMetricsEndpoints: false,
				readDatabases: true,
			})

			// A bad token is rejected by the discovery probe and nothing changes.
			const error = yield* service
				.setMetricsToken(
					orgId,
					new PlanetScaleMetricsTokenRequest({ tokenId: "tok_bad", tokenSecret: "bad" }),
				)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "read_metrics_endpoints")

			// The valid token flips scraping on with stored credentials.
			const enabled = yield* service.setMetricsToken(
				orgId,
				new PlanetScaleMetricsTokenRequest({ tokenId: "tok_good", tokenSecret: "s3cret" }),
			)
			assert.strictEqual(enabled.metricsAuth, "service_token")
			assert.isTrue(enabled.scrapeTarget!.enabled)
			// The validation probe used the service-token scheme, not the bearer.
			assert.isTrue(
				calls.some(
					(call) =>
						call.url.includes("/v1/organizations/acme/metrics") &&
						call.authorization === "token tok_good:s3cret",
				),
			)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					auth_type: string
					auth_credentials_ciphertext: string | null
					enabled: boolean
				}>(
					testDb,
					"SELECT auth_type, auth_credentials_ciphertext, enabled FROM scrape_targets WHERE id = $1",
					[enabled.scrapeTarget!.id],
				),
			)
			assert.strictEqual(row?.auth_type, "token")
			assert.isNotNull(row?.auth_credentials_ciphertext)
			assert.isTrue(row?.enabled)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("pauses metrics when the data plane rejects the bearer despite a passing SD probe", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []
		// The prod bug: api.planetscale.com's SD endpoint 2xx'd the OAuth bearer,
		// so the target auto-enabled — but the discovered metrics.psdb.cloud hosts
		// only accept service tokens and 403'd every actual scrape.
		const stub = stubPlanetScaleApi({
			calls,
			denyDataPlaneBearer: true,
			sdGroups: [
				{
					targets: ["branch-1.metrics.psdb.cloud:443"],
					labels: { __metrics_path__: "/metrics", planetscale_database_branch_id: "branch-1" },
				},
			],
		})

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const bound = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })

			// Binding succeeds, but scraping is paused until a service token arrives.
			assert.isTrue(bound.connected)
			assert.strictEqual(bound.metricsAuth, "missing")
			assert.isFalse(bound.scrapeTarget!.enabled)
			assert.isFalse(bound.detectedPermissions?.readMetricsEndpoints)

			// The verdict came from an actual data-plane scrape probe with the
			// bearer. (Match on the host: fetch normalizes away the :443 port.)
			assert.isTrue(
				calls.some(
					(call) =>
						call.url.includes("branch-1.metrics.psdb.cloud") &&
						call.authorization === "Bearer ps-access-token",
				),
			)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("keeps oauth metrics enabled when the data-plane scrape accepts the bearer", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []
		// Data-plane host answers 200 to the bearer (the stub's default) — the
		// probe must not pause a working OAuth-auth'd target.
		const stub = stubPlanetScaleApi({
			calls,
			sdGroups: [
				{
					targets: ["branch-1.metrics.psdb.cloud:443"],
					labels: { __metrics_path__: "/metrics", planetscale_database_branch_id: "branch-1" },
				},
			],
		})

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const bound = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })

			assert.strictEqual(bound.metricsAuth, "oauth")
			assert.isTrue(bound.scrapeTarget!.enabled)
			assert.isTrue(bound.detectedPermissions?.readMetricsEndpoints)
			assert.isTrue(calls.some((call) => call.url.includes("branch-1.metrics.psdb.cloud")))
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("classifies transient metrics probe failures as upstream errors", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({ deny: { "/metrics": 503 } })

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const bound = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })
			assert.strictEqual(bound.metricsAuth, "missing")

			const error = yield* service
				.setMetricsToken(
					orgId,
					new PlanetScaleMetricsTokenRequest({ tokenId: "tok_retry", tokenSecret: "secret" }),
				)
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.include(error.message, "HTTP 503")
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect(
		"finalizeOrgSelection adopts an existing user-created target and keeps its service token",
		() => {
			const testDb = createTestDb(trackedDbs)
			const stub = stubPlanetScaleApi()

			return Effect.gen(function* () {
				const scrapeTargetsService = yield* ScrapeTargetsService
				const service = yield* PlanetScaleConnectionService
				const orgId = asOrgId("org_1")

				const existing = yield* scrapeTargetsService.create(
					orgId,
					new CreateScrapeTargetRequest({
						name: "Manual PlanetScale",
						targetType: "planetscale",
						organization: "acme",
						authType: "token",
						authCredentials: JSON.stringify({ tokenId: "old", tokenSecret: "old" }),
					}),
				)

				yield* storeGrant(orgId)
				const status = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })

				// Adopted in place — no second target for the same PlanetScale org, and
				// the working service token is KEPT: it's the auth PlanetScale's metrics
				// endpoints actually accept, so clobbering it would break scraping.
				assert.strictEqual(status.scrapeTarget?.id, existing.id)
				assert.strictEqual(status.metricsAuth, "service_token")
				const list = yield* scrapeTargetsService.list(orgId)
				assert.strictEqual(list.targets.length, 1)
				assert.match(list.targets[0]?.managedBy ?? "", /^planetscale:/)
				const row = yield* Effect.promise(() =>
					queryFirstRow<{ auth_type: string; auth_credentials_ciphertext: string | null }>(
						testDb,
						"SELECT auth_type, auth_credentials_ciphertext FROM scrape_targets WHERE id = $1",
						[existing.id],
					),
				)
				assert.strictEqual(row?.auth_type, "token")
				assert.isNotNull(row?.auth_credentials_ciphertext)
			}).pipe(
				Effect.provideService(FetchHttpClient.Fetch, stub),
				Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
			)
		},
	)

	it.effect("atomically rebinds to another PlanetScale organization and retires the old target", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({
			organizations: [
				{ id: "psorg_1", name: "acme" },
				{ id: "psorg_2", name: "beta" },
			],
		})

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const scrapeTargetsService = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			yield* storeGrant(orgId)
			const first = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })
			const firstTargetId = first.scrapeTarget!.id

			const sameOrg = yield* service.finalizeOrgSelection(orgId, {
				organization: "acme",
				includeBranches: ["main"],
			})
			assert.strictEqual(sameOrg.scrapeTarget?.id, firstTargetId)
			assert.deepStrictEqual(sameOrg.scrapeTarget?.includeBranches, ["main"])
			assert.strictEqual((yield* scrapeTargetsService.list(orgId)).targets.length, 1)

			const rebound = yield* service.finalizeOrgSelection(orgId, { organization: "beta" })
			assert.strictEqual(rebound.organization, "beta")
			assert.notStrictEqual(rebound.scrapeTarget?.id, firstTargetId)
			const targets = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(targets.targets.length, 1)
			assert.strictEqual(targets.targets[0]?.id, rebound.scrapeTarget?.id)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("never deletes a retired target whose ownership changed", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({
			organizations: [
				{ id: "psorg_1", name: "acme" },
				{ id: "psorg_2", name: "beta" },
			],
		})

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const scrapeTargetsService = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			yield* storeGrant(orgId)
			const first = yield* service.finalizeOrgSelection(orgId, { organization: "acme" })
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE scrape_targets SET managed_by = $1 WHERE id = $2", [
					"planetscale:another-connection",
					first.scrapeTarget!.id,
				]),
			)

			const rebound = yield* service.finalizeOrgSelection(orgId, { organization: "beta" })
			const targets = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(targets.targets.length, 2)
			assert.isTrue(targets.targets.some((target) => target.id === first.scrapeTarget!.id))
			assert.isTrue(targets.targets.some((target) => target.id === rebound.scrapeTarget!.id))
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("compensates a newly created target when the binding transaction fails", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi()

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const scrapeTargetsService = yield* ScrapeTargetsService
			const orgId = asOrgId("org_1")
			yield* storeGrant(orgId)
			yield* Effect.promise(() =>
				testDb.pglite.exec(
					`CREATE FUNCTION reject_planetscale_binding() RETURNS trigger AS $$
						BEGIN RAISE EXCEPTION 'forced binding failure'; END;
						$$ LANGUAGE plpgsql;
						CREATE TRIGGER reject_planetscale_binding
						BEFORE INSERT ON planetscale_connections
						FOR EACH ROW EXECUTE FUNCTION reject_planetscale_binding();`,
				),
			)

			const error = yield* service
				.finalizeOrgSelection(orgId, { organization: "acme" })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsPersistenceError")
			const targets = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(targets.targets.length, 0)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("disconnect tears down the managed target, the binding, and the grant", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi()

		return Effect.gen(function* () {
			const scrapeTargetsService = yield* ScrapeTargetsService
			const oauth = yield* PlanetScaleOAuthService
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			yield* service.finalizeOrgSelection(orgId, { organization: "acme" })
			const result = yield* service.disconnect(orgId)

			assert.isTrue(result.disconnected)
			const status = yield* service.getStatus(orgId)
			assert.isFalse(status.connected)
			assert.isFalse(status.pendingOrgSelection)
			assert.isFalse(yield* oauth.hasConnection(orgId))
			const list = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(list.targets.length, 0)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect("disconnect in the pending state drops the grant alone", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({
			organizations: [
				{ id: "psorg_1", name: "acme" },
				{ id: "psorg_2", name: "beta" },
			],
		})

		return Effect.gen(function* () {
			const oauth = yield* PlanetScaleOAuthService
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* storeGrant(orgId)
			const result = yield* service.disconnect(orgId)

			assert.isTrue(result.disconnected)
			assert.isFalse(yield* oauth.hasConnection(orgId))
			const status = yield* service.getStatus(orgId)
			assert.isFalse(status.pendingOrgSelection)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
		)
	})

	it.effect(
		"webhookConfig decrypts the minted secret once bound, and reports unconfigured otherwise",
		() => {
			const testDb = createTestDb(trackedDbs)
			const stub = stubPlanetScaleApi()

			return Effect.gen(function* () {
				const service = yield* PlanetScaleConnectionService
				const orgId = asOrgId("org_1")

				// No binding yet → nothing to expose (exercises the null-ciphertext branch).
				const before = yield* service.webhookConfig(orgId)
				assert.isFalse(before.configured)
				assert.isNull(before.path)
				assert.isNull(before.secret)

				yield* storeGrant(orgId)
				yield* service.finalizeOrgSelection(orgId, { organization: "acme" })

				// Bound → the secret decrypts (the only decrypt path for the webhook
				// secret) and the delivery path is exposed.
				const after = yield* service.webhookConfig(orgId)
				assert.isTrue(after.configured)
				assert.isNotNull(after.secret)
				assert.isAbove((after.secret ?? "").length, 0)
				assert.match(after.path ?? "", /^\/api\/integrations\/planetscale\/webhook\//)
			}).pipe(
				Effect.provideService(FetchHttpClient.Fetch, stub),
				Effect.provide(Layer.mergeAll(makeLayer(testDb), Layer.succeed(FetchHttpClient.Fetch, stub))),
			)
		},
	)
})
