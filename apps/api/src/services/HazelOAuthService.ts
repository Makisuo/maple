import { randomBytes, randomUUID } from "node:crypto"
import {
  IntegrationsNotConnectedError,
  IntegrationsPersistenceError,
  IntegrationsRevokedError,
  IntegrationsUpstreamError,
  IntegrationsValidationError,
  type HazelWorkspaceSummary,
  type OrgId,
  type UserId,
} from "@maple/domain/http"
import {
  oauthAuthStates,
  oauthConnections,
  type OAuthAuthStateRow,
  type OAuthConnectionRow,
} from "@maple/db"
import { and, eq, lt } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
} from "./Crypto"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { Env, type EnvShape } from "./Env"

const HAZEL_PROVIDER = "hazel"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes
const REFRESH_LEEWAY_MS = 60_000 // 1 minute

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
})

const UserInfoSchema = Schema.Struct({
  sub: Schema.String,
  email: Schema.optional(Schema.String),
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
})

const HazelWorkspacesResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
    }),
  ),
})

const DiscoveryDocumentSchema = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  userinfo_endpoint: Schema.optional(Schema.String),
})

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponseSchema)
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfoSchema)
const decodeWorkspacesResponse = Schema.decodeUnknownEffect(
  HazelWorkspacesResponseSchema,
)
const decodeDiscoveryDocument = Schema.decodeUnknownEffect(
  DiscoveryDocumentSchema,
)

interface ResolvedHazelOAuthEnv {
  readonly clientId: string
  readonly clientSecret: string
  readonly discoveryUrl: string
  readonly scopes: string
  readonly apiBaseUrl: string
}

interface ResolvedHazelOAuthConfig extends ResolvedHazelOAuthEnv {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly userInfoUrl: string
}

const resolveEnv = (
  env: EnvShape,
): Effect.Effect<ResolvedHazelOAuthEnv, IntegrationsValidationError> =>
  Effect.gen(function* () {
    const requireSome = <A>(
      opt: Option.Option<A>,
      message: string,
    ): Effect.Effect<A, IntegrationsValidationError> =>
      Option.match(opt, {
        onNone: () =>
          Effect.fail(
            new IntegrationsValidationError({ message }),
          ),
        onSome: (value) => Effect.succeed(value),
      })

    const clientId = yield* requireSome(
      env.HAZEL_OAUTH_CLIENT_ID,
      "HAZEL_OAUTH_CLIENT_ID is required to use the Hazel integration",
    )
    const clientSecretRedacted = yield* requireSome(
      env.HAZEL_OAUTH_CLIENT_SECRET,
      "HAZEL_OAUTH_CLIENT_SECRET is required to use the Hazel integration",
    )

    return {
      clientId,
      clientSecret: Redacted.value(clientSecretRedacted),
      discoveryUrl: env.HAZEL_OAUTH_DISCOVERY_URL,
      scopes: env.HAZEL_OAUTH_SCOPES,
      apiBaseUrl: env.HAZEL_API_BASE_URL.replace(/\/$/, ""),
    }
  })

const toPersistenceError = (cause: unknown) =>
  new IntegrationsPersistenceError({
    message: cause instanceof Error ? cause.message : "Hazel integration database error",
  })

const toUpstreamError = (message: string, status?: number) =>
  new IntegrationsUpstreamError({ message, ...(status === undefined ? {} : { status }) })

export interface HazelOAuthAccessToken {
  readonly accessToken: string
  readonly externalUserId: string
}

export interface HazelOAuthServiceShape {
  readonly startConnect: (
    orgId: OrgId,
    userId: UserId,
    options: {
      readonly callbackUrl: string
      readonly returnTo?: string
    },
  ) => Effect.Effect<
    { readonly redirectUrl: string; readonly state: string },
    | IntegrationsValidationError
    | IntegrationsUpstreamError
    | IntegrationsPersistenceError
  >
  readonly completeConnect: (
    code: string,
    state: string,
  ) => Effect.Effect<
    { readonly orgId: OrgId; readonly returnTo: string | null },
    | IntegrationsValidationError
    | IntegrationsUpstreamError
    | IntegrationsPersistenceError
  >
  readonly getStatus: (
    orgId: OrgId,
  ) => Effect.Effect<
    | {
        readonly connected: false
      }
    | {
        readonly connected: true
        readonly externalUserId: string
        readonly externalUserEmail: string | null
        readonly connectedByUserId: string
        readonly scope: string
      },
    IntegrationsPersistenceError
  >
  readonly getValidAccessToken: (
    orgId: OrgId,
  ) => Effect.Effect<
    HazelOAuthAccessToken,
    | IntegrationsNotConnectedError
    | IntegrationsRevokedError
    | IntegrationsUpstreamError
    | IntegrationsPersistenceError
    | IntegrationsValidationError
  >
  readonly listWorkspaces: (
    orgId: OrgId,
  ) => Effect.Effect<
    ReadonlyArray<HazelWorkspaceSummary>,
    | IntegrationsNotConnectedError
    | IntegrationsRevokedError
    | IntegrationsUpstreamError
    | IntegrationsPersistenceError
    | IntegrationsValidationError
  >
  readonly disconnect: (
    orgId: OrgId,
  ) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
}

