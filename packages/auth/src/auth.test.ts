import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Redacted, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import {
	makeGetCustomerData,
	makeLoginSelfHosted,
	makeResolveMcpTenant,
	makeResolveTenant,
} from "./index"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const baseEnv = {
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: Option.some(Redacted.make("root-password")),
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_ORG_ID_OVERRIDE: Option.none(),
	CLERK_SECRET_KEY: Option.none(),
	CLERK_PUBLISHABLE_KEY: Option.none(),
	CLERK_JWT_KEY: Option.none(),
} as const

const getFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
	Option.getOrUndefined(Exit.findErrorOption(exit))

describe("makeResolveTenant", () => {
	it.effect("resolves a Clerk tenant from verified session claims", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "session_token",
						userId: "user_123",
						orgId: "org_123",
						orgRole: "org:admin",
					}),
				}),
			)

			const tenant = yield* resolveTenant({
				authorization: "Bearer test-token",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_123"),
				userId: asUserId("user_123"),
				roles: [asRoleName("org:admin")],
				authMode: "clerk",
			})
		}),
	)

	it.effect("rejects Clerk auth when no bearer token is present", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: false,
					message: "Session token missing",
					toAuth: () => ({
						isAuthenticated: false,
						tokenType: "session_token",
						userId: null,
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(resolveTenant({}))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Session token missing")
		}),
	)

	it.effect("rejects invalid or expired Clerk tokens", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => {
					throw new Error("token verification failed")
				},
			)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer bad-token",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Clerk authentication failed: token verification failed")
		}),
	)

	it.effect("rejects Clerk users without an active organization", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "session_token",
						userId: "user_123",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer test-token",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Active organization is required")
		}),
	)

	it.effect("rejects self-hosted requests without a bearer token", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(baseEnv)

			const exit = yield* Effect.exit(resolveTenant({}))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Self-hosted mode requires a valid bearer token")
		}),
	)

	it.effect("rejects self-hosted requests with invalid token signature", () =>
		Effect.gen(function* () {
			const resolveTenant = makeResolveTenant(baseEnv)

			const exit = yield* Effect.exit(
				resolveTenant({
					authorization: "Bearer invalid.token.signature",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
		}),
	)

	it.effect("accepts valid self-hosted bearer tokens", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const resolveTenant = makeResolveTenant(baseEnv)
			const login = yield* loginSelfHosted("root-password")

			const tenant = yield* resolveTenant({
				authorization: `Bearer ${login.token}`,
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})
		}),
	)
})

describe("makeResolveMcpTenant", () => {
	it.effect("resolves tenant from an org API key", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: "org_abc",
						orgRole: "org:member",
					}),
				}),
			)

			const tenant = yield* resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_abc"),
				userId: asUserId("user_abc"),
				roles: [asRoleName("org:member")],
				authMode: "clerk",
			})
		}),
	)

	it.effect("resolves tenant from a user API key with MAPLE_ORG_ID_OVERRIDE", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
					MAPLE_ORG_ID_OVERRIDE: Option.some("org_override"),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const tenant = yield* resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_override"),
				userId: asUserId("user_abc"),
				roles: [],
				authMode: "clerk",
			})
		}),
	)

	it.effect("rejects a user API key without org context", () =>
		Effect.gen(function* () {
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async () => ({
					isAuthenticated: true,
					message: null,
					toAuth: () => ({
						isAuthenticated: true,
						tokenType: "api_key",
						userId: "user_abc",
						orgId: null,
						orgRole: null,
					}),
				}),
			)

			const exit = yield* Effect.exit(
				resolveMcpTenant({
					authorization: "Bearer maple_key_xxx",
				}),
			)
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/UnauthorizedError")
			assert.strictEqual(failure?.message, "Active organization is required")
		}),
	)

	it.effect("falls through to self-hosted mode when MAPLE_AUTH_MODE is self_hosted", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const resolveMcpTenant = makeResolveMcpTenant(baseEnv)
			const login = yield* loginSelfHosted("root-password")

			const tenant = yield* resolveMcpTenant({
				authorization: `Bearer ${login.token}`,
			})

			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})
		}),
	)
})

describe("makeGetCustomerData", () => {
	it.effect("returns null identity outside Clerk mode (no enrichment, no regression)", () =>
		Effect.gen(function* () {
			const getCustomerData = makeGetCustomerData(baseEnv)

			const result = yield* getCustomerData({
				orgId: asOrgId("default"),
				userId: asUserId("root"),
				roles: [asRoleName("root")],
				authMode: "self_hosted",
			})

			assert.deepStrictEqual(result, { email: null, orgName: null })
		}),
	)
})

describe("makeLoginSelfHosted", () => {
	it.effect("rejects invalid root passwords", () =>
		Effect.gen(function* () {
			const loginSelfHosted = makeLoginSelfHosted(baseEnv)
			const exit = yield* Effect.exit(loginSelfHosted("wrong-password"))
			const failure = getFailure(exit) as { _tag?: string; message?: string } | undefined

			assert.isTrue(Exit.isFailure(exit))
			assert.strictEqual(failure?._tag, "@maple/http/errors/SelfHostedInvalidPasswordError")
			assert.strictEqual(failure?.message, "Invalid root password")
		}),
	)
})

describe("makeResolveMcpTenant", () => {
	// Regression: a logged-in browser applying an approved chat proposal via
	// POST /api/chat/apply sends a Clerk session_token. The MCP tenant fallback
	// must accept it (not only api_key), or every Clerk-mode apply fails.
	it.effect("accepts a Clerk session_token and resolves the caller's org", () =>
		Effect.gen(function* () {
			let seenAcceptsToken: unknown
			const resolveMcpTenant = makeResolveMcpTenant(
				{
					...baseEnv,
					MAPLE_AUTH_MODE: "clerk",
					CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_123")),
					CLERK_JWT_KEY: Option.some(Redacted.make("jwt_test_123")),
				},
				async (_request, options) => {
					seenAcceptsToken = (options as { acceptsToken?: unknown } | undefined)?.acceptsToken
					return {
						isAuthenticated: true,
						message: null,
						toAuth: () => ({
							isAuthenticated: true,
							tokenType: "session_token",
							userId: "user_123",
							orgId: "org_123",
							orgRole: "org:admin",
						}),
					}
				},
			)

			const tenant = yield* resolveMcpTenant({ authorization: "Bearer session-token" })

			assert.deepStrictEqual(seenAcceptsToken, ["api_key", "session_token"])
			assert.deepStrictEqual(tenant, {
				orgId: asOrgId("org_123"),
				userId: asUserId("user_123"),
				roles: [asRoleName("org:admin")],
				authMode: "clerk",
			})
		}),
	)
})
