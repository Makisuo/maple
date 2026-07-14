import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { PlanetScaleOAuthService } from "./PlanetScaleOAuthService"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "../lib/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface MockOptions {
	readonly organizations?: ReadonlyArray<{ id: string; name: string }>
	/** Omit the refresh token from the exchange response (doomed-grant refusal). */
	readonly withoutRefreshToken?: boolean
	/** `/v1/user` responds 403 (outside the app's scopes) → externalUserId falls back. */
	readonly userForbidden?: boolean
	readonly counters?: { refreshes: number }
	/** After the first refresh, subsequent refreshes 400 (rotated refresh token). */
	readonly refreshOnce?: boolean
	/** Every refresh 400s — the grant is genuinely gone. */
	readonly refreshAlwaysFails?: boolean
	/** Exchange returns an immediately-expiring access token (forces refresh on first use). */
	readonly shortLivedAccessToken?: boolean
	/** First N `/v1/organizations` calls answer 401 `invalid_token` (doorkeeper body). */
	readonly organizationsUnauthorizedTimes?: number
	/**
	 * `/oauth/token/info` verdict (doorkeeper semantics: valid → 200 with token
	 * details, invalid → 401); omitted → 500 (introspection unavailable).
	 */
	readonly introspection?: "valid" | "invalid"
}

/**
 * A `fetch` serving the PlanetScale OAuth token endpoint plus the `/v1/user` and
 * `/v1/organizations` management calls from fixtures, provided per-test via the
 * `FetchHttpClient.Fetch` reference (same isolation pattern as the Cloudflare
 * OAuth tests).
 */
const mockPlanetScaleFetch = (options: MockOptions = {}): typeof globalThis.fetch => {
	let orgRejectionsRemaining = options.organizationsUnauthorizedTimes ?? 0
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const organizations = options.organizations ?? [{ id: "psorg_1", name: "acme" }]
		// Must precede the token-endpoint match — "/oauth/token/info" contains "/oauth/token".
		if (url.includes("/oauth/token/info")) {
			if (!options.introspection) {
				return jsonResponse({ code: "internal" }, 500)
			}
			if (options.introspection === "invalid") {
				return jsonResponse(
					{ error: "invalid_token", error_description: "The access token is invalid" },
					401,
				)
			}
			// Doorkeeper answers a valid token with its details — no `active` field.
			return jsonResponse({
				resource_owner_id: "psuser_1",
				scope: ["user:read_organizations"],
				expires_in: 2_629_746,
				application: { uid: "ps-client-id" },
			})
		}
		if (url.includes("/oauth/token")) {
			const text = await new Request(url, {
				method: "POST",
				body: init?.body,
				// @ts-expect-error duplex is required for streaming bodies in undici/Bun
				duplex: "half",
			}).text()
			const body = new URLSearchParams(text)
			if (body.get("grant_type") === "refresh_token") {
				if (options.counters) options.counters.refreshes += 1
				const refreshes = options.counters?.refreshes ?? 1
				if (options.refreshAlwaysFails || (options.refreshOnce && refreshes > 1)) {
					return jsonResponse({ error: "invalid_grant" }, 400)
				}
				return jsonResponse({
					access_token: "ps-access-token-refreshed",
					refresh_token: "ps-refresh-token-rotated",
					token_type: "Bearer",
					expires_in: 3600,
				})
			}
			// A malformed exchange fails as an upstream 400 (readable at the test
			// site) instead of asserting inside the fetch stub, where a throw would
			// surface as an opaque mapped HTTP error.
			if (
				body.get("grant_type") !== "authorization_code" ||
				body.get("client_id") !== "ps-client-id" ||
				body.get("client_secret") !== "ps-client-secret"
			) {
				return jsonResponse({ error: "unexpected_token_exchange_request" }, 400)
			}
			return jsonResponse({
				access_token: "ps-access-token",
				token_type: "Bearer",
				expires_in: options.shortLivedAccessToken ? 1 : 3600,
				scope: "read_organization read_databases read_metrics_endpoints",
				...(options.withoutRefreshToken ? {} : { refresh_token: "ps-refresh-token" }),
			})
		}
		if (url.includes("/v1/user")) {
			if (options.userForbidden) {
				return jsonResponse({ code: "forbidden" }, 403)
			}
			return jsonResponse({ id: "psuser_1", email: "dev@acme.test" })
		}
		if (url.includes("/v1/organizations")) {
			if (orgRejectionsRemaining > 0) {
				orgRejectionsRemaining -= 1
				return jsonResponse(
					{
						error: "invalid_token",
						error_description: "The access token is invalid",
						state: "unauthorized",
					},
					401,
				)
			}
			return jsonResponse({ data: organizations })
		}
		return jsonResponse({ code: "not_found" }, 404)
	}
}

