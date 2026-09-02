import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Database, DatabaseError, type DatabaseApi } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { makeOAuthConnectionHelpers, type OAuthTokenEndpointConfig } from "./connection-helpers"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const ORG = asOrgId("org_oauth_helpers")
const USER = asUserId("user_oauth_helpers")

const baseConfig = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
}

const configLive = ConfigProvider.layer(ConfigProvider.fromUnknown(baseConfig))

const TOKEN_URL = "https://provider.example.com/oauth/token"

const tokenConfig: OAuthTokenEndpointConfig = {
	tokenUrl: TOKEN_URL,
	clientId: "test-client-id",
	clientSecret: Redacted.make("test-client-secret"),
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Serve the token endpoint from a per-test handler; everything else 404s. */
const makeFetch =
	(handler: (body: URLSearchParams) => Response): typeof globalThis.fetch =>
	async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.startsWith(TOKEN_URL)) {
			const text = await new Response(init?.body ?? "").text()
			return handler(new URLSearchParams(text))
		}
		return jsonResponse({ error: "not_found" }, 404)
	}

const fetchLayer = (handler: (body: URLSearchParams) => Response) =>
	Layer.succeed(FetchHttpClient.Fetch, makeFetch(handler))

/**
 * Build the helpers directly (they are a factory, not a service) against the
 * test PGlite database, optionally through a wrapped `execute`.
 */
const makeHelpers = (wrapDatabase: (database: DatabaseApi) => DatabaseApi = (database) => database) =>
	Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		return yield* makeOAuthConnectionHelpers({
			provider: "test-provider",
			providerLabel: "TestProvider",
			database: wrapDatabase(database),
			env,
		})
	})

const provideBase = (testDb: TestDb, fetch: ReturnType<typeof fetchLayer>) =>
	Layer.mergeAll(
		testDb.layer,
		Env.layer.pipe(Layer.provide(configLive)),
		FetchHttpClient.layer.pipe(Layer.provide(fetch)),
	)

/** Seed an expired connection with a refresh token, so any token read must refresh. */
const seedExpiredConnection = (helpers: Effect.Success<ReturnType<typeof makeHelpers>>) =>
	Effect.gen(function* () {
		const accessEnc = yield* helpers.encryptValue("stale-access-token")
		const refreshEnc = yield* helpers.encryptValue("stored-refresh-token")
		yield* helpers.upsertConnection(ORG, Date.now(), {
			externalUserId: "ext-user-1",
			connectedByUserId: USER,
			accessTokenCiphertext: accessEnc.ciphertext,
			accessTokenIv: accessEnc.iv,
			accessTokenTag: accessEnc.tag,
			refreshTokenCiphertext: refreshEnc.ciphertext,
			refreshTokenIv: refreshEnc.iv,
			refreshTokenTag: refreshEnc.tag,
			// Already expired — getValidConnectionToken must refresh.
			expiresAt: new Date(Date.now() - 60_000),
		})
	})

const revokedAtOf = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ revoked_at: string | null }>(
			testDb,
			"SELECT revoked_at FROM oauth_connections WHERE org_id = $1",
			[ORG],
		),
	).pipe(Effect.map((row) => row?.revoked_at ?? null))

describe("refreshAccessToken classification", () => {
	it.live("a 400 invalid_grant is a revocation and stamps the connection revoked", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() => jsonResponse({ error: "invalid_grant" }, 400))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.isNotNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})

	it.live("a 400 invalid_client is an upstream failure and does NOT revoke the connection", () => {
		const testDb = createTestDb(trackedDbs)
		// A rotated/misconfigured Maple client secret answers this for EVERY
		// tenant at once — stamping revoked here would disconnect them all.
		const fetch = fetchLayer(() => jsonResponse({ error: "invalid_client" }, 400))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})

	it.live("a bodyless 401 is an upstream failure and does NOT revoke the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() => new Response("Unauthorized", { status: 401 }))
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const error = yield* helpers.getValidConnectionToken(tokenConfig, ORG).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.isNull(yield* revokedAtOf(testDb))
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})

describe("persistRefreshedTokens", () => {
	it.live("retries a transient persistence failure instead of losing the rotated tokens", () => {
		const testDb = createTestDb(trackedDbs)
		const fetch = fetchLayer(() =>
			jsonResponse({
				access_token: "fresh-access-token",
				refresh_token: "fresh-refresh-token",
				expires_in: 3600,
			}),
		)
		let failuresLeft = 2
		const flaky = (database: DatabaseApi): DatabaseApi => ({
			// Suspended so each retry re-evaluates the failure budget.
			execute: (fn) =>
				Effect.suspend(() => {
					if (failuresLeft > 0) {
						failuresLeft -= 1
						return Effect.fail(new DatabaseError({ message: "connection reset", cause: "boom" }))
					}
					return database.execute(fn)
				}),
		})
		return Effect.gen(function* () {
			const helpers = yield* makeHelpers()
			yield* seedExpiredConnection(helpers)
			const row = yield* helpers.requireConnection(ORG)

			// From here every execute goes through the flaky wrapper: the refresh
			// succeeded upstream (the old refresh token is now dead), so the write
			// must survive a transient blip.
			const flakyHelpers = yield* makeHelpers(flaky)
			const refreshed = yield* flakyHelpers.refreshAccessToken(tokenConfig, "stored-refresh-token")
			const accessToken = yield* flakyHelpers.persistRefreshedTokens(row, refreshed)

			assert.strictEqual(accessToken, "fresh-access-token")
			assert.strictEqual(failuresLeft, 0)
			const persisted = yield* helpers.getValidConnectionToken(tokenConfig, ORG)
			assert.strictEqual(persisted.accessToken, "fresh-access-token")
		}).pipe(Effect.provide(provideBase(testDb, fetch)))
	})
})
