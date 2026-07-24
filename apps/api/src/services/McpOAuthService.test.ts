import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { Env } from "../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../lib/test-pglite"
import { ApiKeysService } from "./ApiKeysService"
import { AuthService } from "./AuthService"
import { matchesMcpOAuthRedirectUri, McpOAuthService, validateMcpOAuthRedirectUri } from "./McpOAuthService"
import { resolveMcpTenantContext } from "../mcp/lib/resolve-tenant"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	const auth = AuthService.layer.pipe(Layer.provide(base))
	return Layer.mergeAll(McpOAuthService.layer.pipe(Layer.provide(base)), apiKeys, auth, base)
}

const orgId = Schema.decodeUnknownSync(OrgId)("org_mcp")
const userId = Schema.decodeUnknownSync(UserId)("user_mcp")
const memberRole = Schema.decodeUnknownSync(RoleName)("org:member")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

describe("McpOAuthService", () => {
	it("accepts HTTPS and loopback redirects while rejecting unsafe redirects", () => {
		expect(validateMcpOAuthRedirectUri("https://client.example.com/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://localhost:9876/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://127.0.0.1:9876/callback")).toBe(true)
		expect(validateMcpOAuthRedirectUri("http://client.example.com/callback")).toBe(false)
		expect(validateMcpOAuthRedirectUri("https://client.example.com/callback#fragment")).toBe(false)
	})

	it("matches loopback redirects with any port while preserving every other component", () => {
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com/callback",
				"https://client.example.com/callback",
			),
		).toBe(true)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback/server-id?source=codex",
				"http://localhost:51789/callback/server-id?source=codex",
			),
		).toBe(true)
		expect(
			matchesMcpOAuthRedirectUri("http://127.0.0.1:49152/callback", "http://127.0.0.1:51789/callback"),
		).toBe(true)
		expect(matchesMcpOAuthRedirectUri("http://[::1]:49152/callback", "http://[::1]:51789/callback")).toBe(
			true,
		)

		expect(
			matchesMcpOAuthRedirectUri("http://localhost:49152/callback", "http://127.0.0.1:51789/callback"),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback/server-id",
				"http://localhost:51789/callback/other-id",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://localhost:49152/callback?source=codex",
				"http://localhost:51789/callback?source=claude",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri("http://localhost:49152/callback", "https://localhost:51789/callback"),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com:49152/callback",
				"https://client.example.com:51789/callback",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"https://client.example.com/callback#fragment",
				"https://client.example.com/callback#fragment",
			),
		).toBe(false)
		expect(
			matchesMcpOAuthRedirectUri(
				"http://user@localhost:49152/callback",
				"http://user@localhost:49152/callback",
			),
		).toBe(false)
	})

	it.effect("issues a role-pinned, audience-bound token through authorization code + PKCE", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const authorizationRedirectUri = "http://127.0.0.1:51789/callback"
			const client = yield* oauth.register(
				{ clientName: "Test MCP Client", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri: authorizationRedirectUri,
					responseType: "code",
					state: "client-state",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					scope: "mcp:tools",
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")
			expect(requestId).toBeTruthy()
			const inspected = yield* oauth.inspect(requestId!)
			expect(inspected.clientName).toBe("Test MCP Client")
			expect(inspected.status).toBe("pending")

			const approved = yield* oauth.approve(requestId!, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: "member@example.com",
			})
			const callback = new URL(approved.redirectUri)
			expect(callback.origin + callback.pathname).toBe(authorizationRedirectUri)
			expect(callback.searchParams.get("state")).toBe("client-state")
			const code = callback.searchParams.get("code")!
			const wrongRedirect = yield* oauth
				.exchangeAuthorizationCode(
					{ code, clientId: client.client_id, redirectUri, codeVerifier: verifier, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(wrongRedirect._tag).toBe("@maple/api/errors/McpOAuthProtocolError")
			if (wrongRedirect._tag === "@maple/api/errors/McpOAuthProtocolError") {
				expect(wrongRedirect.error).toBe("invalid_grant")
			}
			const tokens = yield* oauth.exchangeAuthorizationCode(
				{
					code,
					clientId: client.client_id,
					redirectUri: authorizationRedirectUri,
					codeVerifier: verifier,
					resource,
				},
				"127.0.0.1",
			)
			expect(tokens.token_type).toBe("Bearer")
			expect(tokens.scope).toBe("mcp:tools")
			expect(tokens.expires_in).toBe(3600)

			const resolved = yield* apiKeys.resolveByKey(tokens.access_token)
			expect(Option.isSome(resolved)).toBe(true)
			if (Option.isSome(resolved)) {
				expect(resolved.value.kind).toBe("mcp")
				expect(resolved.value.roles).toEqual([memberRole])
				expect(resolved.value.scopes).toEqual(["mcp:tools"])
				expect(resolved.value.mcpOAuthResource).toBe(resource)
			}
			const tenant = yield* resolveMcpTenantContext(
				new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
			)
			expect(tenant.orgId).toBe(orgId)
			expect(tenant.roles).toEqual([memberRole])
			const wrongAudience = yield* resolveMcpTenantContext(
				new Request("https://other.example.com/mcp", {
					headers: { authorization: `Bearer ${tokens.access_token}` },
				}),
			).pipe(Effect.flip)
			expect(wrongAudience._tag).toBe("@maple/mcp/errors/McpAuthInvalidError")
			if (wrongAudience._tag === "@maple/mcp/errors/McpAuthInvalidError") {
				expect(wrongAudience.reason).toBe("invalid_target")
			}

			const reused = yield* oauth
				.exchangeAuthorizationCode(
					{
						code,
						clientId: client.client_id,
						redirectUri: authorizationRedirectUri,
						codeVerifier: verifier,
						resource,
					},
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(reused._tag).toBe("@maple/api/errors/McpOAuthProtocolError")
			if (reused._tag === "@maple/api/errors/McpOAuthProtocolError") {
				expect(reused.error).toBe("invalid_grant")
			}
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("rotates refresh tokens and revokes the family when an old token is replayed", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService
			const client = yield* oauth.register(
				{ clientName: "Refresh Test", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri,
					responseType: "code",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
			const approved = yield* oauth.approve(requestId, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: null,
			})
			const first = yield* oauth.exchangeAuthorizationCode(
				{
					code: new URL(approved.redirectUri).searchParams.get("code")!,
					clientId: client.client_id,
					redirectUri,
					codeVerifier: verifier,
					resource,
				},
				"127.0.0.1",
			)
			const second = yield* oauth.refresh(
				{ refreshToken: first.refresh_token, clientId: client.client_id, resource },
				"127.0.0.1",
			)
			expect(Option.isNone(yield* apiKeys.resolveByKey(first.access_token))).toBe(true)
			expect(Option.isSome(yield* apiKeys.resolveByKey(second.access_token))).toBe(true)

			const replay = yield* oauth
				.refresh(
					{ refreshToken: first.refresh_token, clientId: client.client_id, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			if (replay._tag === "@maple/api/errors/McpOAuthProtocolError") {
				expect(replay.error).toBe("invalid_grant")
			}
			expect(Option.isNone(yield* apiKeys.resolveByKey(second.access_token))).toBe(true)
		}).pipe(Effect.provide(makeLayer(db)))
	})

	it.effect("returns an OAuth denial to the exact registered redirect and prevents later approval", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const oauth = yield* McpOAuthService
			const client = yield* oauth.register(
				{ clientName: "Denied Client", redirectUris: [redirectUri] },
				"127.0.0.1",
			)
			const started = yield* oauth.startAuthorization(
				{
					clientId: client.client_id,
					redirectUri,
					responseType: "code",
					state: "denial-state",
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					resource,
					expectedResource: resource,
				},
				"127.0.0.1",
			)
			const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
			const denied = yield* oauth.deny(requestId)
			const callback = new URL(denied.redirectUri)
			expect(callback.origin + callback.pathname).toBe(redirectUri)
			expect(callback.searchParams.get("error")).toBe("access_denied")
			expect(callback.searchParams.get("state")).toBe("denial-state")
			expect((yield* oauth.inspect(requestId)).status).toBe("denied")
			const conflict = yield* oauth
				.approve(requestId, { orgId, userId, roles: [memberRole], userEmail: null })
				.pipe(Effect.flip)
			expect(conflict._tag).toBe("@maple/http/errors/McpOAuthAuthorizationConflictError")
		}).pipe(Effect.provide(makeLayer(db)))
	})
})
