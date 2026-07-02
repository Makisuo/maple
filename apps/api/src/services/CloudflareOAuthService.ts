import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { oauthAuthStates, oauthConnections, type OAuthAuthStateRow, type OAuthConnectionRow } from "@maple/db"
import { and, eq, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { listAccounts } from "../lib/CloudflareApi"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { Env, type EnvShape } from "../lib/Env"
import { msToDate } from "../lib/time"

const CLOUDFLARE_PROVIDER = "cloudflare"
const STATE_TTL_MS = 10 * 60_000 // 10 minutes
const REFRESH_LEEWAY_MS = 60_000 // refresh when the access token is within 1 minute of expiry

/**
 * PKCE (RFC 7636). Cloudflare's OAuth requires PKCE (S256) for public clients — a multi-tenant SaaS
 * that any Cloudflare user can connect — and accepts it for confidential clients too, so we always
 * send it. The `code_verifier` is stashed on the auth-state row and replayed at token exchange.
 */
const generateCodeVerifier = (): string => randomBytes(32).toString("base64url")
const deriveCodeChallenge = (verifier: string): string =>
	createHash("sha256").update(verifier).digest("base64url")

/** Cloudflare's OAuth token endpoint returns a standard OAuth2 token payload. */
const TokenResponseSchema = Schema.Struct({
	access_token: Schema.String,
	token_type: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	refresh_token: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
})

const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponseSchema)

interface ResolvedCloudflareOAuthConfig {
	readonly clientId: string
	/** null for a public (PKCE-only) client — Cloudflare's default for third-party SaaS apps. */
	readonly clientSecret: string | null
	readonly authorizeUrl: string
	readonly tokenUrl: string
	readonly revokeUrl: string
	readonly scopes: string
}

const resolveConfig = (
	env: EnvShape,
): Effect.Effect<ResolvedCloudflareOAuthConfig, IntegrationsValidationError> =>
	Effect.gen(function* () {
		// Only the client id is mandatory. Cloudflare public clients (any-user SaaS) authenticate the
		// token exchange with PKCE alone and carry no secret; confidential clients add one via env.
		const clientId = yield* Option.match(env.CLOUDFLARE_OAUTH_CLIENT_ID, {
			onNone: () =>
				Effect.fail(
					new IntegrationsValidationError({
						message: "CLOUDFLARE_OAUTH_CLIENT_ID is required to use the Cloudflare integration",
					}),
				),
			onSome: (value) => Effect.succeed(value),
		})

		return {
			clientId,
			clientSecret: Option.match(env.CLOUDFLARE_OAUTH_CLIENT_SECRET, {
				onNone: () => null,
				onSome: (value) => Redacted.value(value),
			}),
			authorizeUrl: env.CLOUDFLARE_OAUTH_AUTHORIZE_URL,
			tokenUrl: env.CLOUDFLARE_OAUTH_TOKEN_URL,
			revokeUrl: env.CLOUDFLARE_OAUTH_REVOKE_URL,
			scopes: env.CLOUDFLARE_OAUTH_SCOPES,
		}
	})

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "Cloudflare integration database error",
	})

const toUpstreamError = (message: string, status?: number, cause?: unknown) =>
	new IntegrationsUpstreamError({
		message,
		...(status === undefined ? {} : { status }),
		...(cause === undefined ? {} : { cause }),
	})

interface CloudflareAccessToken {
	readonly accessToken: string
	readonly accountId: string
}

