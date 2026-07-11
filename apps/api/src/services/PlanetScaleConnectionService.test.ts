import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { CreateScrapeTargetRequest, OrgId, PlanetScaleConnectRequest } from "@maple/domain/http"
import { FetchHttpClient } from "effect/unstable/http"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "../lib/test-pglite"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "./PlanetScaleDiscoveryService"
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
		}),
	)

const makeLayer = (testDb: TestDb) =>
	Layer.mergeAll(
		PlanetScaleConnectionService.layer.pipe(
			Layer.provide(
				ScrapeTargetsService.layer.pipe(Layer.provide(PlanetScaleDiscoveryService.layer)),
			),
		),
		ScrapeTargetsService.layer.pipe(Layer.provide(PlanetScaleDiscoveryService.layer)),
	).pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(makeConfig()))

const asOrgId = Schema.decodeUnknownSync(OrgId)

/**
 * Stub the PlanetScale management API: 2xx everywhere except paths listed in
 * `deny` (which get that status). Records authorization headers per URL.
 */
const stubPlanetScaleApi = (options?: {
	readonly deny?: Record<string, number>
	readonly calls?: Array<{ url: string; authorization: string | null }>
}) => {
	const stub = (async (input: string | URL | Request, init?: RequestInit) => {
		const requestUrl =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const headers = new Headers(
			init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
		)
		options?.calls?.push({ url: requestUrl, authorization: headers.get("authorization") })
		const denied = Object.entries(options?.deny ?? {}).find(([needle]) => requestUrl.includes(needle))
		if (denied) {
			return new Response("{}", { status: denied[1], headers: { "content-type": "application/json" } })
		}
		return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	// The service reads fetch through the FetchHttpClient.Fetch reference (whose
	// process-wide default caches the first globalThis.fetch it sees), so tests
	// must inject it per-effect; safeFetch paths still read globalThis.fetch.
	globalThis.fetch = stub
	return stub
}

const connectRequest = (overrides?: Partial<Record<"organization" | "tokenId" | "tokenSecret", string>>) =>
	new PlanetScaleConnectRequest({
		organization: overrides?.organization ?? "acme",
		tokenId: overrides?.tokenId ?? "tok_123",
		tokenSecret: overrides?.tokenSecret ?? "secret_abc",
	})

describe("PlanetScaleConnectionService", () => {
	it.effect("connect provisions a managed scrape target and persists the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<{ url: string; authorization: string | null }> = []
		const stub = stubPlanetScaleApi({ calls })

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			const status = yield* service.connect(orgId, "user_1", connectRequest())

			assert.isTrue(status.connected)
			assert.strictEqual(status.organization, "acme")
			assert.strictEqual(status.tokenId, "tok_123")
			assert.deepEqual(status.detectedPermissions, {
				readOrganization: true,
				readMetricsEndpoints: true,
				readDatabases: true,
			})
			assert.isNotNull(status.scrapeTarget)
			assert.isTrue(status.scrapeTarget!.enabled)

			// The probe hit the management API with the service-token header.
			assert.isTrue(calls.every((call) => call.authorization === "token tok_123:secret_abc"))
			assert.isTrue(calls.some((call) => call.url.includes("/v1/organizations/acme/metrics")))

			// The managed target row carries the ownership marker.
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ managed_by: string | null; target_type: string }>(
					testDb,
					"SELECT managed_by, target_type FROM scrape_targets WHERE id = $1",
					[status.scrapeTarget!.id],
				),
			)
			assert.strictEqual(row?.target_type, "planetscale")
			assert.match(row?.managed_by ?? "", /^planetscale:/)

			// The secret is stored encrypted — never plaintext.
			const connection = yield* Effect.promise(() =>
				queryFirstRow<{ token_secret_ciphertext: string }>(
					testDb,
					"SELECT token_secret_ciphertext FROM planetscale_connections WHERE org_id = $1",
					[orgId],
				),
			)
			assert.isDefined(connection)
			assert.notStrictEqual(connection!.token_secret_ciphertext, "secret_abc")
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(makeLayer(testDb)),
		)
	})

	it.effect("connect rejects a token without read_metrics_endpoints and persists nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi({ deny: { "/metrics": 403 } })

		return Effect.gen(function* () {
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			const error = yield* service.connect(orgId, "user_1", connectRequest()).pipe(Effect.flip)

			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "read_metrics_endpoints")

			const connection = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(
					testDb,
					"SELECT id FROM planetscale_connections WHERE org_id = $1",
					[orgId],
				),
			)
			assert.isUndefined(connection)
			const target = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(testDb, "SELECT id FROM scrape_targets WHERE org_id = $1", [
					orgId,
				]),
			)
			assert.isUndefined(target)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(makeLayer(testDb)),
		)
	})

	it.effect("connect adopts an existing user-created target for the same PlanetScale org", () => {
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

			const status = yield* service.connect(orgId, "user_1", connectRequest())

			// Adopted in place — no second target for the same PlanetScale org.
			assert.strictEqual(status.scrapeTarget?.id, existing.id)
			const list = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(list.targets.length, 1)
			assert.match(list.targets[0]?.managedBy ?? "", /^planetscale:/)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(makeLayer(testDb)),
		)
	})

	it.effect("disconnect tears down the managed target and the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const stub = stubPlanetScaleApi()

		return Effect.gen(function* () {
			const scrapeTargetsService = yield* ScrapeTargetsService
			const service = yield* PlanetScaleConnectionService
			const orgId = asOrgId("org_1")

			yield* service.connect(orgId, "user_1", connectRequest())
			const result = yield* service.disconnect(orgId)

			assert.isTrue(result.disconnected)
			const status = yield* service.getStatus(orgId)
			assert.isFalse(status.connected)
			const list = yield* scrapeTargetsService.list(orgId)
			assert.strictEqual(list.targets.length, 0)
		}).pipe(
			Effect.provideService(FetchHttpClient.Fetch, stub),
			Effect.provide(makeLayer(testDb)),
		)
	})
})
