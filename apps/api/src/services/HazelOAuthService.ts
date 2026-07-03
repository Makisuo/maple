import { randomBytes } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type HazelChannelSummary,
	type HazelOrganizationSummary,
	OrgId,
	type UserId,
} from "@maple/domain/http"
import { oauthAuthStates } from "@maple/db"
import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Env, type EnvShape } from "../lib/Env"
import { Database } from "../lib/DatabaseLive"
import { msToDate } from "../lib/time"
import {
	makeOAuthConnectionHelpers,
	OAUTH_STATE_TTL_MS,
	toUpstreamError,
} from "./oauth/connection-helpers"

const HAZEL_PROVIDER = "hazel"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)

const UserInfoSchema = Schema.Struct({
	sub: Schema.String,
	email: Schema.optionalKey(Schema.String),
	email_verified: Schema.optionalKey(Schema.Boolean),
	name: Schema.optionalKey(Schema.String),
})

const HazelOrganizationsResponseSchema = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			slug: Schema.NullOr(Schema.String),
			logoUrl: Schema.NullOr(Schema.String),
		}),
	),
})

const HazelChannelsResponseSchema = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			type: Schema.Literals(["public", "private"]),
			organizationId: Schema.String,
		}),
	),
})

const HazelChannelWebhookResponseSchema = Schema.Struct({
	id: Schema.String,
	channelId: Schema.String,
	organizationId: Schema.String,
	name: Schema.String,
	webhookUrl: Schema.String,
	token: Schema.String,
})

const DiscoveryDocumentSchema = Schema.Struct({
	authorization_endpoint: Schema.String,
	token_endpoint: Schema.String,
	userinfo_endpoint: Schema.optionalKey(Schema.String),
})

const decodeUserInfo = Schema.decodeUnknownEffect(UserInfoSchema)
const decodeOrganizationsResponse = Schema.decodeUnknownEffect(HazelOrganizationsResponseSchema)
const decodeChannelsResponse = Schema.decodeUnknownEffect(HazelChannelsResponseSchema)
const decodeChannelWebhookResponse = Schema.decodeUnknownEffect(HazelChannelWebhookResponseSchema)
const decodeDiscoveryDocument = Schema.decodeUnknownEffect(DiscoveryDocumentSchema)

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