export interface CloudflareOAuthServiceShape {
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		code: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsRevokedError
		| IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<
		| { readonly connected: false }
		| {
				readonly connected: true
				readonly accountId: string
				readonly accountName: string | null
				readonly connectedByUserId: string
				readonly scope: string
		  },
		IntegrationsPersistenceError
	>
	readonly getValidAccessToken: (
		orgId: OrgId,
	) => Effect.Effect<
		CloudflareAccessToken,
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

export class CloudflareOAuthService extends Context.Service<
	CloudflareOAuthService,
	CloudflareOAuthServiceShape
>()("@maple/api/services/CloudflareOAuthService", {
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
			encryptAes256Gcm(
				plaintext,
				encryptionKey,
				(message) =>
					new IntegrationsPersistenceError({
						message: `Failed to encrypt Cloudflare token: ${message}`,
					}),
			)

		const decryptValue = (encrypted: { ciphertext: string; iv: string; tag: string }) =>
			decryptAes256Gcm(
				encrypted,
				encryptionKey,
				() =>
					new IntegrationsPersistenceError({
						message: "Failed to decrypt stored Cloudflare token",
					}),
			)

		const purgeExpiredStates = (currentTime: number) =>
			dbExecute((db) =>
				db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, new Date(currentTime))),
			)

