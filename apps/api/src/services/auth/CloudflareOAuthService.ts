import { createHash, randomBytes } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	type UserId,
} from "@maple/domain/http"
import { oauthAuthStates } from "@maple/db"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { listAccounts } from "@/services/integrations/CloudflareApi"
import { Database } from "@/platform/DatabaseLive"
import { Env, type EnvConfig } from "@/platform/Env"
import { msToDate } from "@/platform/time"
import { makeOAuthConnectionHelpers, OAUTH_STATE_TTL_MS } from "./oauth/connection-helpers"

const CLOUDFLARE_PROVIDER = "cloudflare"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

/**
 * PKCE (RFC 7636). Cloudflare's OAuth requires PKCE (S256) for public clients — a multi-tenant SaaS
 * that any Cloudflare user can connect — and accepts it for confidential clients too, so we always
 * send it. The `code_verifier` is stashed on the auth-state row and replayed at token exchange.
 */
const generateCodeVerifier = (): string => randomBytes(32).toString("base64url")
const deriveCodeChallenge = (verifier: string): string =>
	createHash("sha256").update(verifier).digest("base64url")

interface ResolvedCloudflareOAuthConfig {
	readonly clientId: string
	/** null for a public (PKCE-only) client — Cloudflare's default for third-party SaaS apps. Redacted until the wire. */
	readonly clientSecret: Redacted.Redacted<string> | null
	readonly authorizeUrl: string
	readonly tokenUrl: string
	readonly revokeUrl: string
	readonly scopes: string
}

const resolveConfig = Effect.fn("CloudflareOAuthService.resolveConfig")(function* (env: EnvConfig) {
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
			onSome: (value) => value,
		}),
		authorizeUrl: env.CLOUDFLARE_OAUTH_AUTHORIZE_URL,
		tokenUrl: env.CLOUDFLARE_OAUTH_TOKEN_URL,
		revokeUrl: env.CLOUDFLARE_OAUTH_REVOKE_URL,
		scopes: env.CLOUDFLARE_OAUTH_SCOPES,
	}
})

interface CloudflareAccessToken {
	readonly accessToken: string
	readonly accountId: string
	/** Granted OAuth scope — lets pollers gate on capability without a second row read. */
	readonly scope: string
}

/** One connected Cloudflare account (one `oauth_connections` row). */
export interface CloudflareConnectedAccount {
	readonly accountId: string
	readonly accountName: string | null
	readonly connectedByUserId: string
	readonly scope: string
	/** True when Cloudflare rejected the stored grant — pollers skip it until reconnect. */
	readonly revoked: boolean
}