export class HazelOAuthService extends Context.Service<
  HazelOAuthService,
  HazelOAuthServiceShape
>()("HazelOAuthService", {
  make: Effect.gen(function* () {
    const database = yield* Database
    const env = yield* Env
    const encryptionKey = yield* parseBase64Aes256GcmKey(
      Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      (message) =>
        new IntegrationsValidationError({
          message:
            message === "Expected a non-empty base64 encryption key"
              ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
              : message === "Expected base64 for exactly 32 bytes"
                ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
                : message,
        }),
    )

    const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
      database.execute(fn).pipe(Effect.mapError(toPersistenceError))

    const encryptValue = (plaintext: string) =>
      encryptAes256Gcm(plaintext, encryptionKey, (message) =>
        new IntegrationsPersistenceError({
          message: `Failed to encrypt Hazel token: ${message}`,
        }),
      )

    const decryptValue = (encrypted: {
      ciphertext: string
      iv: string
      tag: string
    }) =>
      decryptAes256Gcm(encrypted, encryptionKey, () =>
        new IntegrationsPersistenceError({
          message: "Failed to decrypt stored Hazel token",
        }),
      )

    const purgeExpiredStates = (currentTime: number) =>
      dbExecute((db) =>
        db
          .delete(oauthAuthStates)
          .where(lt(oauthAuthStates.expiresAt, currentTime)),
      )

    const fetchDiscoveryDocument = (
      discoveryUrl: string,
    ): Effect.Effect<
      Schema.Schema.Type<typeof DiscoveryDocumentSchema>,
      IntegrationsUpstreamError
    > =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(discoveryUrl, { headers: { accept: "application/json" } }),
          catch: (cause) =>
            toUpstreamError(
              cause instanceof Error
                ? `OIDC discovery fetch failed: ${cause.message}`
                : "OIDC discovery fetch failed",
            ),
        })
        if (!response.ok) {
          return yield* Effect.fail(
            toUpstreamError(
              `OIDC discovery returned ${response.status}`,
              response.status,
            ),
          )
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () =>
            toUpstreamError("OIDC discovery returned a non-JSON response"),
        })
        return yield* decodeDiscoveryDocument(json).pipe(
          Effect.mapError(() =>
            toUpstreamError("OIDC discovery returned an unexpected payload"),
          ),
        )
      })

    let cachedDiscovery: {
      url: string
      doc: Schema.Schema.Type<typeof DiscoveryDocumentSchema>
    } | null = null

    const resolveConfig: Effect.Effect<
      ResolvedHazelOAuthConfig,
      IntegrationsValidationError | IntegrationsUpstreamError
    > = Effect.gen(function* () {
      const base = yield* resolveEnv(env)
      if (cachedDiscovery && cachedDiscovery.url === base.discoveryUrl) {
        return {
          ...base,
          authorizeUrl: cachedDiscovery.doc.authorization_endpoint,
          tokenUrl: cachedDiscovery.doc.token_endpoint,
          userInfoUrl:
            cachedDiscovery.doc.userinfo_endpoint ??
            cachedDiscovery.doc.authorization_endpoint.replace(
              /\/oauth\/authorize$/,
              "/oauth/userinfo",
            ),
        }
      }
      const doc = yield* fetchDiscoveryDocument(base.discoveryUrl)
      cachedDiscovery = { url: base.discoveryUrl, doc }
      return {
        ...base,
        authorizeUrl: doc.authorization_endpoint,
        tokenUrl: doc.token_endpoint,
        userInfoUrl:
          doc.userinfo_endpoint ??
          doc.authorization_endpoint.replace(
            /\/oauth\/authorize$/,
            "/oauth/userinfo",
          ),
      }
    })

    const startConnect = Effect.fn("HazelOAuthService.startConnect")(function* (
      orgId: OrgId,
      userId: UserId,
      options: { readonly callbackUrl: string; readonly returnTo?: string },
    ) {
      const config = yield* resolveConfig
      const state = randomBytes(24).toString("base64url")
      const currentTime = Date.now()
      const callbackUrl = options.callbackUrl

      yield* purgeExpiredStates(currentTime)
      yield* dbExecute((db) =>
        db.insert(oauthAuthStates).values({
          state,
          orgId,
          provider: HAZEL_PROVIDER,
          initiatedByUserId: userId,
          redirectUri: callbackUrl,
          returnTo: options.returnTo ?? null,
          createdAt: currentTime,
          expiresAt: currentTime + STATE_TTL_MS,
        }),
      )

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        scope: config.scopes,
        state,
      })
      return {
        redirectUrl: `${config.authorizeUrl}?${params.toString()}`,
        state,
      }
    })

    const requireStateRow = (state: string) =>
      Effect.gen(function* () {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(oauthAuthStates)
            .where(eq(oauthAuthStates.state, state))
            .limit(1),
        )
        const row = rows[0]
        if (!row) {
          return yield* Effect.fail(
            new IntegrationsValidationError({
              message: "OAuth state not recognized — restart the connect flow",
            }),
          )
        }
        if (row.expiresAt < Date.now()) {
          yield* dbExecute((db) =>
            db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
          )
          return yield* Effect.fail(
            new IntegrationsValidationError({
              message: "OAuth state expired — restart the connect flow",
            }),
          )
        }
        return row satisfies OAuthAuthStateRow
      })

    const exchangeAuthorizationCode = (
      config: ResolvedHazelOAuthConfig,
      code: string,
      redirectUri: string,
    ) =>
      Effect.gen(function* () {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        })
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(config.tokenUrl, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
              },
              body: body.toString(),
            }),
          catch: (cause) =>
            toUpstreamError(
              cause instanceof Error
                ? `Token exchange failed: ${cause.message}`
                : "Token exchange failed",
            ),
        })
        if (!response.ok) {
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => toUpstreamError("Token exchange failed", response.status),
          })
          return yield* Effect.fail(
            toUpstreamError(
              `Token exchange failed: ${text || response.statusText}`,
              response.status,
            ),
          )
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () =>
            toUpstreamError("Token exchange returned a non-JSON response"),
        })
        return yield* decodeTokenResponse(json).pipe(
          Effect.mapError(() =>
            toUpstreamError("Token exchange returned an unexpected payload"),
          ),
        )
      })

    const refreshAccessToken = (
      config: ResolvedHazelOAuthConfig,
      refreshToken: string,
    ) =>
      Effect.gen(function* () {
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        })
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(config.tokenUrl, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
              },
              body: body.toString(),
            }),
          catch: (cause) =>
            toUpstreamError(
              cause instanceof Error
                ? `Token refresh failed: ${cause.message}`
                : "Token refresh failed",
            ),
        })
        if (response.status === 400 || response.status === 401) {
          return yield* Effect.fail(
            new IntegrationsRevokedError({
              message:
                "Hazel connection no longer authorized — reconnect required",
            }),
          )
        }
        if (!response.ok) {
          return yield* Effect.fail(
            toUpstreamError(
              `Token refresh failed with ${response.status}`,
              response.status,
            ),
          )
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () =>
            toUpstreamError("Token refresh returned a non-JSON response"),
        })
        return yield* decodeTokenResponse(json).pipe(
          Effect.mapError(() =>
            toUpstreamError("Token refresh returned an unexpected payload"),
          ),
        )
      })

    const fetchUserInfo = (
      config: ResolvedHazelOAuthConfig,
      accessToken: string,
    ) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(config.userInfoUrl, {
              headers: {
                authorization: `Bearer ${accessToken}`,
                accept: "application/json",
              },
            }),
          catch: (cause) =>
            toUpstreamError(
              cause instanceof Error
                ? `Userinfo fetch failed: ${cause.message}`
                : "Userinfo fetch failed",
            ),
        })
        if (!response.ok) {
          return yield* Effect.fail(
            toUpstreamError(
              `Userinfo fetch failed with ${response.status}`,
              response.status,
            ),
          )
        }
        const json = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () =>
            toUpstreamError("Userinfo returned a non-JSON response"),
        })
        return yield* decodeUserInfo(json).pipe(
          Effect.mapError(() =>
            toUpstreamError("Userinfo returned an unexpected payload"),
          ),
        )
      })

    const completeConnect = Effect.fn("HazelOAuthService.completeConnect")(function* (
      code: string,
      state: string,
    ) {
      const config = yield* resolveConfig
      const stateRow = yield* requireStateRow(state)
      yield* dbExecute((db) =>
        db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)),
      )

      const tokenResponse = yield* exchangeAuthorizationCode(
        config,
        code,
        stateRow.redirectUri,
      )
      const userInfo = yield* fetchUserInfo(config, tokenResponse.access_token)

      const accessEnc = yield* encryptValue(tokenResponse.access_token)
      const refreshEnc = tokenResponse.refresh_token
        ? yield* encryptValue(tokenResponse.refresh_token)
        : null
      const expiresAt =
        tokenResponse.expires_in != null
          ? Date.now() + tokenResponse.expires_in * 1000
          : null
      const currentTime = Date.now()
      const orgId = stateRow.orgId as OrgId

      const existing = yield* dbExecute((db) =>
        db
          .select()
          .from(oauthConnections)
          .where(
            and(
              eq(oauthConnections.orgId, orgId),
              eq(oauthConnections.provider, HAZEL_PROVIDER),
            ),
          )
          .limit(1),
      )

      if (existing[0]) {
        yield* dbExecute((db) =>
          db
            .update(oauthConnections)
            .set({
              externalUserId: userInfo.sub,
              externalUserEmail: userInfo.email ?? null,
              connectedByUserId: stateRow.initiatedByUserId,
              scope: tokenResponse.scope ?? config.scopes,
              accessTokenCiphertext: accessEnc.ciphertext,
              accessTokenIv: accessEnc.iv,
              accessTokenTag: accessEnc.tag,
              refreshTokenCiphertext: refreshEnc?.ciphertext ?? null,
              refreshTokenIv: refreshEnc?.iv ?? null,
              refreshTokenTag: refreshEnc?.tag ?? null,
              expiresAt,
              updatedAt: currentTime,
            })
            .where(eq(oauthConnections.id, existing[0]!.id)),
        )
      } else {
        yield* dbExecute((db) =>
          db.insert(oauthConnections).values({
            id: randomUUID(),
            orgId,
            provider: HAZEL_PROVIDER,
            externalUserId: userInfo.sub,
            externalUserEmail: userInfo.email ?? null,
            connectedByUserId: stateRow.initiatedByUserId,
            scope: tokenResponse.scope ?? config.scopes,
            accessTokenCiphertext: accessEnc.ciphertext,
            accessTokenIv: accessEnc.iv,
            accessTokenTag: accessEnc.tag,
            refreshTokenCiphertext: refreshEnc?.ciphertext ?? null,
            refreshTokenIv: refreshEnc?.iv ?? null,
            refreshTokenTag: refreshEnc?.tag ?? null,
            expiresAt,
            createdAt: currentTime,
            updatedAt: currentTime,
          }),
        )
      }

      return { orgId, returnTo: stateRow.returnTo ?? null }
    })

    const loadConnection = (orgId: OrgId) =>
      dbExecute((db) =>
        db
          .select()
          .from(oauthConnections)
          .where(
            and(
              eq(oauthConnections.orgId, orgId),
              eq(oauthConnections.provider, HAZEL_PROVIDER),
            ),
          )
          .limit(1),
      ).pipe(Effect.map((rows) => rows[0] ?? null))

    const requireConnection = (orgId: OrgId) =>
      Effect.gen(function* () {
        const row = yield* loadConnection(orgId)
        if (!row) {
          return yield* Effect.fail(
            new IntegrationsNotConnectedError({
              message: "Hazel is not connected for this organization",
            }),
          )
        }
        return row satisfies OAuthConnectionRow
      })

    const persistRefreshedTokens = (
      row: OAuthConnectionRow,
      tokenResponse: typeof TokenResponseSchema.Type,
    ) =>
      Effect.gen(function* () {
        const accessEnc = yield* encryptValue(tokenResponse.access_token)
        const refreshEnc = tokenResponse.refresh_token
          ? yield* encryptValue(tokenResponse.refresh_token)
          : null
        const expiresAt =
          tokenResponse.expires_in != null
            ? Date.now() + tokenResponse.expires_in * 1000
            : null
        const currentTime = Date.now()
        yield* dbExecute((db) =>
          db
            .update(oauthConnections)
            .set({
              accessTokenCiphertext: accessEnc.ciphertext,
              accessTokenIv: accessEnc.iv,
              accessTokenTag: accessEnc.tag,
              refreshTokenCiphertext:
                refreshEnc?.ciphertext ?? row.refreshTokenCiphertext,
              refreshTokenIv: refreshEnc?.iv ?? row.refreshTokenIv,
              refreshTokenTag: refreshEnc?.tag ?? row.refreshTokenTag,
              expiresAt,
              updatedAt: currentTime,
            })
            .where(eq(oauthConnections.id, row.id)),
        )
        return tokenResponse.access_token
      })

    const getValidAccessToken = Effect.fn(
      "HazelOAuthService.getValidAccessToken",
    )(function* (orgId: OrgId) {
      const config = yield* resolveConfig
      const row = yield* requireConnection(orgId)
      const isValid =
        row.expiresAt == null || row.expiresAt - Date.now() > REFRESH_LEEWAY_MS

      if (isValid) {
        const accessToken = yield* decryptValue({
          ciphertext: row.accessTokenCiphertext,
          iv: row.accessTokenIv,
          tag: row.accessTokenTag,
        })
        return {
          accessToken,
          externalUserId: row.externalUserId,
        } satisfies HazelOAuthAccessToken
      }

      if (
        !row.refreshTokenCiphertext ||
        !row.refreshTokenIv ||
        !row.refreshTokenTag
      ) {
        return yield* Effect.fail(
          new IntegrationsRevokedError({
            message:
              "Hazel access token expired and no refresh token is stored — reconnect required",
          }),
        )
      }

      const refreshToken = yield* decryptValue({
        ciphertext: row.refreshTokenCiphertext,
        iv: row.refreshTokenIv,
        tag: row.refreshTokenTag,
      })
      const refreshed = yield* refreshAccessToken(config, refreshToken)
      const accessToken = yield* persistRefreshedTokens(row, refreshed)
      return {
        accessToken,
        externalUserId: row.externalUserId,
      } satisfies HazelOAuthAccessToken
    })

    const getStatus = Effect.fn("HazelOAuthService.getStatus")(function* (
      orgId: OrgId,
    ) {
      const row = yield* loadConnection(orgId)
      if (!row) {
        return { connected: false } as const
      }
      return {
        connected: true,
        externalUserId: row.externalUserId,
        externalUserEmail: row.externalUserEmail,
        connectedByUserId: row.connectedByUserId,
        scope: row.scope,
      } as const
    })

    const listWorkspaces = Effect.fn("HazelOAuthService.listWorkspaces")(function* (
      orgId: OrgId,
    ) {
      const config = yield* resolveConfig
      const { accessToken } = yield* getValidAccessToken(orgId)
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${config.apiBaseUrl}/api/v1/organizations`, {
            headers: {
              authorization: `Bearer ${accessToken}`,
              accept: "application/json",
            },
          }),
        catch: (cause) =>
          toUpstreamError(
            cause instanceof Error
              ? `Hazel workspaces request failed: ${cause.message}`
              : "Hazel workspaces request failed",
          ),
      })
      if (response.status === 401) {
        return yield* Effect.fail(
          new IntegrationsRevokedError({
            message: "Hazel rejected the access token — reconnect required",
          }),
        )
      }
      if (!response.ok) {
        return yield* Effect.fail(
          toUpstreamError(
            `Hazel workspaces returned ${response.status}`,
            response.status,
          ),
        )
      }
      const json = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          toUpstreamError("Hazel workspaces returned a non-JSON response"),
      })
      const decoded = yield* decodeWorkspacesResponse(json).pipe(
        Effect.mapError(() =>
          toUpstreamError("Hazel workspaces returned an unexpected payload"),
        ),
      )
      return decoded.data.map((w) => ({ id: w.id, name: w.name }))
    })

    const disconnect = Effect.fn("HazelOAuthService.disconnect")(function* (
      orgId: OrgId,
    ) {
      const result = yield* dbExecute((db) =>
        db
          .delete(oauthConnections)
          .where(
            and(
              eq(oauthConnections.orgId, orgId),
              eq(oauthConnections.provider, HAZEL_PROVIDER),
            ),
          ),
      )
      return { disconnected: (result.rowsAffected ?? 0) > 0 }
    })

    return {
      startConnect,
      completeConnect,
      getStatus,
      getValidAccessToken,
      listWorkspaces,
      disconnect,
    } satisfies HazelOAuthServiceShape
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
