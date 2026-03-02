import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { makeLoginSelfHosted, makeResolveMcpTenant, makeResolveTenant } from "./AuthService"

const baseEnv = {
  MAPLE_AUTH_MODE: "self_hosted",
  MAPLE_ROOT_PASSWORD: "root-password",
  MAPLE_DEFAULT_ORG_ID: "default",
  MAPLE_ORG_ID_OVERRIDE: "",
  INTERNAL_SERVICE_TOKEN: "",
  CLERK_SECRET_KEY: "",
  CLERK_PUBLISHABLE_KEY: "",
  CLERK_JWT_KEY: "",
} as const

const getFailure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined

describe("makeResolveTenant", () => {
  it("resolves a Clerk tenant from verified session claims", async () => {
    const resolveTenant = makeResolveTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
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
      orgId: "org_123",
      userId: "user_123",
      roles: ["org:admin"],
      authMode: "clerk",
    })
  })

  it("rejects Clerk auth when no bearer token is present", async () => {
    const resolveTenant = makeResolveTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
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
      _tag: "UnauthorizedError",
      message: "Session token missing",
    })
  })

  it("rejects invalid or expired Clerk tokens", async () => {
    const resolveTenant = makeResolveTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
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
      _tag: "UnauthorizedError",
      message: "Clerk authentication failed: token verification failed",
    })
  })

  it("rejects Clerk users without an active organization", async () => {
    const resolveTenant = makeResolveTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
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
      _tag: "UnauthorizedError",
      message: "Active organization is required",
    })
  })

  it("rejects self-hosted requests without a bearer token", async () => {
    const resolveTenant = makeResolveTenant(baseEnv)

    const exit = await Effect.runPromiseExit(resolveTenant({}))
    const failure = getFailure(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toMatchObject({
      _tag: "UnauthorizedError",
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
      _tag: "UnauthorizedError",
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
      orgId: "default",
      userId: "root",
      roles: ["root"],
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
        CLERK_SECRET_KEY: "sk_test_123",
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
      orgId: "org_abc",
      userId: "user_abc",
      roles: ["org:member"],
      authMode: "clerk",
    })
  })

  it("resolves tenant from a user API key with MAPLE_ORG_ID_OVERRIDE", async () => {
    const resolveMcpTenant = makeResolveMcpTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
        MAPLE_ORG_ID_OVERRIDE: "org_override",
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
      orgId: "org_override",
      userId: "user_abc",
      roles: [],
      authMode: "clerk",
    })
  })

  it("rejects a user API key without org context", async () => {
    const resolveMcpTenant = makeResolveMcpTenant(
      {
        ...baseEnv,
        MAPLE_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "sk_test_123",
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
      _tag: "UnauthorizedError",
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
      orgId: "default",
      userId: "root",
      roles: ["root"],
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
      _tag: "SelfHostedInvalidPasswordError",
      message: "Invalid root password",
    })
  })
})
