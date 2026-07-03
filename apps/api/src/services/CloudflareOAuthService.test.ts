import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { CloudflareOAuthService } from "./CloudflareOAuthService"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "../lib/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * A `fetch` implementation, provided per-test via the `FetchHttpClient.Fetch` reference, that serves
 * both the OAuth token exchange and the distilled `listAccounts` call from fixtures. Providing it
 * through Effect context (rather than stubbing the global) keeps each test's fixture isolated.
 * `accounts` drives single-account enforcement.
 */
const mockCloudflareFetch =
	(
		accounts: ReadonlyArray<{ id: string; name: string; type: string }>,
		counters?: { revoked: number },
	): typeof globalThis.fetch =>
	(input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.includes("/oauth2/revoke")) {
			if (counters) counters.revoked += 1
			return Promise.resolve(new Response(null, { status: 200 }))
		}
		if (url.includes("/oauth2/token")) {
			return Promise.resolve(
				jsonResponse({
					access_token: "cf-access-token",
					refresh_token: "cf-refresh-token",
					token_type: "bearer",
					expires_in: 3600,
					scope: "account.settings:read workers_observability:write",
				}),
			)
		}
		if (url.includes("/accounts")) {
			return Promise.resolve(
				jsonResponse({
					success: true,
					errors: [],
					messages: [],
					result: accounts,
					result_info: { count: accounts.length, page: 1, per_page: 50, total_count: accounts.length },
				}),
			)
		}
		return Promise.resolve(jsonResponse({ success: false, errors: [], messages: [], result: null }, 404))
	}

const withMockFetch = (
	accounts: ReadonlyArray<{ id: string; name: string; type: string }>,
	counters?: { revoked: number },
) => Layer.succeed(FetchHttpClient.Fetch, mockCloudflareFetch(accounts, counters))

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
	CloudflareOAuthService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(extra)),
	)