		/** POST an `application/x-www-form-urlencoded` body and return the raw status + text. */
		const postForm = (url: string, params: Record<string, string>) =>
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const request = HttpClientRequest.post(url, {
					headers: { accept: "application/json" },
				}).pipe(HttpClientRequest.bodyUrlParams(params))
				const response = yield* client.execute(request)
				const text = yield* response.text
				return { status: response.status, text }
			}).pipe(
				Effect.mapError((error) =>
					toUpstreamError(
						error instanceof Error ? error.message : "Cloudflare OAuth request failed",
					),
				),
				Effect.provide(FetchHttpClient.layer),
			)

		const parseTokenPayload = (text: string) =>
			Effect.try({
				try: () => JSON.parse(text) as unknown,
				catch: () => toUpstreamError("Cloudflare token endpoint returned a non-JSON response"),
			}).pipe(
				Effect.flatMap((json) =>
					decodeTokenResponse(json).pipe(
						Effect.mapError(() =>
							toUpstreamError("Cloudflare token endpoint returned an unexpected payload"),
						),
					),
				),
			)

		const exchangeAuthorizationCode = (
			config: ResolvedCloudflareOAuthConfig,
			code: string,
			redirectUri: string,
			codeVerifier: string,
		) =>
			Effect.gen(function* () {
				const { status, text } = yield* postForm(config.tokenUrl, {
					grant_type: "authorization_code",
					code,
					redirect_uri: redirectUri,
					client_id: config.clientId,
					code_verifier: codeVerifier,
					...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
				})
				if (status < 200 || status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Token exchange failed: ${text || status}`, status),
					)
				}
				return yield* parseTokenPayload(text)
			})

		const refreshAccessToken = (config: ResolvedCloudflareOAuthConfig, refreshToken: string) =>
			Effect.gen(function* () {
				const { status, text } = yield* postForm(config.tokenUrl, {
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: config.clientId,
					...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
				})
				if (status === 400 || status === 401) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: "Cloudflare connection no longer authorized — reconnect required",
						}),
					)
				}
				if (status < 200 || status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Token refresh failed with ${status}`, status),
					)
				}
				return yield* parseTokenPayload(text)
			})

		/** Best-effort token revocation on disconnect — failures are logged, never surfaced. */
		const revokeToken = (config: ResolvedCloudflareOAuthConfig, token: string) =>
			postForm(config.revokeUrl, {
				token,
				client_id: config.clientId,
				...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
			}).pipe(Effect.ignore)

		const startConnect = Effect.fn("CloudflareOAuthService.startConnect")(function* (
			orgId: OrgId,
			userId: UserId,
			options: { readonly callbackUrl: string; readonly returnTo?: string },
		) {
			const config = yield* resolveConfig(env)
			const state = randomBytes(24).toString("base64url")
			const codeVerifier = generateCodeVerifier()
			const currentTime = yield* Clock.currentTimeMillis

			yield* purgeExpiredStates(currentTime)
			yield* dbExecute((db) =>
				db.insert(oauthAuthStates).values({
					state,
					orgId,
					provider: CLOUDFLARE_PROVIDER,
					initiatedByUserId: userId,
					redirectUri: options.callbackUrl,
					returnTo: options.returnTo ?? null,
					codeVerifier,
					createdAt: new Date(currentTime),
					expiresAt: new Date(currentTime + STATE_TTL_MS),
				}),
			)

			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: options.callbackUrl,
				response_type: "code",
				scope: config.scopes,
				state,
				code_challenge: deriveCodeChallenge(codeVerifier),
				code_challenge_method: "S256",
			})
			return { redirectUrl: `${config.authorizeUrl}?${params.toString()}`, state }
		})

		const requireStateRow = (state: string) =>
			Effect.gen(function* () {
				const rows = yield* dbExecute((db) =>
					db.select().from(oauthAuthStates).where(eq(oauthAuthStates.state, state)).limit(1),
				)
				const row = rows[0]
				if (!row) {
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "OAuth state not recognized — restart the connect flow",
						}),
					)
				}
				if (row.expiresAt.getTime() < (yield* Clock.currentTimeMillis)) {
					yield* dbExecute((db) => db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)))
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "OAuth state expired — restart the connect flow",
						}),
					)
				}
				return row satisfies OAuthAuthStateRow
			})

		const completeConnect = Effect.fn("CloudflareOAuthService.completeConnect")(function* (
			code: string,
			state: string,
		) {
			const config = yield* resolveConfig(env)
			const stateRow = yield* requireStateRow(state)
			yield* dbExecute((db) => db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)))

			if (!stateRow.codeVerifier) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "OAuth state is missing its PKCE verifier — restart the connect flow",
					}),
				)
			}

			const tokenResponse = yield* exchangeAuthorizationCode(
				config,
				code,
				stateRow.redirectUri,
				stateRow.codeVerifier,
			)

			// Resolve — and require exactly one — Cloudflare account. A token that spans multiple
			// accounts is ambiguous for org→account scoping, so we refuse it (Superlog's rule).
			const accounts = yield* listAccounts(
				tokenResponse.access_token,
				env.MAPLE_CLOUDFLARE_API_BASE_URL,
			)
			if (accounts.length === 0) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "The Cloudflare authorization granted access to no accounts",
					}),
				)
			}
			if (accounts.length > 1) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"The Cloudflare authorization spans multiple accounts — reconnect and grant access to a single account",
					}),
				)
			}
			const account = accounts[0]!

			const accessEnc = yield* encryptValue(tokenResponse.access_token)
			const refreshEnc = tokenResponse.refresh_token
				? yield* encryptValue(tokenResponse.refresh_token)
				: null
			const currentTime = yield* Clock.currentTimeMillis
			const expiresAt =
				tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null
			const orgId = stateRow.orgId as OrgId

			const existing = yield* dbExecute((db) =>
				db
					.select()
					.from(oauthConnections)
					.where(
						and(
							eq(oauthConnections.orgId, orgId),
							eq(oauthConnections.provider, CLOUDFLARE_PROVIDER),
						),
					)
					.limit(1),
			)

			const values = {
				externalUserId: account.id,
				// Cloudflare has no user email in this flow; the account name is a display label.
				externalUserEmail: null,
				externalAccountName: account.name,
				connectedByUserId: stateRow.initiatedByUserId,
				scope: tokenResponse.scope ?? config.scopes,
				accessTokenCiphertext: accessEnc.ciphertext,
				accessTokenIv: accessEnc.iv,
				accessTokenTag: accessEnc.tag,
				refreshTokenCiphertext: refreshEnc?.ciphertext ?? null,
				refreshTokenIv: refreshEnc?.iv ?? null,
				refreshTokenTag: refreshEnc?.tag ?? null,
				expiresAt: msToDate(expiresAt),
				updatedAt: new Date(currentTime),
			}

			if (existing[0]) {
				yield* dbExecute((db) =>
					db.update(oauthConnections).set(values).where(eq(oauthConnections.id, existing[0]!.id)),
				)
			} else {
				yield* dbExecute((db) =>
					db.insert(oauthConnections).values({
						id: randomUUID(),
						orgId,
						provider: CLOUDFLARE_PROVIDER,
						createdAt: new Date(currentTime),
						...values,
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
							eq(oauthConnections.provider, CLOUDFLARE_PROVIDER),
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
							message: "Cloudflare is not connected for this organization",
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
				const currentTime = yield* Clock.currentTimeMillis
				const expiresAt =
					tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null
				yield* dbExecute((db) =>
					db
						.update(oauthConnections)
						.set({
							accessTokenCiphertext: accessEnc.ciphertext,
							accessTokenIv: accessEnc.iv,
							accessTokenTag: accessEnc.tag,
							refreshTokenCiphertext: refreshEnc?.ciphertext ?? row.refreshTokenCiphertext,
							refreshTokenIv: refreshEnc?.iv ?? row.refreshTokenIv,
							refreshTokenTag: refreshEnc?.tag ?? row.refreshTokenTag,
							expiresAt: msToDate(expiresAt),
							updatedAt: new Date(currentTime),
						})
						.where(eq(oauthConnections.id, row.id)),
				)
				return tokenResponse.access_token
			})

		const getValidAccessToken = Effect.fn("CloudflareOAuthService.getValidAccessToken")(function* (
			orgId: OrgId,
		) {
			const config = yield* resolveConfig(env)
			const row = yield* requireConnection(orgId)
			const isValid =
				row.expiresAt == null ||
				row.expiresAt.getTime() - (yield* Clock.currentTimeMillis) > REFRESH_LEEWAY_MS

			if (isValid) {
				const accessToken = yield* decryptValue({
					ciphertext: row.accessTokenCiphertext,
					iv: row.accessTokenIv,
					tag: row.accessTokenTag,
				})
				return { accessToken, accountId: row.externalUserId } satisfies CloudflareAccessToken
			}

			if (!row.refreshTokenCiphertext || !row.refreshTokenIv || !row.refreshTokenTag) {
				return yield* Effect.fail(
					new IntegrationsRevokedError({
						message:
							"Cloudflare access token expired and no refresh token is stored — reconnect required",
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
			return { accessToken, accountId: row.externalUserId } satisfies CloudflareAccessToken
		})

		const getStatus = Effect.fn("CloudflareOAuthService.getStatus")(function* (orgId: OrgId) {
			const row = yield* loadConnection(orgId)
			if (!row) {
				return { connected: false } as const
			}
			return {
				connected: true,
				accountId: row.externalUserId,
				accountName: row.externalAccountName,
				connectedByUserId: row.connectedByUserId,
				scope: row.scope,
			} as const
		})

		const disconnect = Effect.fn("CloudflareOAuthService.disconnect")(function* (orgId: OrgId) {
			// Best-effort upstream token revocation before we drop the row. Never let a revoke
			// failure block the disconnect — the deleted row is the real backstop.
			const row = yield* loadConnection(orgId)
			if (row) {
				const config = yield* resolveConfig(env).pipe(Effect.option)
				const accessToken = yield* decryptValue({
					ciphertext: row.accessTokenCiphertext,
					iv: row.accessTokenIv,
					tag: row.accessTokenTag,
				}).pipe(Effect.option)
				if (Option.isSome(config) && Option.isSome(accessToken)) {
					yield* revokeToken(config.value, accessToken.value)
				}
			}
			const result = yield* dbExecute((db) =>
				db
					.delete(oauthConnections)
					.where(
						and(
							eq(oauthConnections.orgId, orgId),
							eq(oauthConnections.provider, CLOUDFLARE_PROVIDER),
						),
					)
					.returning({ id: oauthConnections.id }),
			)
			return { disconnected: result.length > 0 }
		})

		return {
			startConnect,
			completeConnect,
			getStatus,
			getValidAccessToken,
			disconnect,
		} satisfies CloudflareOAuthServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
