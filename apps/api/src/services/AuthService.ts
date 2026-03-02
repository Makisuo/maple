import { createHmac, timingSafeEqual } from "node:crypto"
import { createClerkClient } from "@clerk/backend"
import {
  SelfHostedAuthDisabledError,
  SelfHostedInvalidPasswordError,
  SelfHostedLoginResponse,
  UnauthorizedError,
} from "@maple/domain/http"
import { Effect } from "effect"
import { Env } from "./Env"

export interface TenantContext {
  readonly orgId: string
  readonly userId: string
  readonly roles: readonly string[]
  readonly authMode: "clerk" | "self_hosted"
}

type HeaderRecord = Record<string, string | undefined>

type JwtPayload = {
  sub?: string
  exp?: number
  nbf?: number
  iat?: number
  org_id?: string
  authMode?: string
  roles?: string[] | string
}

const unauthorized = (message: string) =>
  new UnauthorizedError({
    message,
  })

const getHeader = (headers: HeaderRecord, key: string): string | undefined => {
  const exact = headers[key]
  if (exact) return exact
  return headers[key.toLowerCase()]
}

const getBearerToken = (headers: HeaderRecord): string | undefined => {
  const header = getHeader(headers, "authorization")
  if (!header) return undefined
  const [scheme, token] = header.split(" ")
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
  return token
}

const toHeaders = (headers: HeaderRecord): Headers => {
  const requestHeaders = new Headers()

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      requestHeaders.set(name, value)
    }
  }

  return requestHeaders
}

const toRequest = (headers: HeaderRecord): Request => {
  const host = getHeader(headers, "host") ?? "localhost"
  const protocol = getHeader(headers, "x-forwarded-proto") ?? "http"

  return new Request(`${protocol}://${host}/`, {
    headers: toHeaders(headers),
  })
}

const decodeBase64Url = (input: string): string => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
  return Buffer.from(padded, "base64").toString("utf8")
}

const encodeBase64Url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url")

const verifyHs256Jwt = Effect.fn("AuthService.verifyHs256Jwt")(function* (
  token: string,
  secret: string,
): Effect.fn.Return<JwtPayload, UnauthorizedError> {
  const parts = token.split(".")
  if (parts.length !== 3) {
    return yield* unauthorized("Invalid JWT format")
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = yield* Effect.try({
    try: () => JSON.parse(decodeBase64Url(encodedHeader)) as { alg?: string },
    catch: () => unauthorized("Invalid JWT header"),
  })
  if (header.alg !== "HS256") {
    return yield* unauthorized("Unsupported JWT algorithm")
  }

  const data = `${encodedHeader}.${encodedPayload}`
  const expected = createHmac("sha256", secret).update(data).digest("base64url")
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(encodedSignature)

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return yield* unauthorized("Invalid JWT signature")
  }

  const payload = yield* Effect.try({
    try: () => JSON.parse(decodeBase64Url(encodedPayload)) as JwtPayload,
    catch: () => unauthorized("Invalid JWT payload"),
  })
  const now = Math.floor(Date.now() / 1000)

  if (payload.nbf && now < payload.nbf) {
    return yield* unauthorized("JWT is not active yet")
  }

  if (payload.exp && now >= payload.exp) {
    return yield* unauthorized("JWT has expired")
  }

  return payload
})

const signHs256Jwt = (payload: JwtPayload, secret: string): string => {
  const header = { alg: "HS256", typ: "JWT" }
  const encodedHeader = encodeBase64Url(header)
  const encodedPayload = encodeBase64Url(payload)
  const data = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac("sha256", secret).update(data).digest("base64url")
  return `${data}.${signature}`
}

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  const size = Math.max(leftBuffer.length, rightBuffer.length, 1)
  const normalizedLeft = Buffer.alloc(size)
  const normalizedRight = Buffer.alloc(size)

  leftBuffer.copy(normalizedLeft)
  rightBuffer.copy(normalizedRight)

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(normalizedLeft, normalizedRight)
}

const parseRoles = (value: JwtPayload["roles"]): string[] => {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return []
}