const withOAuthApp = {
	CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id",
	CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-client-secret",
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

describe("CloudflareOAuthService", () => {
	it.effect("reports not-connected for a fresh org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const status = yield* service.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.connected, false)
		}).pipe(Effect.provide(makeLayer(testDb, withOAuthApp)))
	})

	it.effect("startConnect fails when the OAuth app is not configured", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const error = yield* service
				.startConnect(asOrgId("org_a"), asUserId("user_a"), {
					callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
				})
				.pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("startConnect builds an authorize URL and persists a state row", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { redirectUrl, state } = yield* service.startConnect(
				asOrgId("org_a"),
				asUserId("user_a"),
				{ callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback" },
			)

			const url = new URL(redirectUrl)
			assert.strictEqual(url.origin + url.pathname, "https://dash.cloudflare.com/oauth2/auth")
			assert.strictEqual(url.searchParams.get("client_id"), "cf-client-id")
			assert.strictEqual(url.searchParams.get("response_type"), "code")
			assert.strictEqual(url.searchParams.get("state"), state)
			assert.include(url.searchParams.get("scope") ?? "", "workers-observability.write")
			// PKCE: the authorize URL carries an S256 challenge and the verifier is persisted.
			assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")
			const challenge = url.searchParams.get("code_challenge")
			assert.isTrue(typeof challenge === "string" && challenge.length > 0)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ org_id: string; provider: string; code_verifier: string | null }>(
					testDb,
					"SELECT org_id, provider, code_verifier FROM oauth_auth_states WHERE state = $1",
					[state],
				),
			)
			assert.strictEqual(row?.org_id, "org_a")
			assert.strictEqual(row?.provider, "cloudflare")
			assert.isTrue(typeof row?.code_verifier === "string" && row.code_verifier.length > 0)
		}).pipe(Effect.provide(makeLayer(testDb, withOAuthApp)))
	})

	it.effect("startConnect works for a public client (client id only, no secret)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { redirectUrl } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			const url = new URL(redirectUrl)
			assert.strictEqual(url.searchParams.get("client_id"), "cf-client-id")
			assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")
		}).pipe(
			// Only the client id is set — a Cloudflare public client carries no secret.
			Effect.provide(makeLayer(testDb, { CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client-id" })),
		)
	})

	it.effect("completeConnect exchanges the code and stores a single-account connection", () => {
		const testDb = createTestDb(trackedDbs)
		const accounts = [{ id: "acc_1", name: "Acme Inc", type: "standard" }]
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			// Seed a state row via the real startConnect (writes the PKCE verifier), then complete.
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			const result = yield* service.completeConnect("auth-code", state)
			assert.strictEqual(result.orgId, "org_a")

			const status = yield* service.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.connected, true)
			if (status.connected) {
				assert.strictEqual(status.accountId, "acc_1")
				assert.strictEqual(status.accountName, "Acme Inc")
			}

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					external_user_id: string
					external_account_name: string | null
					external_user_email: string | null
					access_token_ciphertext: string
				}>(
					testDb,
					"SELECT external_user_id, external_account_name, external_user_email, access_token_ciphertext FROM oauth_connections WHERE org_id = $1 AND provider = 'cloudflare'",
					["org_a"],
				),
			)
			assert.strictEqual(row?.external_user_id, "acc_1")
			// Account name lives in the dedicated column; the email column stays null (CF has no email).
			assert.strictEqual(row?.external_account_name, "Acme Inc")
			assert.strictEqual(row?.external_user_email, null)
			// Token is encrypted at rest, never stored verbatim.
			assert.isTrue(!!row && row.access_token_ciphertext !== "cf-access-token")
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch(accounts))))
	})

	it.effect("completeConnect rejects an unknown or expired state", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			// No state row was ever seeded — a forged/expired-and-purged callback.
			const error = yield* service.completeConnect("auth-code", "state-that-was-never-issued").pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			if (error._tag === "@maple/http/errors/IntegrationsValidationError") {
				assert.include(error.message, "OAuth state not recognized")
			}
			// Nothing was connected as a side effect.
			const status = yield* service.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.connected, false)
		}).pipe(Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch([]))))
	})

	it.effect("completeConnect rejects a token that spans multiple accounts and revokes it", () => {
		const testDb = createTestDb(trackedDbs)
		const accounts = [
			{ id: "acc_1", name: "Acme Inc", type: "standard" },
			{ id: "acc_2", name: "Beta LLC", type: "standard" },
		]
		const counters = { revoked: 0 }
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			const error = yield* service.completeConnect("auth-code", state).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")

			const status = yield* service.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.connected, false)
			// The rejected token is never stored, so it must be revoked upstream right away.
			assert.strictEqual(counters.revoked, 1)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch(accounts, counters)),
			),
		)
	})

	it.effect("concurrent getValidAccessToken refreshes once (single-flight, no false revoke)", () => {
		const testDb = createTestDb(trackedDbs)
		const counters = { refreshes: 0 }
		// authorization_code → immediately-expiring token (forces refresh on first use);
		// refresh_token → succeeds ONCE, then 400s (Cloudflare rotates refresh tokens on use).
		const fetchImpl: typeof globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (url.includes("/oauth2/token")) {
				// The body may arrive as a stream — normalize through Request to read it.
				const text = await new Request(url, {
					method: "POST",
					body: init?.body,
					// @ts-expect-error duplex is required for streaming bodies in undici/Bun
					duplex: "half",
				}).text()
				const body = new URLSearchParams(text)
				if (body.get("grant_type") === "refresh_token") {
					counters.refreshes += 1
					if (counters.refreshes > 1) {
						return jsonResponse({ error: "invalid_grant" }, 400)
					}
					return jsonResponse({
						access_token: "cf-access-token-refreshed",
						refresh_token: "cf-refresh-token-rotated",
						token_type: "bearer",
						expires_in: 3600,
					})
				}
				return jsonResponse({
					access_token: "cf-access-token-initial",
					refresh_token: "cf-refresh-token",
					token_type: "bearer",
					// Within the 60s refresh leeway → the very next getValidAccessToken refreshes.
					expires_in: 1,
				})
			}
			if (url.includes("/accounts")) {
				return jsonResponse({
					success: true,
					errors: [],
					messages: [],
					result: [{ id: "acc_1", name: "Acme Inc", type: "standard" }],
					result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
				})
			}
			return jsonResponse({ success: false, errors: [], messages: [], result: null }, 404)
		}

		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			yield* service.completeConnect("auth-code", state)

			// Two racers on an expired token: without single-flight both refresh, the loser's
			// rotated-token 400 falsely surfaces as IntegrationsRevokedError.
			const [a, b] = yield* Effect.all(
				[service.getValidAccessToken(asOrgId("org_a")), service.getValidAccessToken(asOrgId("org_a"))],
				{ concurrency: 2 },
			)
			assert.strictEqual(a.accessToken, "cf-access-token-refreshed")
			assert.strictEqual(b.accessToken, "cf-access-token-refreshed")
			assert.strictEqual(counters.refreshes, 1)
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					Layer.succeed(FetchHttpClient.Fetch, fetchImpl),
				),
			),
		)
	})

	it.effect("a refresh the token endpoint rejects with 400 surfaces as revoked", () => {
		const testDb = createTestDb(trackedDbs)
		// authorization_code → immediately-expiring token; refresh_token → always 400
		// (the grant is genuinely gone — no concurrency, no rotated-token race).
		const fetchImpl: typeof globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (url.includes("/oauth2/token")) {
				const text = await new Request(url, {
					method: "POST",
					body: init?.body,
					// @ts-expect-error duplex is required for streaming bodies in undici/Bun
					duplex: "half",
				}).text()
				const body = new URLSearchParams(text)
				if (body.get("grant_type") === "refresh_token") {
					return jsonResponse({ error: "invalid_grant" }, 400)
				}
				return jsonResponse({
					access_token: "cf-access-token-initial",
					refresh_token: "cf-refresh-token",
					token_type: "bearer",
					// Within the 60s refresh leeway → the very next getValidAccessToken refreshes.
					expires_in: 1,
				})
			}
			if (url.includes("/accounts")) {
				return jsonResponse({
					success: true,
					errors: [],
					messages: [],
					result: [{ id: "acc_1", name: "Acme Inc", type: "standard" }],
					result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
				})
			}
			return jsonResponse({ success: false, errors: [], messages: [], result: null }, 404)
		}

		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			yield* service.completeConnect("auth-code", state)

			const error = yield* service.getValidAccessToken(asOrgId("org_a")).pipe(Effect.flip)
			// 400/401 on the refresh grant means the grant itself is gone — classified as
			// revoked (reconnect required), not a transient upstream failure.
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsRevokedError")
			if (error._tag === "@maple/http/errors/IntegrationsRevokedError") {
				assert.include(error.message, "reconnect")
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeLayer(testDb, withOAuthApp),
					Layer.succeed(FetchHttpClient.Fetch, fetchImpl),
				),
			),
		)
	})

	it.effect("disconnect on a connected org revokes upstream and removes the row", () => {
		const testDb = createTestDb(trackedDbs)
		const accounts = [{ id: "acc_1", name: "Acme Inc", type: "standard" }]
		const counters = { revoked: 0 }
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const { state } = yield* service.startConnect(asOrgId("org_a"), asUserId("user_a"), {
				callbackUrl: "https://api.example.com/api/integrations/cloudflare/callback",
			})
			yield* service.completeConnect("auth-code", state)

			const result = yield* service.disconnect(asOrgId("org_a"))
			assert.strictEqual(result.disconnected, true)
			// The stored access token was best-effort revoked upstream before the row dropped.
			assert.strictEqual(counters.revoked, 1)

			const status = yield* service.getStatus(asOrgId("org_a"))
			assert.strictEqual(status.connected, false)
			const row = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(
					testDb,
					"SELECT id FROM oauth_connections WHERE org_id = $1 AND provider = 'cloudflare'",
					["org_a"],
				),
			)
			assert.isUndefined(row)
		}).pipe(
			Effect.provide(Layer.mergeAll(makeLayer(testDb, withOAuthApp), withMockFetch(accounts, counters))),
		)
	})

	it.effect("disconnect on a non-connected org reports nothing removed", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* CloudflareOAuthService
			const result = yield* service.disconnect(asOrgId("org_a"))
			assert.strictEqual(result.disconnected, false)
		}).pipe(Effect.provide(makeLayer(testDb, withOAuthApp)))
	})
})
