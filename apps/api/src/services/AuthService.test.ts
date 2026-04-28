import { describe, expect, it } from "vitest"
import { Effect, Exit, Option, Redacted, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { makeLoginSelfHosted, makeResolveMcpTenant, makeResolveTenant } from "./AuthService"

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
	it("resolves a Clerk tenant from verified session claims", async () => {
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

		const tenant = await Effect.runPromise(
			resolveTenant({
				authorization: "Bearer test-token",
			}),
		)

		expect(tenant).toEqual({
			orgId: asOrgId("org_123"),
			userId: asUserId("user_123"),
			roles: [asRoleName("org:admin")],
			authMode: "clerk",
		})
	})

	it("rejects Clerk auth when no bearer token is present", async () => {
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

		const exit = await Effect.runPromiseExit(resolveTenant({}))
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
			message: "Session token missing",
		})
	})

	it("rejects invalid or expired Clerk tokens", async () => {
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

		const exit = await Effect.runPromiseExit(
			resolveTenant({
				authorization: "Bearer bad-token",
			}),
		)
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
			message: "Clerk authentication failed: token verification failed",
		})
	})

	it("rejects Clerk users without an active organization", async () => {
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

		const exit = await Effect.runPromiseExit(
			resolveTenant({
				authorization: "Bearer test-token",
			}),
		)
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
			message: "Active organization is required",
		})
	})

	it("rejects self-hosted requests without a bearer token", async () => {
		const resolveTenant = makeResolveTenant(baseEnv)

		const exit = await Effect.runPromiseExit(resolveTenant({}))
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
			message: "Self-hosted mode requires a valid bearer token",
		})
	})

	it("rejects self-hosted requests with invalid token signature", async () => {
		const resolveTenant = makeResolveTenant(baseEnv)

		const exit = await Effect.runPromiseExit(
			resolveTenant({
				authorization: "Bearer invalid.token.signature",
			}),
		)
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
		})
	})

	it("accepts valid self-hosted bearer tokens", async () => {
		const loginSelfHosted = makeLoginSelfHosted(baseEnv)
		const resolveTenant = makeResolveTenant(baseEnv)
		const login = await Effect.runPromise(loginSelfHosted("root-password"))

		const tenant = await Effect.runPromise(
			resolveTenant({
				authorization: `Bearer ${login.token}`,
			}),
		)

		expect(tenant).toEqual({
			orgId: asOrgId("default"),
			userId: asUserId("root"),
			roles: [asRoleName("root")],
			authMode: "self_hosted",
		})
	})
})

describe("makeResolveMcpTenant", () => {
	it("resolves tenant from an org API key", async () => {
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

		const tenant = await Effect.runPromise(
			resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			}),
		)

		expect(tenant).toEqual({
			orgId: asOrgId("org_abc"),
			userId: asUserId("user_abc"),
			roles: [asRoleName("org:member")],
			authMode: "clerk",
		})
	})

	it("resolves tenant from a user API key with MAPLE_ORG_ID_OVERRIDE", async () => {
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

		const tenant = await Effect.runPromise(
			resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			}),
		)

		expect(tenant).toEqual({
			orgId: asOrgId("org_override"),
			userId: asUserId("user_abc"),
			roles: [],
			authMode: "clerk",
		})
	})

	it("rejects a user API key without org context", async () => {
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

		const exit = await Effect.runPromiseExit(
			resolveMcpTenant({
				authorization: "Bearer maple_key_xxx",
			}),
		)
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/UnauthorizedError",
			message: "Active organization is required",
		})
	})

	it("falls through to self-hosted mode when MAPLE_AUTH_MODE is self_hosted", async () => {
		const loginSelfHosted = makeLoginSelfHosted(baseEnv)
		const resolveMcpTenant = makeResolveMcpTenant(baseEnv)
		const login = await Effect.runPromise(loginSelfHosted("root-password"))

		const tenant = await Effect.runPromise(
			resolveMcpTenant({
				authorization: `Bearer ${login.token}`,
			}),
		)

		expect(tenant).toEqual({
			orgId: asOrgId("default"),
			userId: asUserId("root"),
			roles: [asRoleName("root")],
			authMode: "self_hosted",
		})
	})
})

describe("makeLoginSelfHosted", () => {
	it("rejects invalid root passwords", async () => {
		const loginSelfHosted = makeLoginSelfHosted(baseEnv)
		const exit = await Effect.runPromiseExit(loginSelfHosted("wrong-password"))
		const failure = getFailure(exit)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(failure).toMatchObject({
			_tag: "@maple/http/errors/SelfHostedInvalidPasswordError",
			message: "Invalid root password",
		})
	})
})