const getAuthMode = (mode: string): "clerk" | "self_hosted" =>
  mode.toLowerCase() === "clerk" ? "clerk" : "self_hosted"

const makeSelfHostedTenant = (defaultOrgId: string): TenantContext => ({
  orgId: defaultOrgId,
  userId: "root",
  roles: ["root"],
  authMode: "self_hosted",
})

type ClerkSessionAuth = {
  readonly isAuthenticated: boolean
  readonly tokenType: string | null | undefined
  readonly userId: string | null | undefined
  readonly orgId: string | null | undefined
  readonly orgRole: string | null | undefined
}

type ClerkRequestState = {
  readonly isAuthenticated: boolean
  readonly message: string | null
  readonly toAuth: () => ClerkSessionAuth | null
}

type ClerkAuthenticateRequest = (
  request: Request,
  options: {
    readonly acceptsToken: string | string[]
    readonly jwtKey?: string
  },
) => Promise<ClerkRequestState>

interface AuthEnv {
  readonly MAPLE_AUTH_MODE: string
  readonly MAPLE_DEFAULT_ORG_ID: string
  readonly MAPLE_ORG_ID_OVERRIDE: string
  readonly MAPLE_ROOT_PASSWORD: string
  readonly INTERNAL_SERVICE_TOKEN: string
  readonly CLERK_SECRET_KEY: string
  readonly CLERK_PUBLISHABLE_KEY: string
  readonly CLERK_JWT_KEY: string
}

const makeClerkAuthenticateRequest = (
  env: Pick<AuthEnv, "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
): ClerkAuthenticateRequest | undefined => {
  if (env.CLERK_SECRET_KEY.length === 0) {
    return undefined
  }

  const clerkClient = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY.length > 0 ? env.CLERK_PUBLISHABLE_KEY : undefined,
    jwtKey: env.CLERK_JWT_KEY.length > 0 ? env.CLERK_JWT_KEY : undefined,
  })

  return (request, options) =>
    clerkClient.authenticateRequest(request, options as any) as Promise<ClerkRequestState>
}

export const makeLoginSelfHosted = (
  env: Pick<AuthEnv, "MAPLE_AUTH_MODE" | "MAPLE_DEFAULT_ORG_ID" | "MAPLE_ROOT_PASSWORD">,
) =>
  Effect.fn("AuthService.loginSelfHosted")(function* (
    password: string,
  ): Effect.fn.Return<
    SelfHostedLoginResponse,
    SelfHostedAuthDisabledError | SelfHostedInvalidPasswordError
  > {
    if (getAuthMode(env.MAPLE_AUTH_MODE) !== "self_hosted") {
      return yield* Effect.fail(
        new SelfHostedAuthDisabledError({
          message: "Self-hosted password login is disabled",
        }),
      )
    }

    if (!constantTimeEquals(password, env.MAPLE_ROOT_PASSWORD)) {
      return yield* Effect.fail(
        new SelfHostedInvalidPasswordError({
          message: "Invalid root password",
        }),
      )
    }

    const tenant = makeSelfHostedTenant(env.MAPLE_DEFAULT_ORG_ID)
    const now = Math.floor(Date.now() / 1000)
    const token = signHs256Jwt(
      {
        sub: tenant.userId,
        org_id: tenant.orgId,
        roles: [...tenant.roles],
        authMode: "self_hosted",
        iat: now,
      },
      env.MAPLE_ROOT_PASSWORD,
    )

    return new SelfHostedLoginResponse({
      token,
      orgId: tenant.orgId,
      userId: tenant.userId,
    })
  })

