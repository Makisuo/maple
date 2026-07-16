import { randomBytes } from "node:crypto"
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
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "../lib/DatabaseLive"
import { Env, type EnvShape } from "../lib/Env"
import { msToDate } from "../lib/time"
import { makeOAuthConnectionHelpers, OAUTH_STATE_TTL_MS, toUpstreamError } from "./oauth/connection-helpers"

const PLANETSCALE_PROVIDER = "planetscale"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

/** OAuth access tokens use the standard Bearer scheme (service tokens used `token id:secret`). */
export const planetScaleBearerHeader = (accessToken: string): string => `Bearer ${accessToken}`

const REQUEST_TIMEOUT = Duration.seconds(15)
/**
 * The exchange mints the token at auth.planetscale.com but the v1 API validates
 * it against its own store — an immediate `invalid_token` right after a
 * successful exchange smells like propagation lag, so wait once before retrying.
 */
const TOKEN_REJECTED_RETRY_DELAY = Duration.seconds(2)
/** Pagination caps for the org listing — same bounds as the inventory poller. */
const PAGE_SIZE = 100
const MAX_PAGES = 10

interface ResolvedPlanetScaleOAuthConfig {
	readonly clientId: string
	/** Always present — PlanetScale OAuth apps are confidential clients (no PKCE). Redacted until the wire. */
	readonly clientSecret: Redacted.Redacted<string>
	readonly authorizeUrl: string
	readonly tokenUrl: string
	/** Space-delimited, resource-prefixed scopes sent in the authorize request. */
	readonly scopes: string
}

const resolveConfig = Effect.fn("PlanetScaleOAuthService.resolveConfig")(function* (env: EnvShape) {
	const clientId = yield* Option.match(env.PLANETSCALE_OAUTH_CLIENT_ID, {
		onNone: () =>
			Effect.fail(
				new IntegrationsValidationError({
					message: "PLANETSCALE_OAUTH_CLIENT_ID is required to use the PlanetScale integration",
				}),
			),
		onSome: (value) => Effect.succeed(value),
	})
	const clientSecret = yield* Option.match(env.PLANETSCALE_OAUTH_CLIENT_SECRET, {
		onNone: () =>
			Effect.fail(
				new IntegrationsValidationError({
					message: "PLANETSCALE_OAUTH_CLIENT_SECRET is required to use the PlanetScale integration",
				}),
			),
		onSome: (value) => Effect.succeed(value),
	})
	return {
		clientId,
		clientSecret,
		authorizeUrl: env.PLANETSCALE_OAUTH_AUTHORIZE_URL,
		tokenUrl: env.PLANETSCALE_OAUTH_TOKEN_URL,
		scopes: env.PLANETSCALE_OAUTH_SCOPES,
	} satisfies ResolvedPlanetScaleOAuthConfig
})

export interface PlanetScaleOrganization {
	readonly id: string
	readonly name: string
}

// Lenient decoders: only the fields we consume. PlanetScale list endpoints wrap
// results in a `{ data: [...] }` envelope.
const OrganizationSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
})
const OrganizationsPageSchema = Schema.Struct({ data: Schema.Array(OrganizationSchema) })
const decodeOrganizationsPage = Schema.decodeUnknownEffect(
	Schema.fromJsonString(OrganizationsPageSchema),
)

/**
 * `GET /oauth/token/info` is doorkeeper-style: a VALID presented token answers
 * 200 with the token's details (scope, expires_in, resource_owner_id — no RFC
 * 7662 `active` field), an invalid one answers 401 `invalid_token`. The verdict
 * is therefore the status code, not a body field. Verified live 2026-07-13.
 */
type TokenIntrospectionVerdict = "valid" | "invalid" | "unknown"

const CurrentUserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const decodeCurrentUser = Schema.decodeUnknownEffect(Schema.fromJsonString(CurrentUserSchema))