const resolveEnv = Effect.fn("HazelOAuthService.resolveEnv")(
	function* (env: EnvShape) {
		const requireSome = <A>(
			opt: Option.Option<A>,
			message: string,
		): Effect.Effect<A, IntegrationsValidationError> =>
			Option.match(opt, {
				onNone: () => Effect.fail(new IntegrationsValidationError({ message })),
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
		} satisfies ResolvedHazelOAuthEnv
	},
)

interface HazelOAuthAccessToken {
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
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly completeConnect: (
		code: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly returnTo: string | null },
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<
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
	readonly listOrganizations: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<HazelOrganizationSummary>,
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	readonly listChannels: (
		orgId: OrgId,
		hazelOrganizationId: string,
	) => Effect.Effect<
		ReadonlyArray<HazelChannelSummary>,
		| IntegrationsNotConnectedError
		| IntegrationsRevokedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	readonly createChannelWebhook: (
		orgId: OrgId,
		options: {
			readonly channelId: string
			readonly name: string
			readonly description?: string
		},
	) => Effect.Effect<
		{
			readonly id: string
			readonly channelId: string
			readonly organizationId: string
			readonly name: string
			readonly webhookUrl: string
			readonly token: string
		},
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

export class HazelOAuthService extends Context.Service<HazelOAuthService, HazelOAuthServiceShape>()(
	"@maple/api/services/HazelOAuthService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const oauth = yield* makeOAuthConnectionHelpers({
				provider: HAZEL_PROVIDER,
				providerLabel: "Hazel",
				database,
				env,
			})

			const fetchDiscoveryDocument = Effect.fn("HazelOAuthService.fetchDiscoveryDocument")(
				function* (discoveryUrl: string) {
					const response = yield* httpClient
						.get(discoveryUrl, { headers: { accept: "application/json" } })
						.pipe(
							Effect.mapError((cause) =>
								toUpstreamError(`OIDC discovery fetch failed: ${cause.message}`),
							),
						)
					if (response.status < 200 || response.status >= 300) {
						return yield* Effect.fail(
							toUpstreamError(`OIDC discovery returned ${response.status}`, response.status),
						)
					}
					const json = yield* response.json.pipe(
						Effect.mapError((cause) =>
							toUpstreamError("OIDC discovery returned a non-JSON response", undefined, cause),
						),
					)
					return yield* decodeDiscoveryDocument(json).pipe(
						Effect.mapError((cause) =>
							toUpstreamError(
								"OIDC discovery returned an unexpected payload",
								undefined,
								cause,
							),
						),
					)
				},
			)

			const cachedDiscovery = yield* Ref.make<{
				url: string
				doc: Schema.Schema.Type<typeof DiscoveryDocumentSchema>
			} | null>(null)

			const resolveConfig: Effect.Effect<
				ResolvedHazelOAuthConfig,
				IntegrationsValidationError | IntegrationsUpstreamError
			> = Effect.gen(function* () {
				const base = yield* resolveEnv(env)
				const cached = yield* Ref.get(cachedDiscovery)
				if (cached && cached.url === base.discoveryUrl) {
					return {
						...base,
						authorizeUrl: cached.doc.authorization_endpoint,
						tokenUrl: cached.doc.token_endpoint,
						userInfoUrl:
							cached.doc.userinfo_endpoint ??
							cached.doc.authorization_endpoint.replace(
								/\/oauth\/authorize$/,
								"/oauth/userinfo",
							),
					}
				}
				const doc = yield* fetchDiscoveryDocument(base.discoveryUrl)
				yield* Ref.set(cachedDiscovery, { url: base.discoveryUrl, doc })
				return {
					...base,
					authorizeUrl: doc.authorization_endpoint,
					tokenUrl: doc.token_endpoint,
					userInfoUrl:
						doc.userinfo_endpoint ??
						doc.authorization_endpoint.replace(/\/oauth\/authorize$/, "/oauth/userinfo"),
				}
			})

			const startConnect = Effect.fn("HazelOAuthService.startConnect")(function* (
				orgId: OrgId,
				userId: UserId,
				options: { readonly callbackUrl: string; readonly returnTo?: string },
			) {
				const config = yield* resolveConfig
				const state = randomBytes(24).toString("base64url")
				const currentTime = yield* Clock.currentTimeMillis
				const callbackUrl = options.callbackUrl

				yield* oauth.purgeExpiredStates(currentTime)
				yield* oauth.dbExecute((db) =>
					db.insert(oauthAuthStates).values({
						state,
						orgId,
						provider: HAZEL_PROVIDER,
						initiatedByUserId: userId,
						redirectUri: callbackUrl,
						returnTo: options.returnTo ?? null,
						createdAt: new Date(currentTime),
						expiresAt: new Date(currentTime + OAUTH_STATE_TTL_MS),
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

			const fetchUserInfo = Effect.fn("HazelOAuthService.fetchUserInfo")(
				function* (config: ResolvedHazelOAuthConfig, accessToken: string) {
					const response = yield* httpClient
						.get(config.userInfoUrl, {
							headers: {
								authorization: `Bearer ${accessToken}`,
								accept: "application/json",
							},
						})
						.pipe(
							Effect.mapError((cause) =>
								toUpstreamError(`Userinfo fetch failed: ${cause.message}`),
							),
						)
					if (response.status < 200 || response.status >= 300) {
						return yield* Effect.fail(
							toUpstreamError(`Userinfo fetch failed with ${response.status}`, response.status),
						)
					}
					const json = yield* response.json.pipe(
						Effect.mapError((cause) =>
							toUpstreamError("Userinfo returned a non-JSON response", undefined, cause),
						),
					)
					return yield* decodeUserInfo(json).pipe(
						Effect.mapError((cause) =>
							toUpstreamError("Userinfo returned an unexpected payload", undefined, cause),
						),
					)
				},
			)

			const completeConnect = Effect.fn("HazelOAuthService.completeConnect")(function* (
				code: string,
				state: string,
			) {
				const config = yield* resolveConfig
				const stateRow = yield* oauth.requireStateRow(state)
				yield* oauth.deleteAuthState(state)

				const tokenResponse = yield* oauth.exchangeAuthorizationCode(
					config,
					code,
					stateRow.redirectUri,
				)
				const userInfo = yield* fetchUserInfo(config, tokenResponse.access_token)

				const accessEnc = yield* oauth.encryptValue(tokenResponse.access_token)
				const refreshEnc = tokenResponse.refresh_token
					? yield* oauth.encryptValue(tokenResponse.refresh_token)
					: null
				const currentTime = yield* Clock.currentTimeMillis
				const expiresAt =
					tokenResponse.expires_in != null ? currentTime + tokenResponse.expires_in * 1000 : null
				const orgId = decodeOrgId(stateRow.orgId)

				yield* oauth.upsertConnection(orgId, currentTime, {
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
					expiresAt: msToDate(expiresAt),
				})

				return { orgId, returnTo: stateRow.returnTo ?? null }
			})

			const getValidAccessToken = Effect.fn("HazelOAuthService.getValidAccessToken")(function* (
				orgId: OrgId,
			) {
				const config = yield* resolveConfig
				const { accessToken, row } = yield* oauth.getValidConnectionToken(config, orgId)
				return {
					accessToken,
					externalUserId: row.externalUserId,
				} satisfies HazelOAuthAccessToken
			})

			const getStatus = Effect.fn("HazelOAuthService.getStatus")(function* (orgId: OrgId) {
				const row = yield* oauth.loadConnection(orgId)
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

			const listOrganizations = Effect.fn("HazelOAuthService.listOrganizations")(function* (
				orgId: OrgId,
			) {
				const config = yield* resolveConfig
				const { accessToken } = yield* getValidAccessToken(orgId)
				const response = yield* httpClient
					.get(`${config.apiBaseUrl}/api/v1/organizations`, {
						headers: {
							authorization: `Bearer ${accessToken}`,
							accept: "application/json",
						},
					})
					.pipe(
						Effect.mapError((cause) =>
							toUpstreamError(`Hazel organizations request failed: ${cause.message}`),
						),
					)
				if (response.status === 401) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: "Hazel rejected the access token — reconnect required",
						}),
					)
				}
				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Hazel organizations returned ${response.status}`, response.status),
					)
				}
				const json = yield* response.json.pipe(
					Effect.mapError((cause) =>
						toUpstreamError("Hazel organizations returned a non-JSON response", undefined, cause),
					),
				)
				const decoded = yield* decodeOrganizationsResponse(json).pipe(
					Effect.mapError((cause) =>
						toUpstreamError(
							"Hazel organizations returned an unexpected payload",
							undefined,
							cause,
						),
					),
				)
				return decoded.data.map((o) => ({
					id: o.id,
					name: o.name,
					slug: o.slug,
					logoUrl: o.logoUrl,
				}))
			})

			const listChannels = Effect.fn("HazelOAuthService.listChannels")(function* (
				orgId: OrgId,
				hazelOrganizationId: string,
			) {
				const config = yield* resolveConfig
				const { accessToken } = yield* getValidAccessToken(orgId)
				const encodedOrgId = encodeURIComponent(hazelOrganizationId)
				const response = yield* httpClient
					.get(`${config.apiBaseUrl}/api/v1/organizations/${encodedOrgId}/channels`, {
						headers: {
							authorization: `Bearer ${accessToken}`,
							accept: "application/json",
						},
					})
					.pipe(
						Effect.mapError((cause) =>
							toUpstreamError(`Hazel channels request failed: ${cause.message}`),
						),
					)
				if (response.status === 401) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: "Hazel rejected the access token — reconnect required",
						}),
					)
				}
				if (response.status === 404) {
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "Hazel organization not found or you are not a member",
						}),
					)
				}
				if (response.status < 200 || response.status >= 300) {
					return yield* Effect.fail(
						toUpstreamError(`Hazel channels returned ${response.status}`, response.status),
					)
				}
				const json = yield* response.json.pipe(
					Effect.mapError((cause) =>
						toUpstreamError("Hazel channels returned a non-JSON response", undefined, cause),
					),
				)
				const decoded = yield* decodeChannelsResponse(json).pipe(
					Effect.mapError((cause) =>
						toUpstreamError("Hazel channels returned an unexpected payload", undefined, cause),
					),
				)
				return decoded.data.map((c) => ({
					id: c.id,
					name: c.name,
					type: c.type,
					organizationId: c.organizationId,
				}))
			})

			const createChannelWebhook = Effect.fn("HazelOAuthService.createChannelWebhook")(function* (
				orgId: OrgId,
				options: {
					readonly channelId: string
					readonly name: string
					readonly description?: string
				},
			) {
				const config = yield* resolveConfig
				const { accessToken } = yield* getValidAccessToken(orgId)
				const body: Record<string, unknown> = {
					channelId: options.channelId,
					name: options.name,
					integrationProvider: "maple",
				}
				if (options.description) body.description = options.description
				const request = HttpClientRequest.post(`${config.apiBaseUrl}/api/v1/channel-webhooks`, {
					headers: {
						authorization: `Bearer ${accessToken}`,
						accept: "application/json",
					},
				}).pipe(HttpClientRequest.bodyJsonUnsafe(body))
				const response = yield* httpClient.execute(request).pipe(
					Effect.mapError((cause) =>
						toUpstreamError(`Hazel webhook provisioning failed: ${cause.message}`),
					),
				)
				if (response.status === 401) {
					return yield* Effect.fail(
						new IntegrationsRevokedError({
							message: "Hazel rejected the access token — reconnect required",
						}),
					)
				}
				if (response.status === 404) {
					return yield* Effect.fail(
						new IntegrationsValidationError({
							message: "Hazel channel not found — pick a different channel and try again",
						}),
					)
				}
				if (response.status < 200 || response.status >= 300) {
					const text = yield* response.text.pipe(
						Effect.mapError(() =>
							toUpstreamError(
								`Hazel webhook provisioning returned ${response.status}`,
								response.status,
							),
						),
					)
					return yield* Effect.fail(
						toUpstreamError(
							`Hazel webhook provisioning failed: ${text || response.status}`,
							response.status,
						),
					)
				}
				const json = yield* response.json.pipe(
					Effect.mapError((cause) =>
						toUpstreamError(
							"Hazel webhook provisioning returned a non-JSON response",
							undefined,
							cause,
						),
					),
				)
				return yield* decodeChannelWebhookResponse(json).pipe(
					Effect.mapError((cause) =>
						toUpstreamError(
							"Hazel webhook provisioning returned an unexpected payload",
							undefined,
							cause,
						),
					),
				)
			})

			const disconnect = Effect.fn("HazelOAuthService.disconnect")(function* (orgId: OrgId) {
				return yield* oauth.deleteConnection(orgId)
			})

			return {
				startConnect,
				completeConnect,
				getStatus,
				getValidAccessToken,
				listOrganizations,
				listChannels,
				createChannelWebhook,
				disconnect,
			} satisfies HazelOAuthServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
