// ---------------------------------------------------------------------------
// Shared OAuth-connection machinery for provider integrations (Cloudflare,
// Hazel, ...). Both providers persist into the same `oauth_connections` /
// `oauth_auth_states` tables, so the state-row lifecycle, encrypted token
// persistence, token-endpoint HTTP calls, and refresh semantics live here —
// parameterized by provider id and display label. Provider-specific flow
// (PKCE, OIDC discovery, account resolution) stays in each service.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
} from "@maple/domain/http"
import { oauthAuthStates, oauthConnections, type OAuthAuthStateRow, type OAuthConnectionRow } from "@maple/db"
import { and, eq, isNull, lt } from "drizzle-orm"
import { Clock, Effect, Redacted, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey, type EncryptedValue } from "../../lib/Crypto"
import type { DatabaseClient, DatabaseShape } from "../../lib/DatabaseLive"
import type { EnvShape } from "../../lib/Env"
import { msToDate } from "../../lib/time"

export const OAUTH_STATE_TTL_MS = 10 * 60_000 // 10 minutes
export const OAUTH_REFRESH_LEEWAY_MS = 60_000 // refresh when the access token is within 1 minute of expiry

/** Standard OAuth2 token payload (OIDC providers add `id_token`). */
export const OAuthTokenResponseSchema = Schema.Struct({
	access_token: Schema.String,
	token_type: Schema.optionalKey(Schema.String),
	expires_in: Schema.optionalKey(Schema.Number),
	refresh_token: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	id_token: Schema.optionalKey(Schema.String),
})
export type OAuthTokenResponse = typeof OAuthTokenResponseSchema.Type

const decodeTokenResponse = Schema.decodeUnknownEffect(OAuthTokenResponseSchema)

export const toUpstreamError = (message: string, status?: number, cause?: unknown) =>
	new IntegrationsUpstreamError({
		message,
		...(status === undefined ? {} : { status }),
		...(cause === undefined ? {} : { cause }),
	})

/** The token-endpoint slice of a provider's resolved OAuth config. */
export interface OAuthTokenEndpointConfig {
	readonly tokenUrl: string
	readonly clientId: string
	/** null for a public (PKCE-only) client. Stays Redacted until the token POST body. */
	readonly clientSecret: Redacted.Redacted<string> | null
}

export interface MakeOAuthConnectionHelpersOptions {
	/** Row value in `oauth_connections.provider` / `oauth_auth_states.provider`. */
	readonly provider: string
	/** Display name used in error messages ("Cloudflare", "Hazel"). */
	readonly providerLabel: string
	readonly database: DatabaseShape
	readonly env: EnvShape
}

/**
 * Build the provider-parameterized connection helpers. Effectful because it
 * validates the shared token-encryption key up front.
 */