export interface PlanetScaleOAuthServiceShape {
	readonly startConnect: (
		orgId: OrgId,
		userId: UserId,
		options: { readonly callbackUrl: string; readonly returnTo?: string },
	) => Effect.Effect<
		{ readonly redirectUrl: string; readonly state: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	/**
	 * Exchange the callback code and persist the grant. Does NOT bind a
	 * PlanetScale organization — the callback route auto-binds when the grant
	 * reaches exactly one org, otherwise the UI's org picker finalizes. The
	 * accessible organizations are returned so the caller can decide without a
	 * second API round-trip.
	 */
	readonly completeConnect: (
		code: string,
		state: string,
	) => Effect.Effect<
		{
			readonly orgId: OrgId
			readonly returnTo: string | null
			readonly organizations: ReadonlyArray<PlanetScaleOrganization>
		},
		| IntegrationsValidationError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly getValidAccessToken: (
		orgId: OrgId,
	) => Effect.Effect<
		{ readonly accessToken: string },
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	/** Organizations the stored grant can access — org-picker material. */
	readonly listOrganizations: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<PlanetScaleOrganization>,
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	/** Whether a grant is stored for the org (drives pendingOrgSelection). */
	readonly hasConnection: (orgId: OrgId) => Effect.Effect<boolean, IntegrationsPersistenceError>
	/** Who authorized the stored grant (null when not connected). */
	readonly connectedByUserId: (
		orgId: OrgId,
	) => Effect.Effect<string | null, IntegrationsPersistenceError>
	/** Drop the stored grant. PlanetScale documents no revoke endpoint. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
}

export class PlanetScaleOAuthService extends Context.Service<
	PlanetScaleOAuthService,
	PlanetScaleOAuthServiceShape
>()("@maple/api/services/PlanetScaleOAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const oauth = yield* makeOAuthConnectionHelpers({
			provider: PLANETSCALE_PROVIDER,
			providerLabel: "PlanetScale",
			database,
			env,
		})
		const apiBase = env.MAPLE_PLANETSCALE_API_BASE_URL.replace(/\/$/, "")

		const apiGetJson = Effect.fn("PlanetScaleOAuthService.apiGetJson")(function* (
			path: string,
			accessToken: string,
		) {
			return yield* Effect.gen(function* () {
				const request = HttpClientRequest.get(`${apiBase}${path}`).pipe(
					HttpClientRequest.setHeaders({
						Authorization: planetScaleBearerHeader(accessToken),
						Accept: "application/json",
					}),
				)
				const res = yield* httpClient.execute(request)
				const text = yield* res.text
				return { status: res.status, text }
			}).pipe(
				Effect.mapError(
					(error) =>
						toUpstreamError(`PlanetScale API request failed: ${error.message}`),
				),
				Effect.timeoutOrElse({
					duration: REQUEST_TIMEOUT,
					orElse: () =>
						Effect.fail(toUpstreamError(`PlanetScale API request timed out: ${path}`)),
				}),
			)
		})

		/**
		 * Ask PlanetScale's auth server whether a token it minted is valid. Purely
		 * diagnostic — never fails, never logs the token. `Option.none` means the
		 * introspection itself was unreachable/undecodable.
		 */
		const introspectToken = Effect.fn("PlanetScaleOAuthService.introspectToken")(function* (
			accessToken: string,
		) {
			return yield* Effect.gen(function* () {
				const request = HttpClientRequest.get(env.PLANETSCALE_OAUTH_TOKEN_INFO_URL).pipe(
					HttpClientRequest.setHeaders({
						Authorization: planetScaleBearerHeader(accessToken),
						Accept: "application/json",
					}),
				)
				const res = yield* httpClient.execute(request)
				const text = yield* res.text
				if (res.status >= 200 && res.status < 300) {
					// The token-info body carries scope/expiry/owner ids, never the token
					// itself — safe (and load-bearing) to log for diagnosis.
					yield* Effect.logInfo("PlanetScale auth server accepted the token on introspection", {
						body: text.slice(0, 300),
					})
					return "valid" satisfies TokenIntrospectionVerdict
				}
				if (res.status === 401 || res.status === 403) {
					yield* Effect.logError("PlanetScale auth server rejected the token on introspection", {
						status: res.status,
						body: text.slice(0, 200),
					})
					return "invalid" satisfies TokenIntrospectionVerdict
				}
				yield* Effect.logWarning("PlanetScale token introspection returned an unexpected status", {
					status: res.status,
				})
				return "unknown" satisfies TokenIntrospectionVerdict
			}).pipe(
				Effect.timeoutOrElse({
					duration: REQUEST_TIMEOUT,
					orElse: () => Effect.succeed("unknown" satisfies TokenIntrospectionVerdict),
				}),
				Effect.catchCause((cause) =>
					Effect.logWarning("PlanetScale token introspection failed", { cause }).pipe(
						Effect.as("unknown" satisfies TokenIntrospectionVerdict),
					),
				),
			)
		})

		const fetchOrganizations = Effect.fn("PlanetScaleOAuthService.fetchOrganizations")(function* (
			accessToken: string,
		) {
			const organizations: Array<PlanetScaleOrganization> = []
			for (let page = 1; page <= MAX_PAGES; page++) {
				const response = yield* apiGetJson(
					`/v1/organizations?page=${page}&per_page=${PAGE_SIZE}`,
					accessToken,
				)
				// A dead grant is a revoked-authorization failure, not a generic
				// upstream one — the org picker keys its reconnect CTA on the tag.
				if (response.status === 401 || response.status === 403) {
					// Surface PlanetScale's own error body — `invalid_token` vs an
					// insufficient-scope message points to very different causes.
					yield* Effect.logError("PlanetScale rejected the OAuth token on /v1/organizations", {
						status: response.status,
						body: response.text.slice(0, 400),
					})
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: `PlanetScale rejected the authorization (HTTP ${response.status}) when listing organizations — reconnect the integration`,
						}),
					)
				}
				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(
							`PlanetScale organizations listing failed with HTTP ${response.status}`,
							response.status,
						),
					)
				}
				const decoded = yield* decodeOrganizationsPage(response.text).pipe(
					Effect.mapError(() =>
						toUpstreamError("PlanetScale organizations listing returned an unexpected payload"),
					),
				)
				organizations.push(...decoded.data)
				if (decoded.data.length < PAGE_SIZE) break
			}
			return organizations
		})

		const startConnect = Effect.fn("PlanetScaleOAuthService.startConnect")(function* (
			orgId: OrgId,
			userId: UserId,
			options: { readonly callbackUrl: string; readonly returnTo?: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const config = yield* resolveConfig(env)
			const state = randomBytes(24).toString("base64url")
			const currentTime = yield* Clock.currentTimeMillis

			yield* oauth.purgeExpiredStates(currentTime)
			yield* oauth.dbExecute((db) =>
				db.insert(oauthAuthStates).values({
					state,
					orgId,
					provider: PLANETSCALE_PROVIDER,
					initiatedByUserId: userId,
					redirectUri: options.callbackUrl,
					returnTo: options.returnTo ?? null,
					createdAt: new Date(currentTime),
					expiresAt: new Date(currentTime + OAUTH_STATE_TTL_MS),
				}),
			)

			// PlanetScale REQUIRES the scope param — the app's configured scopes are the
			// allowed maximum, not an implicit default, so omitting it fails the authorize
			// with `invalid_scope`. Scopes are resource-prefixed (`organization:read_databases`)
			// and space-delimited. No PKCE — PlanetScale OAuth apps are confidential clients
			// authenticated by the client secret at token exchange.
			const params = new URLSearchParams({
				client_id: config.clientId,
				redirect_uri: options.callbackUrl,
				response_type: "code",
				scope: config.scopes,
				state,
			})
			return { redirectUrl: `${config.authorizeUrl}?${params.toString()}`, state }
		})

		const completeConnect = Effect.fn("PlanetScaleOAuthService.completeConnect")(function* (
			code: string,
			state: string,
		) {
			const config = yield* resolveConfig(env)
			const stateRow = yield* oauth.requireStateRow(state)
			yield* oauth.deleteAuthState(state)

			const tokenResponse = yield* oauth.exchangeAuthorizationCode(
				config,
				code,
				stateRow.redirectUri,
			)

			const orgId = decodeOrgId(stateRow.orgId)
			yield* Effect.annotateCurrentSpan({ orgId })

			// Diagnostic: the exchange succeeds but the API rejects the token. Record
			// the token's shape (secret-safe: prefix + length only) and what scopes
			// PlanetScale actually granted — an opaque `pscale_oauth_` token vs a JWT,
			// and the granted-scope string, disambiguate why /v1 says `invalid_token`.
			yield* Effect.annotateCurrentSpan({
				"planetscale.token.granted_scope": tokenResponse.scope ?? "(none)",
				"planetscale.token.type": tokenResponse.token_type ?? "(none)",
				"planetscale.token.prefix": tokenResponse.access_token.slice(0, 13),
				"planetscale.token.length": tokenResponse.access_token.length,
				"planetscale.token.looks_jwt": tokenResponse.access_token.split(".").length === 3,
				"planetscale.token.expires_in": tokenResponse.expires_in ?? "(none)",
			})

			// The background poller and scraper must renew indefinitely; a grant with
			// no refresh token silently dies at the access-token expiry. Refuse it
			// loudly at connect time instead of storing a doomed connection.
			// PlanetScale documents no revoke endpoint, so the refused token simply
			// expires upstream.
			if (!tokenResponse.refresh_token) {
				yield* Effect.logWarning(
					"PlanetScale OAuth token exchange returned no refresh token — refusing connection",
					{ orgId },
				)
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message:
							"PlanetScale returned no refresh token, so this connection would stop working when the access token expires. Reconnect and grant offline access.",
					}),
				)
			}

			// Resolve what the grant can see before persisting anything: a grant with
			// no organizations can never feed metrics, so refuse it up front.
			//
			// A 401 here — milliseconds after a successful exchange — cannot be a real
			// revocation. Retry once (auth→API token-store propagation lag), then
			// introspect the token at the auth server to classify what remains: a dead
			// token means reconnecting may help; an active-but-rejected token means it
			// cannot, and saying "reconnect" would send the user in circles.
			const organizations = yield* fetchOrganizations(tokenResponse.access_token).pipe(
				Effect.catchTag("@maple/http/errors/IntegrationsRevokedError", (rejection) =>
					Effect.gen(function* () {
						yield* Effect.sleep(TOKEN_REJECTED_RETRY_DELAY)
						const retried = yield* Effect.result(fetchOrganizations(tokenResponse.access_token))
						yield* Effect.annotateCurrentSpan({
							"planetscale.orgs.retry_succeeded": Result.isSuccess(retried),
						})
						if (Result.isSuccess(retried)) return retried.success
						if (retried.failure._tag !== "@maple/http/errors/IntegrationsRevokedError") {
							return yield* Effect.fail(retried.failure)
						}

						const verdict = yield* introspectToken(tokenResponse.access_token)
						yield* Effect.annotateCurrentSpan({ "planetscale.token.introspection": verdict })
						if (verdict === "valid") {
							return yield* Effect.fail(
								toUpstreamError(
									"PlanetScale's API rejected the new access token even though PlanetScale's auth server reports it as valid. Reconnecting won't help — try again in a few minutes, and contact support if it persists.",
									401,
								),
							)
						}
						return yield* Effect.fail(rejection)
					}),
				),
			)
			if (organizations.length === 0) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "The PlanetScale authorization grants access to no organizations",
					}),
				)
			}

			// Identify the grant for display. `/v1/user` may be outside the app's
			// scopes — fall back to the first organization id rather than failing.
			const currentUser = yield* apiGetJson("/v1/user", tokenResponse.access_token).pipe(
				Effect.flatMap((response) =>
					response.status >= 200 && response.status < 300
						? decodeCurrentUser(response.text).pipe(Effect.option)
						: Effect.succeedNone,
				),
				Effect.orElseSucceed(() => Option.none<typeof CurrentUserSchema.Type>()),
			)

			const accessEnc = yield* oauth.encryptValue(tokenResponse.access_token)
			const refreshEnc = yield* oauth.encryptValue(tokenResponse.refresh_token)
			const currentTime = yield* Clock.currentTimeMillis
			const expiresAt =
				tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null

			yield* oauth.upsertConnection(orgId, currentTime, {
				externalUserId: Option.match(currentUser, {
					onNone: () => organizations[0]!.id,
					onSome: (user) => user.id,
				}),
				externalUserEmail: Option.match(currentUser, {
					onNone: () => null,
					onSome: (user) => user.email ?? null,
				}),
				// The bound org slug is not known at exchange time (the picker decides);
				// status reads the org from planetscale_connections instead.
				externalAccountName: null,
				connectedByUserId: stateRow.initiatedByUserId,
				scope: tokenResponse.scope ?? "",
				accessTokenCiphertext: accessEnc.ciphertext,
				accessTokenIv: accessEnc.iv,
				accessTokenTag: accessEnc.tag,
				refreshTokenCiphertext: refreshEnc.ciphertext,
				refreshTokenIv: refreshEnc.iv,
				refreshTokenTag: refreshEnc.tag,
				expiresAt: msToDate(expiresAt),
			})

			return { orgId, returnTo: stateRow.returnTo ?? null, organizations }
		})

		const getValidAccessToken = Effect.fn("PlanetScaleOAuthService.getValidAccessToken")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const config = yield* resolveConfig(env)
			const { accessToken } = yield* oauth.getValidConnectionToken(config, orgId)
			return { accessToken }
		})

		const listOrganizations = Effect.fn("PlanetScaleOAuthService.listOrganizations")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const { accessToken } = yield* getValidAccessToken(orgId)
			return yield* fetchOrganizations(accessToken)
		})

		const hasConnection = Effect.fn("PlanetScaleOAuthService.hasConnection")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const row = yield* oauth.loadConnection(orgId)
			return row !== null
		})

		const connectedByUserId = Effect.fn("PlanetScaleOAuthService.connectedByUserId")(function* (
			orgId: OrgId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const row = yield* oauth.loadConnection(orgId)
			return row?.connectedByUserId ?? null
		})

		const disconnect = Effect.fn("PlanetScaleOAuthService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			return yield* oauth.deleteConnection(orgId)
		})

		return {
			startConnect,
			completeConnect,
			getValidAccessToken,
			listOrganizations,
			hasConnection,
			connectedByUserId,
			disconnect,
		} satisfies PlanetScaleOAuthServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