export interface CloudflareOAuthServiceApi {
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
		{ readonly orgId: OrgId; readonly accountId: string; readonly returnTo: string | null },
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsRevokedError
		| IntegrationsPersistenceError
	>
	/** Every connected account for the org, oldest connection first. */
	readonly getStatus: (orgId: OrgId) => Effect.Effect<
		{
			readonly connected: boolean
			readonly accounts: ReadonlyArray<CloudflareConnectedAccount>
		},
		IntegrationsPersistenceError
	>
	/**
	 * Fresh access token for one connected account. Without `accountId` the org
	 * must hold exactly one connection — ambiguous lookups fail rather than
	 * silently picking an account.
	 */
	readonly getValidAccessToken: (
		orgId: OrgId,
		accountId?: string,
	) => Effect.Effect<
		CloudflareAccessToken,
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	/** Disconnect one account, or every connected account when `accountId` is omitted. */
	readonly disconnect: (
		orgId: OrgId,
		accountId?: string,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/**
	 * Stamp a connection as revoked so pollers stop retrying it every tick;
	 * cleared automatically when the account reconnects. Best-effort. Without
	 * `accountId` every connection of the org is stamped.
	 */
	readonly markConnectionRevoked: (orgId: OrgId, accountId?: string) => Effect.Effect<void>
}

export class CloudflareOAuthService extends Context.Service<
	CloudflareOAuthService,
	CloudflareOAuthServiceApi
>()("@maple/api/services/CloudflareOAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const oauth = yield* makeOAuthConnectionHelpers({
			provider: CLOUDFLARE_PROVIDER,
			providerLabel: "Cloudflare",
			database,
			env,
			// One row per Cloudflare account: orgs connect several accounts, each
			// through its own single-account OAuth grant (see completeConnect).
			connectionScope: "per-account",
		})

		/** Best-effort token revocation on disconnect — failures are logged, never surfaced. */
		const revokeToken = (config: ResolvedCloudflareOAuthConfig, token: string) =>
			oauth
				.postForm(config.revokeUrl, {
					token,
					client_id: config.clientId,
					...(config.clientSecret
						? { client_secret: Redacted.value(config.clientSecret) }
						: undefined),
				})
				.pipe(Effect.ignore)

		const startConnect = Effect.fn("CloudflareOAuthService.startConnect")(function* (
			orgId: OrgId,
			userId: UserId,
			options: { readonly callbackUrl: string; readonly returnTo?: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const config = yield* resolveConfig(env)
			const state = randomBytes(24).toString("base64url")
			const codeVerifier = generateCodeVerifier()
			const currentTime = yield* Clock.currentTimeMillis

			yield* oauth.purgeExpiredStates(currentTime)
			yield* oauth.dbExecute((db) =>
				db.insert(oauthAuthStates).values({
					state,
					orgId,
					provider: CLOUDFLARE_PROVIDER,
					initiatedByUserId: userId,
					redirectUri: options.callbackUrl,
					returnTo: options.returnTo ?? null,
					codeVerifier,
					createdAt: new Date(currentTime),
					expiresAt: new Date(currentTime + OAUTH_STATE_TTL_MS),
				}),
			)

			// Cloudflare issues a refresh token only when `offline_access` is REQUESTED here — the
			// client's Refresh Token grant merely makes it available. It is not a data scope, so it
			// stays out of CLOUDFLARE_OAUTH_SCOPES (capability gating/storage) and is appended only to
			// the authorize request. Omitting it silently yields access-token-only connections that
			// die at the ~16h expiry (the 31h outage).
			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: options.callbackUrl,
				response_type: "code",
				scope: `${config.scopes} offline_access`,
				state,
				code_challenge: deriveCodeChallenge(codeVerifier),
				code_challenge_method: "S256",
			})
			return { redirectUrl: `${config.authorizeUrl}?${params.toString()}`, state }
		})

		const completeConnect = Effect.fn("CloudflareOAuthService.completeConnect")(function* (
			code: string,
			state: string,
		) {
			const config = yield* resolveConfig(env)
			const stateRow = yield* oauth.requireStateRow(state)
			yield* oauth.deleteAuthState(state)

			if (!stateRow.codeVerifier) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "OAuth state is missing its PKCE verifier — restart the connect flow",
					}),
				)
			}

			const tokenResponse = yield* oauth.exchangeAuthorizationCode(config, code, stateRow.redirectUri, {
				code_verifier: stateRow.codeVerifier,
			})

			// Resolve — and require exactly one — Cloudflare account per grant. A token that spans
			// multiple accounts is ambiguous for token-refresh scoping (one refresh token cannot be
			// shared by several connection rows without rotation races), so we refuse it; additional
			// accounts connect through their own OAuth round-trips, each becoming its own connection
			// row. On refusal, best-effort revoke the just-issued tokens: they are never persisted,
			// so this is the only moment we can invalidate them upstream.
			const accounts = yield* listAccounts(
				tokenResponse.access_token,
				env.MAPLE_CLOUDFLARE_API_BASE_URL,
			)
			if (accounts.length === 0) {
				yield* revokeToken(config, tokenResponse.access_token)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "The Cloudflare authorization granted access to no accounts",
					}),
				)
			}
			if (accounts.length > 1) {
				yield* revokeToken(config, tokenResponse.access_token)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"The Cloudflare authorization spans multiple accounts — grant access to a single account and connect additional accounts one at a time",
					}),
				)
			}
			const account = accounts[0]!

			const accessEnc = yield* oauth.encryptValue(tokenResponse.access_token)
			const refreshEnc = tokenResponse.refresh_token
				? yield* oauth.encryptValue(tokenResponse.refresh_token)
				: null
			const currentTime = yield* Clock.currentTimeMillis
			const expiresAt =
				tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null
			const orgId = decodeOrgId(stateRow.orgId)
			yield* Effect.annotateCurrentSpan({ orgId })

			// A background poller must renew indefinitely; a connection with no refresh token silently
			// dies at the ~16h access-token expiry and disables every state row (the 31h outage).
			// Refuse it loudly at connect time instead of storing a doomed connection. Best-effort
			// revoke the just-issued access token first — it is never persisted, so this is the only
			// moment we can invalidate it upstream (mirrors the multi-account refusal above).
			if (!tokenResponse.refresh_token) {
				yield* Effect.logWarning(
					"Cloudflare OAuth token exchange returned no refresh token — refusing connection",
					{ orgId, expiresAt },
				)
				yield* revokeToken(config, tokenResponse.access_token)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"Cloudflare returned no refresh token, so this connection would stop working within a day. Confirm the OAuth app grants ‘offline_access’, then reconnect.",
					}),
				)
			}

			yield* oauth.upsertConnection(orgId, currentTime, {
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
			})

			return { orgId, accountId: account.id, returnTo: stateRow.returnTo ?? null }
		})

		const getValidAccessToken = Effect.fn("CloudflareOAuthService.getValidAccessToken")(function* (
			orgId: OrgId,
			accountId?: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const config = yield* resolveConfig(env)
			// No account given: legacy single-connection lookup. Refuse the ambiguous case
			// instead of silently picking whichever row the query returns first.
			if (accountId === undefined) {
				const connections = yield* oauth.listConnections(orgId)
				if (connections.length > 1) {
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message:
								"Multiple Cloudflare accounts are connected — specify which account to use",
						}),
					)
				}
			} else {
				yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
			}
			const { accessToken, row } = yield* oauth.getValidConnectionToken(config, orgId, accountId)
			return {
				accessToken,
				accountId: row.externalUserId,
				scope: row.scope,
			} satisfies CloudflareAccessToken
		})

		const getStatus = Effect.fn("CloudflareOAuthService.getStatus")(function* (orgId: OrgId) {
			const rows = yield* oauth.listConnections(orgId)
			return {
				connected: rows.length > 0,
				accounts: rows.map(
					(row): CloudflareConnectedAccount => ({
						accountId: row.externalUserId,
						accountName: row.externalAccountName,
						connectedByUserId: row.connectedByUserId,
						scope: row.scope,
						revoked: row.revokedAt != null,
					}),
				),
			}
		})

		const disconnect = Effect.fn("CloudflareOAuthService.disconnect")(function* (
			orgId: OrgId,
			accountId?: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			if (accountId !== undefined) {
				yield* Effect.annotateCurrentSpan("maple.cloudflare.account_id", accountId)
			}
			// Best-effort upstream token revocation before we drop the row(s). Never let a revoke
			// failure block the disconnect — the deleted row is the real backstop.
			const rows = yield* oauth.listConnections(orgId)
			const targets =
				accountId === undefined ? rows : rows.filter((r) => r.externalUserId === accountId)
			const config = yield* resolveConfig(env).pipe(Effect.option)
			if (Option.isSome(config)) {
				yield* Effect.forEach(
					targets,
					(row) =>
						oauth
							.decryptValue({
								ciphertext: row.accessTokenCiphertext,
								iv: row.accessTokenIv,
								tag: row.accessTokenTag,
							})
							.pipe(
								Effect.flatMap((accessToken) => revokeToken(config.value, accessToken)),
								Effect.ignore,
							),
					{ discard: true },
				)
			}
			return yield* oauth.deleteConnection(orgId, accountId)
		})

		return {
			startConnect,
			completeConnect,
			getStatus,
			getValidAccessToken,
			disconnect,
			markConnectionRevoked: oauth.markConnectionRevoked,
		} satisfies CloudflareOAuthServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