const withMockFetch = (options: MockOptions = {}) =>
	Layer.succeed(FetchHttpClient.Fetch, mockPlanetScaleFetch(options))

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

const makeConfig = (extra: Record<string, string> = {}) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfig, ...extra }))

const makeLayer = (testDb: TestDb, extra: Record<string, string> = {}) =>
	PlanetScaleOAuthService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(extra)),
	)

const withOAuthApp = {
	PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id",
	PLANETSCALE_OAUTH_CLIENT_SECRET: "ps-client-secret",
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const CALLBACK_URL = "https://api.example.com/api/integrations/planetscale/callback"

describe("PlanetScaleOAuthService", () => {
	it.effect("startConnect fails when the OAuth app is not configured", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const error = yield* service
				.startConnect(asOrgId("org_a"), asUserId("user_a"), { callbackUrl: CALLBACK_URL })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("startConnect requires the client secret (confidential client)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const error = yield* service
				.startConnect(asOrgId("org_a"), asUserId("user_a"), { callbackUrl: CALLBACK_URL })
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			if (error._tag === "@maple/http/errors/IntegrationsValidationError") {
				assert.include(error.message, "PLANETSCALE_OAUTH_CLIENT_SECRET")
			}
		}).pipe(Effect.provide(makeLayer(testDb, { PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id" })))
	})

	it.effect("startConnect builds an authorize URL with the requested scope (no PKCE) and persists a state row", () => {
		const testDb = createTestDb(trackedDbs)
		// PlanetScale REQUIRES the scope param — the app's configured scopes are the
		// allowed maximum, not an implicit default; omitting it fails with `invalid_scope`.
		const scopes = "user:read_organizations organization:read_databases organization:read_branches"
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { redirectUrl, state } = yield* service.startConnect(
				asOrgId("org_a"),
				asUserId("user_a"),
				{ callbackUrl: CALLBACK_URL, returnTo: "/integrations" },
			)

			const url = new URL(redirectUrl)
			// The canonical authorize host from PlanetScale's OAuth discovery doc —
			// the auth.planetscale.com alias mints tokens the v1 API rejects.
			assert.strictEqual(url.origin + url.pathname, "https://app.planetscale.com/oauth/authorize")
			assert.strictEqual(url.searchParams.get("client_id"), "ps-client-id")
			assert.strictEqual(url.searchParams.get("redirect_uri"), CALLBACK_URL)
			assert.strictEqual(url.searchParams.get("response_type"), "code")
			assert.strictEqual(url.searchParams.get("state"), state)
			// Resource-prefixed, space-delimited scopes; PKCE is not part of PlanetScale's flow.
			assert.strictEqual(url.searchParams.get("scope"), scopes)
			assert.isNull(url.searchParams.get("code_challenge"))

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ org_id: string; provider: string; return_to: string | null }>(
					testDb,
					"SELECT org_id, provider, return_to FROM oauth_auth_states WHERE state = $1",
					[state],
				),
			)
			assert.strictEqual(row?.org_id, "org_a")
			assert.strictEqual(row?.provider, "planetscale")
			assert.strictEqual(row?.return_to, "/integrations")
		}).pipe(Effect.provide(makeLayer(testDb, { ...withOAuthApp, PLANETSCALE_OAUTH_SCOPES: scopes })))
	})

	it.effect("completeConnect exchanges the code, stores the grant, and returns the orgs", () => {
		const testDb = createTestDb(trackedDbs)
		const organizations = [
			{ id: "psorg_1", name: "acme" },
			{ id: "psorg_2", name: "beta" },
		]
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			const result = yield* service.completeConnect("auth-code", state)
			assert.strictEqual(result.orgId, "org_a")
			assert.deepStrictEqual(
				result.organizations.map((org) => org.name),
				["acme", "beta"],
			)

			assert.isTrue(yield* service.hasConnection(asOrgId("org_a")))
			assert.strictEqual(yield* service.connectedByUserId(asOrgId("org_a")), "user_a")

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					external_user_id: string
					external_user_email: string | null
					access_token_ciphertext: string
					refresh_token_ciphertext: string | null
				}>(
					testDb,
					"SELECT external_user_id, external_user_email, access_token_ciphertext, refresh_token_ciphertext FROM oauth_connections WHERE org_id = $1 AND provider = 'planetscale'",
					["org_a"],
				),
			)
			assert.strictEqual(row?.external_user_id, "psuser_1")
			assert.strictEqual(row?.external_user_email, "dev@acme.test")
			// Tokens are encrypted at rest, never stored verbatim.
			assert.isTrue(!!row && row.access_token_ciphertext !== "ps-access-token")
			assert.isTrue(!!row && !!row.refresh_token_ciphertext)
		}).pipe(
			Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch({ organizations }))),
		)
	})

	it.effect("completeConnect falls back to the first org id when /v1/user is out of scope", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ external_user_id: string }>(
					testDb,
					"SELECT external_user_id FROM oauth_connections WHERE org_id = $1 AND provider = 'planetscale'",
					["org_a"],
				),
			)
			assert.strictEqual(row?.external_user_id, "psorg_1")
		}).pipe(
			Effect.provide(
				Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch({ userForbidden: true })),
			),
		)
	})

	it.effect("completeConnect rejects an unknown or expired state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const error = yield* service
				.completeConnect("auth-code", "state-that-was-never-issued")
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch())))
	})

	it.effect("completeConnect rejects a state after its TTL", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* TestClock.adjust("11 minutes")

			const error = yield* service.completeConnect("auth-code", state).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			assert.include(error.message, "expired")
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch())))
	})

	it.effect("completeConnect refuses a grant with no refresh token", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			const error = yield* service.completeConnect("auth-code", state).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			if (error._tag === "@maple/http/errors/IntegrationsValidationError") {
				assert.include(error.message, "refresh token")
			}
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch({ withoutRefreshToken: true })),
			),
		)
	})

	it.effect("completeConnect retries the org listing once when the API rejects the fresh token", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			// The first listing 401s (auth→API propagation lag); the retry after the
			// 2s backoff succeeds and the connect completes normally.
			const fiber = yield* Effect.forkChild(service.completeConnect("auth-code", state), {
				startImmediately: true,
			})
			yield* TestClock.adjust("2 seconds")
			const result = yield* Fiber.join(fiber)
			assert.strictEqual(result.orgId, "org_a")
			assert.isTrue(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					withMockFetch({ organizationsUnauthorizedTimes: 1 }),
				),
			),
		)
	})

	it.effect("completeConnect stays revoked when the auth server also reports the token dead", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			const fiber = yield* Effect.forkChild(
				service.completeConnect("auth-code", state).pipe(Effect.flip),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("2 seconds")
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					withMockFetch({ organizationsUnauthorizedTimes: 2, introspection: "invalid" }),
				),
			),
		)
	})

	it.effect("completeConnect reports upstream (not revoked) when the auth server says the token is valid", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			// The v1 API keeps rejecting a token the auth server introspects as
			// active — "reconnect" would be a lie, so this must NOT be RevokedError.
			const fiber = yield* Effect.forkChild(
				service.completeConnect("auth-code", state).pipe(Effect.flip),
				{ startImmediately: true },
			)
			yield* TestClock.adjust("2 seconds")
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			if (error._tag === "@maple/http/errors/IntegrationsUpstreamError") {
				assert.include(error.message, "auth server reports it as valid")
			}
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					withMockFetch({ organizationsUnauthorizedTimes: 2, introspection: "valid" }),
				),
			),
		)
	})

	it.effect("completeConnect refuses a grant that reaches no organizations", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			const error = yield* service.completeConnect("auth-code", state).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			if (error._tag === "@maple/http/errors/IntegrationsValidationError") {
				assert.include(error.message, "no organizations")
			}
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))
		}).pipe(
			Effect.provide(
				Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch({ organizations: [] })),
			),
		)
	})

	it.effect("listOrganizations uses the stored grant", () => {
		const testDb = createTestDb(trackedDbs)
		const organizations = [
			{ id: "psorg_1", name: "acme" },
			{ id: "psorg_2", name: "beta" },
		]
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)
			const listed = yield* service.listOrganizations(asOrgId("org_a"))
			assert.deepStrictEqual(
				listed.map((org) => org.name),
				["acme", "beta"],
			)
		}).pipe(
			Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch({ organizations }))),
		)
	})

	it.effect("listOrganizations surfaces a dead grant as revoked (org-picker reconnect CTA)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)

			// The grant dies upstream: the org listing starts answering 401. That
			// must surface as revoked, not a generic upstream failure — the picker
			// keys its reconnect CTA on the tag.
			const deadGrantFetch: typeof globalThis.fetch = async (input, init) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url
				if (url.includes("/v1/organizations")) {
					return jsonResponse({ code: "unauthorized" }, 401)
				}
				return mockPlanetScaleFetch()(input, init)
			}
			const error = yield* service
				.listOrganizations(asOrgId("org_a"))
				.pipe(Effect.provideService(FetchHttpClient.Fetch, deadGrantFetch), Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch())))
	})

	it.effect("listOrganizations fails not-connected without a stored grant", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const error = yield* service.listOrganizations(asOrgId("org_a")).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotConnectedError")
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch())))
	})

	it.effect("concurrent getValidAccessToken refreshes once (single-flight, no false revoke)", () => {
		const testDb = createTestDb(trackedDbs)
		const counters = { refreshes: 0 }
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)

			// Two racers on an expired token: without single-flight both refresh, the
			// loser's rotated-token 400 falsely surfaces as IntegrationsRevokedError.
			const [a, b] = yield* Effect.all(
				[service.getValidAccessToken(asOrgId("org_a")), service.getValidAccessToken(asOrgId("org_a"))],
				{ concurrency: 2 },
			)
			assert.strictEqual(a.accessToken, "ps-access-token-refreshed")
			assert.strictEqual(b.accessToken, "ps-access-token-refreshed")
			assert.strictEqual(counters.refreshes, 1)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					withMockFetch({ shortLivedAccessToken: true, refreshOnce: true, counters }),
				),
			),
		)
	})

	it.effect("a refresh the token endpoint rejects with 400 surfaces as revoked", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)

			const error = yield* service.getValidAccessToken(asOrgId("org_a")).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					withMockFetch({ shortLivedAccessToken: true, refreshAlwaysFails: true }),
				),
			),
		)
	})

	it.effect("disconnect removes the grant; disconnecting a fresh org reports nothing removed", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* PlanetScaleOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: CALLBACK_URL,
			})
			yield* service.completeConnect("auth-code", state)

			const result = yield* service.disconnect(asOrgId("org_a"))
			assert.strictEqual(result.disconnected, true)
			assert.isFalse(yield* service.hasConnection(asOrgId("org_a")))

			const again = yield* service.disconnect(asOrgId("org_a"))
			assert.strictEqual(again.disconnected, false)
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch())))
	})
})
