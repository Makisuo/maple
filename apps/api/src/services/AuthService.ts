import { createHmac, timingSafeEqual } from "node:crypto"
import { createClerkClient } from "@clerk/backend"
import {
  AuthMode,
  OrgId,
  RoleName,
  SelfHostedAuthDisabledError,
  SelfHostedInvalidPasswordError,
  SelfHostedLoginResponse,
  UnauthorizedError,
  UserId,
} from "@maple/domain/http"
import { Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import { Env } from "./Env"

export interface TenantContext {
  readonly orgId: OrgId
  readonly userId: UserId
  readonly roles: readonly RoleName[]
  readonly authMode: AuthMode
}

export interface AuthServiceShape {
  readonly resolveTenant: (headers: HeaderRecord) => Effect.Effect<TenantContext, UnauthorizedError>
  readonly resolveMcpTenant: (headers: HeaderRecord) => Effect.Effect<TenantContext, UnauthorizedError>
  readonly loginSelfHosted: (
    password: string,
  ) => Effect.Effect<SelfHostedLoginResponse, SelfHostedAuthDisabledError | SelfHostedInvalidPasswordError>
}

type HeaderRecord = Record<string, string | undefined>

type JwtPayload = {
  sub?: string
  exp?: number
  nbf?: number
  iat?: number
  org_id?: string
  authMode?: AuthMode
  roles?: readonly string[] | string
}

const JwtHeaderSchema = Schema.Struct({
  alg: Schema.optional(Schema.String),
})
const JwtPayloadSchema = Schema.Struct({
  sub: Schema.optional(Schema.String),
  exp: Schema.optional(Schema.Number),
  nbf: Schema.optional(Schema.Number),
  iat: Schema.optional(Schema.Number),
  org_id: Schema.optional(Schema.String),
  authMode: Schema.optional(AuthMode),
  roles: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.String])),
})
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const unauthorized = (message: string) =>
  new UnauthorizedError({
    message,
  })

const decodeOrgId = (
  value: string,
  message: string,
): Effect.Effect<OrgId, UnauthorizedError> =>
  Schema.decodeUnknownEffect(OrgId)(value).pipe(
    Effect.mapError(() => unauthorized(message)),
  )

const decodeUserId = (
  value: string,
  message: string,
): Effect.Effect<UserId, UnauthorizedError> =>
  Schema.decodeUnknownEffect(UserId)(value).pipe(
    Effect.mapError(() => unauthorized(message)),
  )

const decodeRoleName = (
  value: string,
  message: string,
): Effect.Effect<RoleName, UnauthorizedError> =>
  Schema.decodeUnknownEffect(RoleName)(value).pipe(
    Effect.mapError(() => unauthorized(message)),
  )

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
  const header = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(JwtHeaderSchema),
  )(decodeBase64Url(encodedHeader)).pipe(
    Effect.mapError(() => unauthorized("Invalid JWT header")),
  )
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

  const payload = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(JwtPayloadSchema),
  )(decodeBase64Url(encodedPayload)).pipe(
    Effect.mapError(() => unauthorized("Invalid JWT payload")),
  )
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

const parseRawRoles = (value: JwtPayload["roles"]): string[] => {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return []
}

const parseRoles = (
  value: JwtPayload["roles"],
): Effect.Effect<Array<RoleName>, UnauthorizedError> =>
  Effect.forEach(parseRawRoles(value), (role) =>
    decodeRoleName(role, "Invalid role in session token"),
  )

const getAuthMode = (mode: string): AuthMode =>
  mode.toLowerCase() === "clerk" ? "clerk" : "self_hosted"

