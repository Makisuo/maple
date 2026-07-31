// Tests for the MCP transport authentication path: internal-service tokens,
// API-key / MCP-OAuth bearer tokens (audience binding + scope rules), agent
// actor resolution, and the Clerk/session fallback. Every McpAuth* failure
// branch is asserted through `Exit.findErrorOption` so the tagged error type
// (not just "it failed") is checked.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { Env, type EnvShape } from "@/lib/Env"
import { AuthService, type AuthServiceShape } from "@/services/AuthService"
import { ApiKeysService, type ResolvedApiKey } from "@/services/ApiKeysService"
import type { TenantContext } from "@/lib/tenant-context"
import { mcpResourceForRequest, resolveMcpTenantContext } from "./resolve-tenant"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const MCP_URL = "https://api.maple.dev/mcp"
const RESOURCE = "https://api.maple.dev/mcp"
const INTERNAL_TOKEN = "s3cret-internal"
const ACTOR_UUID = "11111111-2222-4333-8444-555555555555"
const OTHER_ACTOR_UUID = "99999999-8888-4777-8666-555555555555"

const request = (headers: Record<string, string> = {}, url = MCP_URL) => new Request(url, { headers })

// --- stub layers -----------------------------------------------------------

const envLayer = (over: Partial<EnvShape> = {}) =>
	Layer.succeed(Env, {
		INTERNAL_SERVICE_TOKEN: Option.none(),
		MAPLE_ORG_ID_OVERRIDE: Option.none(),
		...over,
	} as unknown as EnvShape)

const withInternalToken = (token = INTERNAL_TOKEN, orgOverride?: string) =>
	envLayer({
		INTERNAL_SERVICE_TOKEN: Option.some(Redacted.make(token)),
		MAPLE_ORG_ID_OVERRIDE: orgOverride === undefined ? Option.none() : Option.some(orgOverride),
	})

const die = () => Effect.die(new Error("not stubbed for this test"))

const apiKeysLayer = (resolveByBearer: (token: string | undefined) => Effect.Effect<any, any>) =>
	Layer.succeed(ApiKeysService, {
		get: die,
		list: die,
		create: die,
		roll: die,
		revoke: die,
		resolveByKey: die,
		resolveByBearer,
		touchLastUsed: die,
	} as never)

/** No API key matches the bearer — the request falls through to session auth. */
const noApiKey = apiKeysLayer(() => Effect.succeed(Option.none<ResolvedApiKey>()))

const apiKeyReturning = (key: Partial<ResolvedApiKey>) =>
	apiKeysLayer(() =>
		Effect.succeed(
			Option.some({
				orgId: asOrgId("org_key"),
				userId: asUserId("user_key"),
				keyId: "key_1",
				kind: "api",
				metadataJson: null,
				scopes: null,
				roles: null,
				cliManaged: false,
				mcpOAuthResource: null,
				...key,
			} as ResolvedApiKey),
		),
	)

const authLayer = (resolveMcpTenant: AuthServiceShape["resolveMcpTenant"]) =>
	Layer.succeed(AuthService, {
		resolveTenant: die,
		resolveMcpTenant,
		loginSelfHosted: die,
		getUserEmail: die,
		getCustomerData: die,
	} as unknown as AuthServiceShape)

const sessionTenant: TenantContext = {
	orgId: asOrgId("org_session"),
	userId: asUserId("user_session"),
	roles: [asRoleName("admin")],
	authMode: "clerk",
}

const sessionOk = authLayer(() => Effect.succeed(sessionTenant))
const sessionFails = authLayer(() =>
	Effect.fail({ message: "no session cookie", _tag: "UnauthorizedError" } as never),
)

/** Everything the resolver can need; individual tests override a slice. */
const layers = (over: {
	env?: Layer.Layer<Env>
	apiKeys?: Layer.Layer<ApiKeysService>
	auth?: Layer.Layer<AuthService>
} = {}) => Layer.mergeAll(over.env ?? envLayer(), over.apiKeys ?? noApiKey, over.auth ?? sessionOk)

const resolve = (req: Request, layer: Layer.Layer<Env | ApiKeysService | AuthService>) =>
	resolveMcpTenantContext(req).pipe(Effect.provide(layer))

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

// --- mcpResourceForRequest -------------------------------------------------

describe("mcpResourceForRequest", () => {
	it("derives the resource from the request URL", () => {
		assert.strictEqual(mcpResourceForRequest(request()), "https://api.maple.dev/mcp")
	})

	it("prefers forwarded proto/host over the URL", () => {
		const req = request({ "x-forwarded-proto": "https", "x-forwarded-host": "edge.maple.dev" })
		assert.strictEqual(mcpResourceForRequest(req), "https://edge.maple.dev/mcp")
	})

	it("uses only the first value of a comma-separated forwarded header", () => {
		const req = request({
			"x-forwarded-proto": "https, http",
			"x-forwarded-host": "edge.maple.dev, internal",
		})
		assert.strictEqual(mcpResourceForRequest(req), "https://edge.maple.dev/mcp")
	})
})

// --- internal service token ------------------------------------------------

