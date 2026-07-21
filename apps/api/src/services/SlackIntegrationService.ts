import { randomBytes, randomUUID } from "node:crypto"
import {
	AlertDeliveryError,
	ApiKeyId,
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { slackWorkspaces, type SlackWorkspaceRow } from "@maple/db"
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "../lib/Crypto"
import { Database, type DatabaseShape } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { ApiKeysService } from "./ApiKeysService"
import { OAuthStateRepository } from "./OAuthStateRepository"

const SLACK_PROVIDER = "slack"
const SLACK_STATE_TTL_MS = 10 * 60_000 // 10 minutes
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access"
const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list"
const SLACK_MAX_CHANNEL_PAGES = 3

/** Public callback path Slack redirects to after an install (mounted in app.ts). */
export const SLACK_CALLBACK_PATH = "/oauth/slack/callback"

/**
 * The bot scopes Maple requests at install time. `chat:write.public` lets the
 * bot post to public channels it hasn't been invited to; `im:*` power the DM
 * agent surface. Keep in sync with the Slack app manifest.
 */
export const SLACK_BOT_SCOPES = [
	"app_mentions:read",
	"chat:write",
	"chat:write.public",
	"channels:read",
	"groups:read",
	"im:history",
	"im:read",
	"im:write",
	"users:read",
].join(",")

const decodeApiKeyIdOption = Schema.decodeUnknownOption(ApiKeyId)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

// --- Slack API response shapes ---------------------------------------------

const SlackOAuthAccessSchema = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
	access_token: Schema.optionalKey(Schema.String),
	token_type: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	bot_user_id: Schema.optionalKey(Schema.String),
	team: Schema.optionalKey(
		Schema.Struct({
			id: Schema.String,
			name: Schema.optionalKey(Schema.String),
		}),
	),
})
const decodeOAuthAccess = Schema.decodeUnknownEffect(SlackOAuthAccessSchema)

const SlackConversationsListSchema = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
	channels: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.optionalKey(Schema.String),
				is_private: Schema.optionalKey(Schema.Boolean),
				is_member: Schema.optionalKey(Schema.Boolean),
			}),
		),
	),
	response_metadata: Schema.optionalKey(
		Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
	),
})
const decodeConversationsList = Schema.decodeUnknownEffect(SlackConversationsListSchema)

// --- Public types -----------------------------------------------------------

export interface SlackInstallStatus {
	readonly installed: boolean
	readonly teamId: string | null
	readonly teamName: string | null
	readonly botUserId: string | null
	readonly installedAt: number | null
}

export interface SlackChannelSummary {
	readonly id: string
	readonly name: string
	readonly isPrivate: boolean
	readonly isMember: boolean
}

export interface SlackBotResolution {
	readonly orgId: string
	readonly teamId: string
	readonly teamName: string | null
	readonly botToken: string
	readonly mapleApiKey: string
}

// --- Shared decrypt helper (also used by the alert dispatch path) -----------

const loadActiveWorkspaceByOrg = (database: DatabaseShape, orgId: string) =>
	database
		.execute((db) =>
			db
				.select()
				.from(slackWorkspaces)
				.where(and(eq(slackWorkspaces.orgId, orgId), isNull(slackWorkspaces.revokedAt)))
				.limit(1),
		)
		.pipe(Effect.map((rows) => rows[0] ?? null))

/**
 * Resolve the decrypted Slack bot token for an org's active installation.
 * Shared by the alert-delivery `slack-bot` arm (both apps/api and the alerting
 * worker) so those dispatchers do not need the full SlackIntegrationService.
 * Fails with an {@link AlertDeliveryError} when there is no active install.
 */
export const resolveSlackBotTokenForDispatch = (
	database: DatabaseShape,
	encryptionKey: Buffer,
	orgId: string,
): Effect.Effect<string, AlertDeliveryError> =>
	Effect.gen(function* () {
		const row = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
			Effect.mapError(
				(error) =>
					new AlertDeliveryError({
						message: `Failed to load Slack installation: ${error.message}`,
						destinationType: "slack-bot",
					}),
			),
		)
		if (!row) {
			return yield* Effect.fail(
				new AlertDeliveryError({
					message: "Slack is not connected for this organization — install the Maple Slack app",
					destinationType: "slack-bot",
				}),
			)
		}
		return yield* decryptAes256Gcm(
			{ ciphertext: row.botTokenCiphertext, iv: row.botTokenIv, tag: row.botTokenTag },
			encryptionKey,
			() =>
				new AlertDeliveryError({
					message: "Failed to decrypt stored Slack bot token",
					destinationType: "slack-bot",
				}),
		)
	})

