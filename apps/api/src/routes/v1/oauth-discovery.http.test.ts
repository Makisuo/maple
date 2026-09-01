import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { McpOAuthService } from "@/services/auth/McpOAuthService"
import { OAuthDiscoveryRouter } from "./oauth-discovery.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			// Trailing slash on purpose: the router must normalize it away.
			MAPLE_API_BASE_URL: "https://api.example.com/",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeHarness = () => {
	const db = createTestDb(createdDbs)
	const base = Layer.mergeAll(db.layer, Env.layer.pipe(Layer.provide(testConfig())))
	// `provideMerge`, so the router can read the same `Env` the service was built
	// with — its canonical origin now comes from configuration.
	const service = McpOAuthService.layer.pipe(Layer.provideMerge(base))
	const routes = OAuthDiscoveryRouter.pipe(Layer.provideMerge(service))
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(service)
	return { handler, dispose, runtime }
}

const postJson = (url: string, body: unknown) =>
	new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			host: "api.example.com",
			"x-forwarded-proto": "https",
		},
		body: JSON.stringify(body),
	})

const postForm = (url: string, body: Record<string, string>) =>
	new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			host: "api.example.com",
			"x-forwarded-proto": "https",
		},
		body: new URLSearchParams(body),
	})

describe("MCP OAuth HTTP routes", () => {
	it("publishes native Maple authorization and protected-resource metadata", async () => {
		const harness = makeHarness()
		try {
			const authorization = await harness.handler(
				new Request("https://api.example.com/.well-known/oauth-authorization-server", {
					headers: { host: "api.example.com", "x-forwarded-proto": "https" },
				}),
				Context.empty() as never,
			)
			expect(authorization.status).toBe(200)
			expect(await authorization.json()).toMatchObject({
				issuer: "https://api.example.com",
				authorization_endpoint: "https://api.example.com/oauth/authorize",
				token_endpoint: "https://api.example.com/oauth/token",
				registration_endpoint: "https://api.example.com/register",
				code_challenge_methods_supported: ["S256"],
			})

			const resource = await harness.handler(
				new Request("https://api.example.com/.well-known/oauth-protected-resource/mcp", {
					headers: { host: "api.example.com", "x-forwarded-proto": "https" },
				}),
				Context.empty() as never,
			)
			expect(await resource.json()).toMatchObject({
				resource: "https://api.example.com/mcp",
				authorization_servers: ["https://api.example.com"],
				scopes_supported: ["mcp:tools"],
			})
		} finally {
			await harness.dispose()
			await harness.runtime.dispose()
		}
	})

	// These documents are publicly cacheable and tell clients where to send a Maple
	// bearer token, so a forged forwarded host must never reach them.
	it("builds issuer, endpoints and resource from config, not forwarded headers", async () => {
		const harness = makeHarness()
		const forged = {
			host: "attacker.example",
			"x-forwarded-host": "attacker.example",
			"x-forwarded-proto": "https",
		}
		try {
			const authorization = await harness.handler(
				new Request("https://api.example.com/.well-known/oauth-authorization-server/mcp", {
					headers: forged,
				}),
				Context.empty() as never,
			)
			const metadata = await authorization.json()
			expect(JSON.stringify(metadata)).not.toContain("attacker.example")
			expect(metadata).toMatchObject({
				issuer: "https://api.example.com",
				authorization_endpoint: "https://api.example.com/oauth/authorize",
				token_endpoint: "https://api.example.com/oauth/token",
				registration_endpoint: "https://api.example.com/register",
				revocation_endpoint: "https://api.example.com/oauth/revoke",
			})

			const resource = await harness.handler(
				new Request("https://api.example.com/.well-known/oauth-protected-resource", {
					headers: forged,
				}),
				Context.empty() as never,
			)
			const resourceMetadata = await resource.json()
			expect(JSON.stringify(resourceMetadata)).not.toContain("attacker.example")
			expect(resourceMetadata).toMatchObject({
				resource: "https://api.example.com/mcp",
				authorization_servers: ["https://api.example.com"],
			})
		} finally {
			await harness.dispose()
			await harness.runtime.dispose()
		}
	})

	// The resource indicator the token is bound to must be Maple's own identity,
	// so a forged host cannot make `/oauth/authorize` validate against itself.
	it("rejects an authorize whose resource follows a forged forwarded host", async () => {
		const harness = makeHarness()
		try {
			const registered = await harness.handler(
				postJson("https://api.example.com/register", {
					client_name: "Forged Host Client",
					redirect_uris: ["http://127.0.0.1:49876/callback"],
				}),
				Context.empty() as never,
			)
			const client = (await registered.json()) as { client_id: string }
			const verifier = "http-route-pkce-verifier-with-more-than-forty-three-characters"
			const authorizeUrl = new URL("https://api.example.com/oauth/authorize")
			authorizeUrl.search = new URLSearchParams({
				client_id: client.client_id,
				redirect_uri: "http://127.0.0.1:49876/callback",
				response_type: "code",
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				code_challenge_method: "S256",
				resource: "https://attacker.example/mcp",
				scope: "mcp:tools",
			}).toString()
			const authorize = await harness.handler(
				new Request(authorizeUrl, {
					headers: {
						host: "attacker.example",
						"x-forwarded-host": "attacker.example",
						"x-forwarded-proto": "https",
					},
				}),
				Context.empty() as never,
			)
			expect(authorize.status).toBe(302)
			const location = new URL(authorize.headers.get("location")!)
			expect(location.searchParams.get("error")).toBe("invalid_target")
		} finally {
			await harness.dispose()
			await harness.runtime.dispose()
		}
	})

	it("supports DCR with an ephemeral loopback port and a form-encoded PKCE token exchange", async () => {
		const harness = makeHarness()
		try {
			const registeredRedirectUri = "http://127.0.0.1:49876/callback"
			const authorizationRedirectUri = "http://127.0.0.1:51789/callback"
			const registered = await harness.handler(
				postJson("https://api.example.com/register", {
					client_name: "HTTP MCP Client",
					redirect_uris: [registeredRedirectUri],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
				}),
				Context.empty() as never,
			)
			expect(registered.status).toBe(201)
			const client = (await registered.json()) as { client_id: string }

			const verifier = "http-route-pkce-verifier-with-more-than-forty-three-characters"
			const challenge = createHash("sha256").update(verifier).digest("base64url")
			const authorizeUrl = new URL("https://api.example.com/oauth/authorize")
			authorizeUrl.search = new URLSearchParams({
				client_id: client.client_id,
				redirect_uri: authorizationRedirectUri,
				response_type: "code",
				state: "http-state",
				code_challenge: challenge,
				code_challenge_method: "S256",
				resource: "https://api.example.com/mcp",
				scope: "mcp:tools",
			}).toString()
			const authorize = await harness.handler(
				new Request(authorizeUrl, {
					headers: { host: "api.example.com", "x-forwarded-proto": "https" },
				}),
				Context.empty() as never,
			)
			expect(authorize.status).toBe(302)
			const consent = new URL(authorize.headers.get("location")!)
			expect(consent.origin + consent.pathname).toBe("https://app.example.com/mcp-authorize")
			const requestId = consent.searchParams.get("request_id")!

			const approved = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const oauth = yield* McpOAuthService
					return yield* oauth.approve(requestId, {
						orgId: Schema.decodeUnknownSync(OrgId)("org_http"),
						userId: Schema.decodeUnknownSync(UserId)("user_http"),
						roles: [Schema.decodeUnknownSync(RoleName)("org:member")],
						userEmail: null,
					})
				}),
			)
			const code = new URL(approved.redirectUri).searchParams.get("code")!
			const token = await harness.handler(
				postForm("https://api.example.com/oauth/token", {
					grant_type: "authorization_code",
					client_id: client.client_id,
					redirect_uri: authorizationRedirectUri,
					code,
					code_verifier: verifier,
					resource: "https://api.example.com/mcp",
				}),
				Context.empty() as never,
			)
			expect(token.status).toBe(200)
			expect(await token.json()).toMatchObject({
				token_type: "Bearer",
				expires_in: 3600,
				scope: "mcp:tools",
			})
		} finally {
			await harness.dispose()
			await harness.runtime.dispose()
		}
	})
})