export const makeResolveTenant = (
  env: AuthEnv,
  authenticateClerkRequest = makeClerkAuthenticateRequest(env),
  acceptsToken: string | string[] = "session_token",
) =>
  Effect.fn("AuthService.resolveTenant")(function* (
    headers: HeaderRecord,
  ): Effect.fn.Return<TenantContext, UnauthorizedError> {
    // Internal service token auth (e.g. agent, chat-agent)
    const bearerToken = getBearerToken(headers)
    if (bearerToken && bearerToken.startsWith("maple_svc_") && env.INTERNAL_SERVICE_TOKEN.length > 0) {
      const provided = bearerToken.slice("maple_svc_".length)
      const expected = env.INTERNAL_SERVICE_TOKEN
      const providedBuf = Buffer.from(provided)
      const expectedBuf = Buffer.from(expected)

      if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
        const orgId =
          env.MAPLE_ORG_ID_OVERRIDE.length > 0
            ? env.MAPLE_ORG_ID_OVERRIDE
            : getHeader(headers, "x-org-id")
        if (!orgId) {
          return yield* unauthorized("X-Org-Id header is required for internal service auth")
        }
        return { orgId, userId: "internal-service", roles: ["root"], authMode: "self_hosted" as const }
      }

      return yield* unauthorized("Invalid internal service token")
    }

    const authMode = getAuthMode(env.MAPLE_AUTH_MODE)

    if (authMode === "clerk") {
      if (!authenticateClerkRequest) {
        return yield* unauthorized("CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk")
      }

      const requestState = yield* Effect.tryPromise({
        try: () =>
          authenticateClerkRequest(toRequest(headers), {
            acceptsToken,
            jwtKey: env.CLERK_JWT_KEY.length > 0 ? env.CLERK_JWT_KEY : undefined,
          }),
        catch: (error) =>
          unauthorized(
            `Clerk authentication failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      })

      if (!requestState.isAuthenticated) {
        return yield* unauthorized(requestState.message ?? "Invalid Clerk session token")
      }

      const auth = requestState.toAuth()
      if (!auth) {
        return yield* unauthorized("Invalid Clerk session token")
      }

      if (!auth.isAuthenticated) {
        return yield* unauthorized("Invalid Clerk token")
      }

      if (!auth.userId) {
        return yield* unauthorized("Missing user in Clerk session token")
      }

      if (!auth.orgId && env.MAPLE_ORG_ID_OVERRIDE.length === 0) {
        return yield* unauthorized("Active organization is required")
      }

      const clerkTenant: TenantContext = {
        orgId: env.MAPLE_ORG_ID_OVERRIDE.length > 0 ? env.MAPLE_ORG_ID_OVERRIDE : auth.orgId!,
        userId: auth.userId,
        roles: typeof auth.orgRole === "string" ? [auth.orgRole] : [],
        authMode: "clerk" as const,
      }

      return clerkTenant
    }

    const token = getBearerToken(headers)
    if (!token) {
      return yield* unauthorized("Self-hosted mode requires a valid bearer token")
    }

    const payload = yield* verifyHs256Jwt(token, env.MAPLE_ROOT_PASSWORD)

    if (
      payload.authMode !== "self_hosted" ||
      typeof payload.sub !== "string" ||
      typeof payload.org_id !== "string"
    ) {
      return yield* unauthorized("Invalid self-hosted session token")
    }

    const roles = parseRoles(payload.roles)

    const tenant: TenantContext = {
      orgId: payload.org_id,
      userId: payload.sub,
      roles: roles.length > 0 ? roles : ["root"],
      authMode: "self_hosted" as const,
    }

    if (env.MAPLE_ORG_ID_OVERRIDE.length > 0) {
      return { ...tenant, orgId: env.MAPLE_ORG_ID_OVERRIDE }
    }

    return tenant
  })

export const makeResolveMcpTenant = (
  env: AuthEnv,
  authenticateClerkRequest = makeClerkAuthenticateRequest(env),
) => makeResolveTenant(env, authenticateClerkRequest, "api_key")

export class AuthService extends Effect.Service<AuthService>()("AuthService", {
  accessors: true,
  dependencies: [Env.Default],
  effect: Effect.gen(function* () {
    const env = yield* Env
    const resolveTenant = makeResolveTenant(env)
    const resolveMcpTenant = makeResolveMcpTenant(env)
    const loginSelfHosted = makeLoginSelfHosted(env)

    return {
      resolveTenant,
      resolveMcpTenant,
      loginSelfHosted,
    }
  }),
}) {}