describe("internal service auth", () => {
	it.effect("resolves the tenant from x-org-id when the token matches", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				request({ authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`, "x-org-id": "org_abc" }),
				layers({ env: withInternalToken() }),
			)
			assert.strictEqual(tenant.orgId, "org_abc")
			assert.strictEqual(tenant.userId, "internal-service")
			assert.strictEqual(tenant.authMode, "self_hosted")
			assert.deepStrictEqual([...tenant.roles], [])
		}),
	)

	it.effect("prefers MAPLE_ORG_ID_OVERRIDE over the x-org-id header", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				request({ authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`, "x-org-id": "org_header" }),
				layers({ env: withInternalToken(INTERNAL_TOKEN, "org_override") }),
			)
			assert.strictEqual(tenant.orgId, "org_override")
		}),
	)

	it.effect("fails with McpAuthMissingError when the server token is unconfigured", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				request({ authorization: `Bearer maple_svc_${INTERNAL_TOKEN}`, "x-org-id": "org_abc" }),
				layers(),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthMissingError")
			assert.include(error?.message ?? "", "INTERNAL_SERVICE_TOKEN")
		}),
	)

	it.effect("fails with McpAuthMissingError when no org id is available", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				request({ authorization: `Bearer maple_svc_${INTERNAL_TOKEN}` }),
				layers({ env: withInternalToken() }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthMissingError")
			assert.include(error?.message ?? "", "x-org-id")
		}),
	)

	it.effect("fails with McpInvalidTenantError for a malformed org id", () =>
		Effect.gen(function* () {
			// Header values are trimmed by `Headers`, so the untrimmed org id has to
			// come from the env override to reach the decoder in a bad shape.
			const exit = yield* resolve(
				request({ authorization: `Bearer maple_svc_${INTERNAL_TOKEN}` }),
				layers({ env: withInternalToken(INTERNAL_TOKEN, " padded ") }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpInvalidTenantError")
			assert.strictEqual((error as { field?: string }).field, "orgId")
		}),
	)

	it.effect("fails with McpAuthInvalidError on a same-length token mismatch", () =>
		Effect.gen(function* () {
			// Same length as INTERNAL_TOKEN so the comparison reaches timingSafeEqual.
			const wrong = "x".repeat(INTERNAL_TOKEN.length)
			const exit = yield* resolve(
				request({ authorization: `Bearer maple_svc_${wrong}`, "x-org-id": "org_abc" }),
				layers({ env: withInternalToken() }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
			assert.include(error?.message ?? "", "mismatch")
		}),
	)

	it.effect("fails with McpAuthInvalidError (not a defect) on a different-length token", () =>
		Effect.gen(function* () {
			// timingSafeEqual throws on unequal buffer lengths — the length guard must
			// short-circuit before it is reached.
			const exit = yield* resolve(
				request({ authorization: "Bearer maple_svc_short", "x-org-id": "org_abc" }),
				layers({ env: withInternalToken() }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
		}),
	)
})

// --- API key / MCP OAuth ---------------------------------------------------

const bearer = (token = "maple_key_live") => request({ authorization: `Bearer ${token}` })

describe("api key auth", () => {
	it.effect("accepts a legacy full-access key and defaults roles to root", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(bearer(), layers({ apiKeys: apiKeyReturning({}) }))
			assert.strictEqual(tenant.orgId, "org_key")
			assert.strictEqual(tenant.userId, "user_key")
			assert.deepStrictEqual([...tenant.roles], ["root"])
			assert.isUndefined(tenant.actorId)
		}),
	)

	it.effect("keeps the key's pinned roles when present", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ roles: [asRoleName("member")] }) }),
			)
			assert.deepStrictEqual([...tenant.roles], ["member"])
		}),
	)

	it.effect("rejects a scoped (restricted) non-OAuth key", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ scopes: ["traces:read"] }) }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
			assert.strictEqual((error as { reason?: string }).reason, "insufficient_scope")
		}),
	)

	it.effect("accepts an audience-bound MCP OAuth token", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				bearer(),
				layers({
					apiKeys: apiKeyReturning({
						kind: "mcp" as ResolvedApiKey["kind"],
						mcpOAuthResource: RESOURCE,
						scopes: ["mcp:tools"],
					}),
				}),
			)
			assert.strictEqual(tenant.orgId, "org_key")
		}),
	)

	it.effect("rejects an OAuth token bound to a different resource", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({
					apiKeys: apiKeyReturning({
						kind: "mcp" as ResolvedApiKey["kind"],
						mcpOAuthResource: "https://evil.example.com/mcp",
						scopes: ["mcp:tools"],
					}),
				}),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
			assert.strictEqual((error as { reason?: string }).reason, "invalid_target")
		}),
	)

	it.effect("rejects an OAuth token without the mcp:tools scope", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({
					apiKeys: apiKeyReturning({
						kind: "mcp" as ResolvedApiKey["kind"],
						mcpOAuthResource: RESOURCE,
						scopes: ["traces:read"],
					}),
				}),
			).pipe(Effect.exit)

			assert.strictEqual(
				(failureOf(exit) as { reason?: string })?.reason,
				"invalid_target",
			)
		}),
	)

	it.effect("rejects an OAuth-resource token whose kind is not `mcp`", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({
					apiKeys: apiKeyReturning({ mcpOAuthResource: RESOURCE, scopes: ["mcp:tools"] }),
				}),
			).pipe(Effect.exit)

			assert.strictEqual(
				(failureOf(exit) as { reason?: string })?.reason,
				"invalid_target",
			)
		}),
	)

	it.effect("binds the audience to the forwarded host, not the raw URL", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				request({
					authorization: "Bearer maple_key_live",
					"x-forwarded-proto": "https",
					"x-forwarded-host": "edge.maple.dev",
				}),
				layers({
					apiKeys: apiKeyReturning({
						kind: "mcp" as ResolvedApiKey["kind"],
						mcpOAuthResource: "https://edge.maple.dev/mcp",
						scopes: ["mcp:tools"],
					}),
				}),
			)
			assert.strictEqual(tenant.orgId, "org_key")
		}),
	)

	it.effect("fails with McpAuthInvalidError when the key lookup itself fails", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeysLayer(() => Effect.fail({ message: "db down" } as never)) }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
			assert.strictEqual((error as { reason?: string }).reason, "api_key_lookup")
			assert.include(error?.message ?? "", "db down")
		}),
	)

	it.effect("fails with McpInvalidTenantError for a key holding a malformed org id", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ orgId: " bad " as ResolvedApiKey["orgId"] }) }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpInvalidTenantError")
			assert.strictEqual((error as { field?: string }).field, "orgId")
		}),
	)

	it.effect("fails with McpInvalidTenantError for a key holding a malformed user id", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ userId: "" as ResolvedApiKey["userId"] }) }),
			).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpInvalidTenantError")
			assert.strictEqual((error as { field?: string }).field, "userId")
		}),
	)
})