export const makeOAuthConnectionHelpers = (options: MakeOAuthConnectionHelpersOptions) =>
	Effect.gen(function* () {
		const { provider, providerLabel, database, env } = options
		const httpClient = yield* HttpClient.HttpClient

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

		const toPersistenceError = (cause: unknown) =>
			new IntegrationsPersistenceError({
				message: cause instanceof Error ? cause.message : `${providerLabel} integration database error`,
			})

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		const encryptValue = (plaintext: string) =>
			encryptAes256Gcm(
				plaintext,
				encryptionKey,
				(message) =>
					new IntegrationsPersistenceError({
						message: `Failed to encrypt ${providerLabel} token: ${message}`,
					}),
			)

		const decryptValue = (encrypted: EncryptedValue) =>
			decryptAes256Gcm(
				encrypted,
				encryptionKey,
				() =>
					new IntegrationsPersistenceError({
						message: `Failed to decrypt stored ${providerLabel} token`,
					}),
			)

		const purgeExpiredStates = (currentTime: number) =>
			dbExecute((db) =>
				db.delete(oauthAuthStates).where(lt(oauthAuthStates.expiresAt, new Date(currentTime))),
			)

		const deleteAuthState = (state: string) =>
			dbExecute((db) => db.delete(oauthAuthStates).where(eq(oauthAuthStates.state, state)))

		const requireStateRow = Effect.fn("OAuthConnectionHelpers.requireStateRow")(
			function* (state: string) {
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
					yield* deleteAuthState(state)
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "OAuth state expired — restart the connect flow",
						}),
					)
				}
				return row satisfies OAuthAuthStateRow
			},
		)

		const loadConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db
					.select()
					.from(oauthConnections)
					.where(and(eq(oauthConnections.orgId, orgId), eq(oauthConnections.provider, provider)))
					.limit(1),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const requireConnection = Effect.fn("OAuthConnectionHelpers.requireConnection")(
			function* (orgId: OrgId) {
				const row = yield* loadConnection(orgId)
				if (!row) {
					return yield* Effect.fail(
						new IntegrationsNotConnectedError({
							message: `${providerLabel} is not connected for this organization`,
						}),
					)
				}
				return row satisfies OAuthConnectionRow
			},
		)

		/**
		 * Write (or overwrite) the org's connection in one statement — the unique
		 * index on (orgId, provider) makes select-then-branch unnecessary.
		 */
		const upsertConnection = (
			orgId: OrgId,
			currentTime: number,
			values: Omit<
				typeof oauthConnections.$inferInsert,
				"id" | "orgId" | "provider" | "createdAt" | "updatedAt"
			>,
		) =>
			dbExecute((db) =>
				db
					.insert(oauthConnections)
					.values({
						id: randomUUID(),
						orgId,
						provider,
						createdAt: new Date(currentTime),
						updatedAt: new Date(currentTime),
						...values,
					})
					.onConflictDoUpdate({
						target: [oauthConnections.orgId, oauthConnections.provider],
						// Reconnecting with fresh tokens clears any prior revocation so
						// pollers resume automatically.
						set: { ...values, revokedAt: null, updatedAt: new Date(currentTime) },
					}),
			)

		/**
		 * Stamp the connection as revoked (idempotent — only the first stamp writes).
		 * Pollers filter on `revokedAt IS NULL`, so a revoked grant stops being
		 * retried every tick; `upsertConnection` (reconnect) clears the stamp.
		 * Best-effort: bookkeeping must never mask the revocation error itself.
		 */
		const markConnectionRevoked = Effect.fn("OAuthConnectionHelpers.markConnectionRevoked")(
			function* (orgId: OrgId) {
				const currentTime = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db
						.update(oauthConnections)
						.set({ revokedAt: new Date(currentTime) })
						.where(
							and(
								eq(oauthConnections.orgId, orgId),
								eq(oauthConnections.provider, provider),
								isNull(oauthConnections.revokedAt),
							),
						),
				).pipe(Effect.ignore)
			},
		)

		/** Drop the org's connection row; reports whether anything was removed. */
		const deleteConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db
					.delete(oauthConnections)
					.where(and(eq(oauthConnections.orgId, orgId), eq(oauthConnections.provider, provider)))
					.returning({ id: oauthConnections.id }),
			).pipe(Effect.map((result) => ({ disconnected: result.length > 0 })))

		/** POST an `application/x-www-form-urlencoded` body and return the raw status + text. */
		const postForm = Effect.fn("OAuthConnectionHelpers.postForm")(
			function* (url: string, params: Record<string, string>) {
				const request = HttpClientRequest.post(url, {
					headers: { accept: "application/json" },
				}).pipe(HttpClientRequest.bodyUrlParams(params))
				const response = yield* httpClient.execute(request)
				const text = yield* response.text
				return { status: response.status, text }
			},
			Effect.catchTag("HttpClientError", (error) =>
				Effect.fail(
					toUpstreamError(
						`${providerLabel} OAuth request failed: ${error.message}`,
						error.response?.status,
						error.reason,
					),
				),
			),
		)

		const parseTokenPayload = (text: string) =>
			Effect.try({
				try: () => JSON.parse(text) as unknown,
				catch: () => toUpstreamError(`${providerLabel} token endpoint returned a non-JSON response`),
			}).pipe(
				Effect.flatMap((json) =>
					decodeTokenResponse(json).pipe(
						Effect.mapError(() =>
							toUpstreamError(`${providerLabel} token endpoint returned an unexpected payload`),
						),
					),
				),
			)

		const exchangeAuthorizationCode = Effect.fn("OAuthConnectionHelpers.exchangeAuthorizationCode")(
			function* (
				config: OAuthTokenEndpointConfig,
				code: string,
				redirectUri: string,
				extraParams: Record<string, string> = {},
			) {
				const { status, text } = yield* postForm(config.tokenUrl, {
					grant_type: "authorization_code",
					code,
					redirect_uri: redirectUri,
					client_id: config.clientId,
					...(config.clientSecret ? { client_secret: Redacted.value(config.clientSecret) } : {}),
					...extraParams,
				})
				if (status < 200 || status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Token exchange failed: ${text || status}`, status),
					)
				}
				return yield* parseTokenPayload(text)
			},
		)

		/**
		 * Refresh-grant call with the shared classification rule: a 400/401 means
		 * the grant itself is gone (revoked / rotated away), not a transient
		 * upstream failure.
		 */
		const refreshAccessToken = Effect.fn("OAuthConnectionHelpers.refreshAccessToken")(
			function* (config: OAuthTokenEndpointConfig, refreshToken: string) {
				const { status, text } = yield* postForm(config.tokenUrl, {
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: config.clientId,
					...(config.clientSecret ? { client_secret: Redacted.value(config.clientSecret) } : {}),
				})
				if (status === 400 || status === 401) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: `${providerLabel} connection no longer authorized — reconnect required`,
						}),
					)
				}
				if (status < 200 || status >= 300) {
					return yield* Effect.fail(toUpstreamError(`Token refresh failed with ${status}`, status))
				}
				return yield* parseTokenPayload(text)
			},
		)

		const persistRefreshedTokens = Effect.fn("OAuthConnectionHelpers.persistRefreshedTokens")(
			function* (row: OAuthConnectionRow, tokenResponse: OAuthTokenResponse) {
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
			},
		)

		const rowIsValid = (row: OAuthConnectionRow, currentTime: number) =>
			row.expiresAt == null || row.expiresAt.getTime() - currentTime > OAUTH_REFRESH_LEEWAY_MS

		const accessTokenFromRow = (row: OAuthConnectionRow) =>
			decryptValue({
				ciphertext: row.accessTokenCiphertext,
				iv: row.accessTokenIv,
				tag: row.accessTokenTag,
			}).pipe(Effect.map((accessToken) => ({ accessToken, row })))

		// Providers rotate refresh tokens on use, so two concurrent refreshes with the same
		// stored token make the loser 400 — which would falsely surface as "revoked". Serialize
		// refreshes within this isolate (refreshes are rare, one permit is fine) and re-check the
		// row after acquiring: a fiber that waited usually finds the winner's fresh tokens.
		const refreshSemaphore = Semaphore.makeUnsafe(1)

		const refreshWithSingleFlight = (config: OAuthTokenEndpointConfig, orgId: OrgId) =>
			refreshSemaphore.withPermits(1)(
				Effect.gen(function* () {
					// Double-checked: another local fiber may have refreshed while we waited.
					const row = yield* requireConnection(orgId)
					if (rowIsValid(row, yield* Clock.currentTimeMillis)) {
						return yield* accessTokenFromRow(row)
					}

					if (!row.refreshTokenCiphertext || !row.refreshTokenIv || !row.refreshTokenTag) {
						yield* markConnectionRevoked(orgId)
						return yield* Effect.fail(
							new IntegrationsRevokedError({
								message: `${providerLabel} access token expired and no refresh token is stored — reconnect required`,
							}),
						)
					}

					const refreshToken = yield* decryptValue({
						ciphertext: row.refreshTokenCiphertext,
						iv: row.refreshTokenIv,
						tag: row.refreshTokenTag,
					})
					return yield* refreshAccessToken(config, refreshToken).pipe(
						Effect.flatMap((refreshed) =>
							persistRefreshedTokens(row, refreshed).pipe(
								Effect.map((accessToken) => ({ accessToken, row })),
							),
						),
						// Cross-isolate race: a concurrent worker isolate may have consumed the rotated
						// refresh token and persisted new tokens between our read and our refresh. Before
						// declaring the connection revoked, re-read the row — if a newer, valid token
						// landed, use it.
						Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (error) =>
							Effect.gen(function* () {
								const latest = yield* requireConnection(orgId)
								const advanced = latest.updatedAt.getTime() > row.updatedAt.getTime()
								if (advanced && rowIsValid(latest, yield* Clock.currentTimeMillis)) {
									return yield* accessTokenFromRow(latest)
								}
								yield* markConnectionRevoked(orgId)
								return yield* Effect.fail(error)
							}),
						),
					)
				}),
			)

		/**
		 * Decrypted access token for the org's connection, refreshing (single-flight)
		 * when it is within the expiry leeway. Returns the row alongside so callers
		 * can project provider-specific fields (account id, scope, ...).
		 */
		const getValidConnectionToken = Effect.fn("OAuthConnectionHelpers.getValidConnectionToken")(
			function* (config: OAuthTokenEndpointConfig, orgId: OrgId) {
				const row = yield* requireConnection(orgId)
				if (rowIsValid(row, yield* Clock.currentTimeMillis)) {
					return yield* accessTokenFromRow(row)
				}
				return yield* refreshWithSingleFlight(config, orgId)
			},
		)

		return {
			toPersistenceError,
			dbExecute,
			encryptValue,
			decryptValue,
			purgeExpiredStates,
			deleteAuthState,
			requireStateRow,
			loadConnection,
			requireConnection,
			upsertConnection,
			deleteConnection,
			markConnectionRevoked,
			postForm,
			exchangeAuthorizationCode,
			refreshAccessToken,
			persistRefreshedTokens,
			rowIsValid,
			getValidConnectionToken,
		} as const
	})