// --- Service ----------------------------------------------------------------

export interface SlackIntegrationServiceShape {
	readonly startInstall: (
		orgId: OrgId,
		userId: UserId,
		callbackUrl: string,
	) => Effect.Effect<
		{ readonly url: string },
		IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly completeInstall: (
		code: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly teamName: string | null },
		| IntegrationsValidationError
		| IntegrationsForbiddenError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<SlackInstallStatus, IntegrationsPersistenceError>
	readonly uninstall: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly uninstalled: boolean }, IntegrationsPersistenceError>
	readonly listChannels: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<SlackChannelSummary>,
		| IntegrationsNotConnectedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
		| IntegrationsValidationError
	>
	readonly resolveForBot: (
		teamId: string,
	) => Effect.Effect<SlackBotResolution, IntegrationsNotConnectedError | IntegrationsPersistenceError>
}

export class SlackIntegrationService extends Context.Service<
	SlackIntegrationService,
	SlackIntegrationServiceShape
>()("@maple/api/services/SlackIntegrationService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const apiKeys = yield* ApiKeysService
		const states = yield* OAuthStateRepository
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

		const toPersistenceError = (error: { readonly message: string }) =>
			new IntegrationsPersistenceError({ message: error.message })

		const encryptValue = (plaintext: string): Effect.Effect<EncryptedValue, IntegrationsPersistenceError> =>
			encryptAes256Gcm(
				plaintext,
				encryptionKey,
				(message) => new IntegrationsPersistenceError({ message: `Encryption failed: ${message}` }),
			)

		const decryptValue = (
			encrypted: EncryptedValue,
		): Effect.Effect<string, IntegrationsPersistenceError> =>
			decryptAes256Gcm(
				encrypted,
				encryptionKey,
				() => new IntegrationsPersistenceError({ message: "Failed to decrypt stored Slack secret" }),
			)

		const requireOAuthClient = Effect.gen(function* () {
			const clientId = Option.getOrUndefined(env.SLACK_CLIENT_ID)
			const clientSecret = Option.match(env.SLACK_CLIENT_SECRET, {
				onNone: () => undefined,
				onSome: (value) => Redacted.value(value),
			})
			if (!clientId || !clientSecret) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "Slack integration is not configured (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)",
					}),
				)
			}
			return { clientId, clientSecret }
		})

		const startInstall = Effect.fn("SlackIntegrationService.startInstall")(function* (
			orgId: OrgId,
			userId: UserId,
			callbackUrl: string,
		) {
			const { clientId } = yield* requireOAuthClient
			const state = randomBytes(24).toString("base64url")
			const now = yield* Clock.currentTimeMillis
			yield* states.purgeExpired(now).pipe(Effect.mapError(toPersistenceError))
			yield* states
				.insert({
					state,
					orgId,
					provider: SLACK_PROVIDER,
					initiatedByUserId: userId,
					redirectUri: callbackUrl,
					returnTo: null,
					createdAt: new Date(now),
					expiresAt: new Date(now + SLACK_STATE_TTL_MS),
				})
				.pipe(Effect.mapError(toPersistenceError))

			const params = new URLSearchParams({
				client_id: clientId,
				scope: SLACK_BOT_SCOPES,
				state,
				redirect_uri: callbackUrl,
			})
			return { url: `https://slack.com/oauth/v2/authorize?${params.toString()}` }
		})

		const exchangeCode = Effect.fn("SlackIntegrationService.exchangeCode")(function* (
			code: string,
			redirectUri: string,
			clientId: string,
			clientSecret: string,
		) {
			const request = HttpClientRequest.post(SLACK_OAUTH_ACCESS_URL, {
				headers: { accept: "application/json" },
			}).pipe(
				HttpClientRequest.bodyUrlParams({
					client_id: clientId,
					client_secret: clientSecret,
					code,
					redirect_uri: redirectUri,
				}),
			)
			const response = yield* httpClient.execute(request).pipe(
				Effect.mapError(
					(error) => new IntegrationsUpstreamError({ message: `Slack OAuth request failed: ${error.message}` }),
				),
			)
			const json = yield* response.json.pipe(
				Effect.mapError(
					() => new IntegrationsUpstreamError({ message: "Slack OAuth returned a non-JSON response" }),
				),
			)
			const decoded = yield* decodeOAuthAccess(json).pipe(
				Effect.mapError(
					() => new IntegrationsUpstreamError({ message: "Slack OAuth returned an unexpected payload" }),
				),
			)
			if (!decoded.ok || !decoded.access_token || !decoded.team?.id) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: `Slack authorization failed: ${decoded.error ?? "missing token or team"}`,
					}),
				)
			}
			return decoded as typeof decoded & {
				access_token: string
				team: { id: string; name?: string }
			}
		})

		const completeInstall = Effect.fn("SlackIntegrationService.completeInstall")(function* (
			code: string,
			state: string,
		) {
			const { clientId, clientSecret } = yield* requireOAuthClient
			const stateRow = yield* states.findByState(state).pipe(Effect.mapError(toPersistenceError))
			if (Option.isNone(stateRow) || stateRow.value.provider !== SLACK_PROVIDER) {
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "Slack state not recognized — restart the install flow",
					}),
				)
			}
			const row = stateRow.value
			const now = yield* Clock.currentTimeMillis
			if (row.expiresAt.getTime() < now) {
				yield* states.deleteByState(state).pipe(Effect.mapError(toPersistenceError))
				return yield* Effect.fail(
					new IntegrationsValidationError({
						message: "Slack state expired — restart the install flow",
					}),
				)
			}
			// Single-use: burn the state before doing any side effects.
			yield* states.deleteByState(state).pipe(Effect.mapError(toPersistenceError))

			const orgId = decodeOrgIdSync(row.orgId)
			const access = yield* exchangeCode(code, row.redirectUri, clientId, clientSecret)
			const teamId = access.team.id
			const teamName = access.team.name ?? null

			// Reject re-binding a team that is actively installed on a different org.
			const existingByTeam = yield* database
				.execute((db) =>
					db.select().from(slackWorkspaces).where(eq(slackWorkspaces.teamId, teamId)).limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const priorRow = existingByTeam[0] ?? null
			if (priorRow && priorRow.orgId !== orgId && priorRow.revokedAt === null) {
				return yield* Effect.fail(
					new IntegrationsForbiddenError({
						message:
							"This Slack workspace is already connected to a different Maple organization. Uninstall it there first.",
					}),
				)
			}

			// Mint a full-access MCP-kind API key for the bot; capture the plaintext.
			const created = yield* apiKeys
				.create(orgId, decodeUserIdSync(row.initiatedByUserId), {
					name: `Slack bot (${teamName ?? teamId})`,
					kind: "mcp",
					scopes: null,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new IntegrationsPersistenceError({
								message: `Failed to mint Slack API key: ${error.message}`,
							}),
					),
				)

			const botTokenEnc = yield* encryptValue(access.access_token)
			const apiKeyEnc = yield* encryptValue(created.secret)

			const values = {
				id: priorRow?.id ?? randomUUID(),
				orgId,
				teamId,
				teamName,
				botUserId: access.bot_user_id ?? null,
				scope: access.scope ?? SLACK_BOT_SCOPES,
				botTokenCiphertext: botTokenEnc.ciphertext,
				botTokenIv: botTokenEnc.iv,
				botTokenTag: botTokenEnc.tag,
				apiKeyId: created.id,
				apiKeySecretCiphertext: apiKeyEnc.ciphertext,
				apiKeySecretIv: apiKeyEnc.iv,
				apiKeySecretTag: apiKeyEnc.tag,
				installedByUserId: row.initiatedByUserId,
				createdAt: new Date(priorRow ? priorRow.createdAt.getTime() : now),
				updatedAt: new Date(now),
				revokedAt: null,
			}

			// Invariant: at most one active (revoked_at IS NULL) row per org. In one
			// transaction, first revoke any OTHER active workspace for this org (a
			// same-org install of a different team replaces the old one), then upsert
			// the new/refreshed row. The `setWhere` guard makes the cross-org rejection
			// race-safe: a concurrent install of the same team by a different org can't
			// clobber the existing binding — the update is skipped and we roll back with
			// a recognizable sentinel. The partial unique index on (org_id) is the
			// backstop that ultimately enforces the single-active-row invariant.
			const CROSS_ORG_SENTINEL = "SLACK_CROSS_ORG_CONFLICT"
			const writeResult = yield* database
				.execute<{ revokedOtherKeyIds: Array<string | null> }>((db) =>
					db.transaction(async (tx) => {
						const revokedOthers = await tx
							.update(slackWorkspaces)
							.set({ revokedAt: new Date(now), updatedAt: new Date(now) })
							.where(
								and(
									eq(slackWorkspaces.orgId, orgId),
									isNull(slackWorkspaces.revokedAt),
									ne(slackWorkspaces.teamId, teamId),
								),
							)
							.returning({ apiKeyId: slackWorkspaces.apiKeyId })

						const upserted = await tx
							.insert(slackWorkspaces)
							.values(values)
							.onConflictDoUpdate({
								target: slackWorkspaces.teamId,
								// Only allow overwriting a same-team row that belongs to this
								// org or has already been revoked — never an active binding
								// owned by another org.
								setWhere: or(
									eq(slackWorkspaces.orgId, orgId),
									isNotNull(slackWorkspaces.revokedAt),
								),
								set: {
									orgId: values.orgId,
									teamName: values.teamName,
									botUserId: values.botUserId,
									scope: values.scope,
									botTokenCiphertext: values.botTokenCiphertext,
									botTokenIv: values.botTokenIv,
									botTokenTag: values.botTokenTag,
									apiKeyId: values.apiKeyId,
									apiKeySecretCiphertext: values.apiKeySecretCiphertext,
									apiKeySecretIv: values.apiKeySecretIv,
									apiKeySecretTag: values.apiKeySecretTag,
									installedByUserId: values.installedByUserId,
									createdAt: values.createdAt,
									updatedAt: values.updatedAt,
									revokedAt: null,
								},
							})
							.returning({ id: slackWorkspaces.id })

						// Zero rows means the same-team conflict hit an active row owned by a
						// different org (the setWhere blocked it) — abort so revoke-others
						// rolls back too.
						if (upserted.length === 0) throw new Error(CROSS_ORG_SENTINEL)

						return {
							revokedOtherKeyIds: revokedOthers.map((r) => r.apiKeyId),
						}
					}),
				)
				.pipe(
					Effect.catchTag("@maple/api/lib/DatabaseError", (error) =>
						Effect.fail(
							error.message.includes(CROSS_ORG_SENTINEL)
								? new IntegrationsForbiddenError({
										message:
											"This Slack workspace is already connected to a different Maple organization. Uninstall it there first.",
									})
								: toPersistenceError(error),
						),
					),
				)

			// Best-effort: revoke the API keys of every workspace this install
			// replaced — the prior same-team row (whose key we just rotated) and any
			// other-team rows we deactivated above. Bookkeeping must not fail the
			// install now that the DB write has committed.
			const keyIdsToRevoke = [priorRow?.apiKeyId ?? null, ...writeResult.revokedOtherKeyIds]
			yield* Effect.forEach(keyIdsToRevoke, (rawKeyId) => {
				if (!rawKeyId) return Effect.void
				const keyId = decodeApiKeyIdOption(rawKeyId)
				return Option.isSome(keyId)
					? apiKeys.revoke(orgId, keyId.value).pipe(Effect.ignore)
					: Effect.void
			})

			return { orgId, teamName }
		})

		const getStatus = Effect.fn("SlackIntegrationService.getStatus")(function* (orgId: OrgId) {
			const row = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
				Effect.mapError(toPersistenceError),
			)
			if (!row) {
				return {
					installed: false,
					teamId: null,
					teamName: null,
					botUserId: null,
					installedAt: null,
				} satisfies SlackInstallStatus
			}
			return {
				installed: true,
				teamId: row.teamId,
				teamName: row.teamName,
				botUserId: row.botUserId,
				installedAt: row.createdAt.getTime(),
			} satisfies SlackInstallStatus
		})

		const uninstall = Effect.fn("SlackIntegrationService.uninstall")(function* (orgId: OrgId) {
			const row = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
				Effect.mapError(toPersistenceError),
			)
			if (!row) return { uninstalled: false }
			const now = yield* Clock.currentTimeMillis
			// Revoke the minted API key (best-effort — bookkeeping must not fail the uninstall).
			if (row.apiKeyId) {
				const keyId = decodeApiKeyIdOption(row.apiKeyId)
				if (Option.isSome(keyId)) {
					yield* apiKeys.revoke(orgId, keyId.value).pipe(Effect.ignore)
				}
			}
			yield* database
				.execute((db) =>
					db
						.update(slackWorkspaces)
						.set({ revokedAt: new Date(now), updatedAt: new Date(now) })
						.where(eq(slackWorkspaces.id, row.id)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return { uninstalled: true }
		})

		const listChannels = Effect.fn("SlackIntegrationService.listChannels")(function* (orgId: OrgId) {
			const row = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
				Effect.mapError(toPersistenceError),
			)
			if (!row) {
				return yield* Effect.fail(
					new IntegrationsNotConnectedError({
						message: "Slack is not connected for this organization",
					}),
				)
			}
			const botToken = yield* decryptValue({
				ciphertext: row.botTokenCiphertext,
				iv: row.botTokenIv,
				tag: row.botTokenTag,
			})

			const channels: Array<SlackChannelSummary> = []
			let cursor: string | undefined
			for (let page = 0; page < SLACK_MAX_CHANNEL_PAGES; page++) {
				const params = new URLSearchParams({
					types: "public_channel,private_channel",
					exclude_archived: "true",
					limit: "200",
				})
				if (cursor) params.set("cursor", cursor)
				const response = yield* httpClient
					.get(`${SLACK_CONVERSATIONS_LIST_URL}?${params.toString()}`, {
						headers: { authorization: `Bearer ${botToken}`, accept: "application/json" },
					})
					.pipe(
						Effect.mapError(
							(error) =>
								new IntegrationsUpstreamError({
									message: `Slack conversations.list failed: ${error.message}`,
								}),
						),
					)
				const json = yield* response.json.pipe(
					Effect.mapError(
						() =>
							new IntegrationsUpstreamError({
								message: "Slack conversations.list returned a non-JSON response",
							}),
					),
				)
				const decoded = yield* decodeConversationsList(json).pipe(
					Effect.mapError(
						() =>
							new IntegrationsUpstreamError({
								message: "Slack conversations.list returned an unexpected payload",
							}),
					),
				)
				if (!decoded.ok) {
					return yield* Effect.fail(
						new IntegrationsUpstreamError({
							message: `Slack conversations.list error: ${decoded.error ?? "unknown"}`,
						}),
					)
				}
				for (const channel of decoded.channels ?? []) {
					channels.push({
						id: channel.id,
						name: channel.name ?? channel.id,
						isPrivate: channel.is_private ?? false,
						isMember: channel.is_member ?? false,
					})
				}
				const next = decoded.response_metadata?.next_cursor
				if (!next) break
				cursor = next
			}
			return channels
		})

		const resolveForBot = Effect.fn("SlackIntegrationService.resolveForBot")(function* (teamId: string) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(slackWorkspaces)
						.where(and(eq(slackWorkspaces.teamId, teamId), isNull(slackWorkspaces.revokedAt)))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row: SlackWorkspaceRow | undefined = rows[0]
			if (!row) {
				return yield* Effect.fail(
					new IntegrationsNotConnectedError({
						message: "No active Slack installation for this team",
					}),
				)
			}
			const botToken = yield* decryptValue({
				ciphertext: row.botTokenCiphertext,
				iv: row.botTokenIv,
				tag: row.botTokenTag,
			})
			const mapleApiKey = yield* decryptValue({
				ciphertext: row.apiKeySecretCiphertext,
				iv: row.apiKeySecretIv,
				tag: row.apiKeySecretTag,
			})
			return {
				orgId: row.orgId,
				teamId: row.teamId,
				teamName: row.teamName,
				botToken,
				mapleApiKey,
			} satisfies SlackBotResolution
		})

		return {
			startInstall,
			completeInstall,
			getStatus,
			uninstall,
			listChannels,
			resolveForBot,
		} satisfies SlackIntegrationServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