// --- actor id resolution ---------------------------------------------------

describe("agent actor resolution", () => {
	it.effect("uses the key's pinned agentActorId metadata", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				bearer(),
				layers({
					apiKeys: apiKeyReturning({
						metadataJson: JSON.stringify({ agentActorId: ACTOR_UUID }),
					}),
				}),
			)
			assert.strictEqual(tenant.actorId, ACTOR_UUID)
		}),
	)

	it.effect("prefers the x-maple-agent-id header over the key metadata", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				request({
					authorization: "Bearer maple_key_live",
					"x-maple-agent-id": OTHER_ACTOR_UUID,
				}),
				layers({
					apiKeys: apiKeyReturning({
						metadataJson: JSON.stringify({ agentActorId: ACTOR_UUID }),
					}),
				}),
			)
			assert.strictEqual(tenant.actorId, OTHER_ACTOR_UUID)
		}),
	)

	it.effect("drops a malformed actor id instead of failing the request", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				request({ authorization: "Bearer maple_key_live", "x-maple-agent-id": "not-a-uuid" }),
				layers({ apiKeys: apiKeyReturning({}) }),
			)
			assert.isUndefined(tenant.actorId)
		}),
	)

	it.effect("ignores unparseable metadata JSON", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ metadataJson: "{not json" }) }),
			)
			assert.isUndefined(tenant.actorId)
		}),
	)

	it.effect("ignores metadata JSON that is not an object or lacks agentActorId", () =>
		Effect.gen(function* () {
			const arrayMeta = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ metadataJson: JSON.stringify([ACTOR_UUID]) }) }),
			)
			assert.isUndefined(arrayMeta.actorId)

			const wrongType = yield* resolve(
				bearer(),
				layers({ apiKeys: apiKeyReturning({ metadataJson: JSON.stringify({ agentActorId: 7 }) }) }),
			)
			assert.isUndefined(wrongType.actorId)
		}),
	)
})

// --- session fallback ------------------------------------------------------

describe("session auth fallback", () => {
	it.effect("falls back to AuthService when no API key matches", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(request({ cookie: "__session=abc" }), layers())
			assert.strictEqual(tenant.orgId, "org_session")
			assert.strictEqual(tenant.userId, "user_session")
			assert.strictEqual(tenant.authMode, "clerk")
			assert.deepStrictEqual([...tenant.roles], ["admin"])
		}),
	)

	it.effect("fails with McpAuthInvalidError(session_auth_fallback) when the session is invalid", () =>
		Effect.gen(function* () {
			const exit = yield* resolve(request(), layers({ auth: sessionFails })).pipe(Effect.exit)

			const error = failureOf(exit)
			assert.strictEqual(error?._tag, "@maple/mcp/errors/McpAuthInvalidError")
			assert.strictEqual((error as { reason?: string }).reason, "session_auth_fallback")
			assert.include(error?.message ?? "", "no session cookie")
		}),
	)

	it.effect("treats a non-Bearer authorization header as no token", () =>
		Effect.gen(function* () {
			const tenant = yield* resolve(request({ authorization: "Basic abc123" }), layers())
			assert.strictEqual(tenant.orgId, "org_session")
		}),
	)
})