const makeSelfHostedTenant = (defaultOrgId: string): TenantContext => ({
  orgId: decodeOrgIdSync(defaultOrgId),
  userId: decodeUserIdSync("root"),
  roles: [decodeRoleNameSync("root")],
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
  readonly MAPLE_ORG_ID_OVERRIDE: Option.Option<string>
  readonly MAPLE_ROOT_PASSWORD: Option.Option<Redacted.Redacted<string>>
  readonly CLERK_SECRET_KEY: Option.Option<Redacted.Redacted<string>>
  readonly CLERK_PUBLISHABLE_KEY: Option.Option<string>
  readonly CLERK_JWT_KEY: Option.Option<Redacted.Redacted<string>>
}

const getOptionalString = <A>(option: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(option)

const getOptionalSecret = (
  option: Option.Option<Redacted.Redacted<string>>,
): string | undefined => Option.match(option, { onNone: () => undefined, onSome: Redacted.value })

const requireSecret = (
  option: Option.Option<Redacted.Redacted<string>>,
  label: string,
): Effect.Effect<string, never> =>
  Option.match(option, {
    onNone: () => Effect.die(new Error(`${label} is required`)),
    onSome: (value) => Effect.succeed(Redacted.value(value)),
  })

const makeClerkAuthenticateRequest = (
  env: Pick<AuthEnv, "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY" | "CLERK_JWT_KEY">,
): ClerkAuthenticateRequest | undefined => {
  if (Option.isNone(env.CLERK_SECRET_KEY)) {
    return undefined
  }

  const clerkClient = createClerkClient({
    secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
    publishableKey: getOptionalString(env.CLERK_PUBLISHABLE_KEY),
    jwtKey: getOptionalSecret(env.CLERK_JWT_KEY),
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

    const rootPassword = yield* requireSecret(
      env.MAPLE_ROOT_PASSWORD,
      "MAPLE_ROOT_PASSWORD",
    )

    if (!constantTimeEquals(password, rootPassword)) {
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
      rootPassword,
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
    const authMode = getAuthMode(env.MAPLE_AUTH_MODE)

    if (authMode === "clerk") {
      if (!authenticateClerkRequest) {
        return yield* unauthorized("CLERK_SECRET_KEY is required when MAPLE_AUTH_MODE=clerk")
      }

      const requestState = yield* Effect.tryPromise({
        try: () =>
          authenticateClerkRequest(toRequest(headers), {
            acceptsToken,
            jwtKey: getOptionalSecret(env.CLERK_JWT_KEY),
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

      const orgIdOverride = getOptionalString(env.MAPLE_ORG_ID_OVERRIDE)

      if (!auth.orgId && !orgIdOverride) {
        return yield* unauthorized("Active organization is required")
      }

      const clerkTenant: TenantContext = {
        orgId: yield* decodeOrgId(
          orgIdOverride ?? auth.orgId!,
          "Invalid organization in Clerk session token",
        ),
        userId: yield* decodeUserId(
          auth.userId,
          "Invalid user in Clerk session token",
        ),
        roles:
          typeof auth.orgRole === "string"
            ? yield* Effect.map(
                decodeRoleName(auth.orgRole, "Invalid role in Clerk session token"),
                (role) => [role],
              )
            : [],
        authMode: "clerk",
      }

      return clerkTenant
    }

    const token = getBearerToken(headers)
    if (!token) {
      return yield* unauthorized("Self-hosted mode requires a valid bearer token")
    }

    const rootPassword = yield* requireSecret(
      env.MAPLE_ROOT_PASSWORD,
      "MAPLE_ROOT_PASSWORD",
    )
    const payload = yield* verifyHs256Jwt(token, rootPassword)

    if (
      payload.authMode !== "self_hosted" ||
      typeof payload.sub !== "string" ||
      typeof payload.org_id !== "string"
    ) {
      return yield* unauthorized("Invalid self-hosted session token")
    }

    const roles = yield* parseRoles(payload.roles)

    const tenant: TenantContext = {
      orgId: yield* decodeOrgId(
        payload.org_id,
        "Invalid organization in self-hosted session token",
      ),
      userId: yield* decodeUserId(
        payload.sub,
        "Invalid user in self-hosted session token",
      ),
      roles: roles.length > 0 ? roles : [decodeRoleNameSync("root")],
      authMode: "self_hosted",
    }

    const orgIdOverride = getOptionalString(env.MAPLE_ORG_ID_OVERRIDE)
    if (orgIdOverride) {
      return {
        ...tenant,
        orgId: yield* decodeOrgId(
          orgIdOverride,
          "Invalid MAPLE_ORG_ID_OVERRIDE value",
        ),
      }
    }

    return tenant
  })

export const makeResolveMcpTenant = (
  env: AuthEnv,
  authenticateClerkRequest = makeClerkAuthenticateRequest(env),
) => makeResolveTenant(env, authenticateClerkRequest, "api_key")

export class AuthService extends ServiceMap.Service<AuthService, AuthServiceShape>()("AuthService", {
  make: Effect.gen(function* () {
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
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
