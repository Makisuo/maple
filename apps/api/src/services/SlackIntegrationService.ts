import { randomBytes, randomUUID } from "node:crypto"
import {
	ApiKeyId,
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	UserId,
	type OAuthStatePersistenceError,
	type SlackBotResolution,
} from "@maple/domain/http"
import { slackWorkspaces, type SlackWorkspaceRow } from "@maple/db"
import { and, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Array as Arr, Clock, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "../lib/Crypto"
import { Database, type DatabaseError } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { ApiKeysService } from "./ApiKeysService"
import { OAuthStateRepository } from "./OAuthStateRepository"
import { loadActiveWorkspaceByOrg, slackSecretAad, type SlackSecretColumn } from "./slack-bot-token"

const SLACK_PROVIDER = "slack"
const SLACK_STATE_TTL_MS = 10 * 60_000 // 10 minutes
const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access"
const SLACK_OAUTH_REVOKE_URL = "https://slack.com/api/auth.revoke"
const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list"
const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test"
const SLACK_MAX_CHANNEL_PAGES = 3

/** Why a workspace binding was revoked without going through `uninstall`. */
export type SlackRevocationReason = "app_uninstalled" | "tokens_revoked" | "reconciliation"

/**
 * The remote members of the `revoked_reason` column — revocations Maple learned
 * about rather than initiated (`uninstalled` / `superseded` are the local ones).
 * `getStatus` surfaces these so the dashboard can say "disconnected from Slack's
 * side" instead of silently reverting to the not-installed state.
 */
const REMOTE_REVOCATION_REASONS: ReadonlySet<string> = new Set([
	"app_uninstalled",
	"tokens_revoked",
	"reconciliation",
] satisfies ReadonlyArray<SlackRevocationReason>)

const asRemoteRevocationReason = (reason: string | null): SlackRevocationReason | null =>
	reason !== null && REMOTE_REVOCATION_REASONS.has(reason) ? (reason as SlackRevocationReason) : null

const CROSS_ORG_CONFLICT_MESSAGE =
	"This Slack workspace is already connected to a different Maple organization. Uninstall it there first."

/** Public callback path Slack redirects to after an install (mounted in app.ts). */
export const SLACK_CALLBACK_PATH = "/oauth/slack/callback"

/**
 * The bot scopes Maple requests at install time. `chat:write.public` lets the
 * bot post to public channels it hasn't been invited to; `im:*` power the DM
 * agent surface. Keep in sync with the Slack app manifest.
 */
const SLACK_BOT_SCOPE_LIST = [
	"app_mentions:read",
	"chat:write",
	"chat:write.public",
	"channels:read",
	"channels:history",
	"files:write",
	"groups:read",
	"groups:history",
	"im:history",
	"im:read",
	"im:write",
	// Instant "received" ack: the agent reacts :eyes: to messages it will
	// work on (apps/slack-agent agent/lib/ack-reaction.ts).
	"reactions:write",
	"users:read",
] as const

export const SLACK_BOT_SCOPES = SLACK_BOT_SCOPE_LIST.join(",")

/**
 * Required scopes the stored grant is missing — the "needs a reconnect" signal
 * `getStatus` exposes so the dashboard can prompt an in-place OAuth re-install
 * when {@link SLACK_BOT_SCOPES} grows. A `null` stored scope (a pre-column row)
 * yields no drift: with no record of what was granted, an unattended nag could
 * be wrong, and the next successful install backfills the column anyway.
 */
export const missingBotScopes = (grantedScope: string | null): ReadonlyArray<string> => {
	if (grantedScope === null) return []
	const granted = new Set(
		grantedScope
			.split(",")
			.map((scope) => scope.trim())
			.filter((scope) => scope.length > 0),
	)
	return SLACK_BOT_SCOPE_LIST.filter((scope) => !granted.has(scope))
}

/**
 * Thrown inside the install transaction (throwing is the only way to make a
 * drizzle transaction roll back) when the same-team upsert is blocked by an
 * active binding owned by another org. It escapes as the `cause` of the
 * `DatabaseError` wrapping the failed `execute`, where `completeInstall`
 * branches on it — it never leaves `completeInstall`.
 */
class SlackCrossOrgConflict extends Data.TaggedError("SlackCrossOrgConflict")<{
	readonly teamId: string
	readonly orgId: string
}> {}

const decodeApiKeyIdOption = Schema.decodeUnknownOption(ApiKeyId)
const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)

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

const SlackAuthRevokeSchema = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
})
const decodeAuthRevoke = Schema.decodeUnknownEffect(SlackAuthRevokeSchema)

const SlackAuthTestSchema = Schema.Struct({
	ok: Schema.Boolean,
	error: Schema.optionalKey(Schema.String),
})
const decodeAuthTest = Schema.decodeUnknownEffect(SlackAuthTestSchema)

/**
 * `auth.test` error codes that definitively mean the bot token is dead —
 * distinct from transient failures (rate limits, network blips, an unexpected
 * `ok:false` code we don't recognize), which must NOT trigger a revoke since
 * {@link reconcileWorkspaces} runs unattended on a cron and a false positive
 * would silently kill a live integration.
 */
const DEAD_TOKEN_AUTH_TEST_ERRORS: ReadonlySet<string> = new Set([
	"invalid_auth",
	"account_inactive",
	"token_revoked",
	"token_expired",
])

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
	response_metadata: Schema.optionalKey(Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) })),
})
const decodeConversationsList = Schema.decodeUnknownEffect(SlackConversationsListSchema)

// --- Public types -----------------------------------------------------------

export interface SlackInstallStatus {
	readonly installed: boolean
	readonly teamId: string | null
	readonly teamName: string | null
	readonly botUserId: string | null
	readonly installedAt: number | null
	/**
	 * Set only when `installed` is false and the org's most recent installation
	 * was revoked from Slack's side (app uninstalled / tokens revoked / a dead
	 * token found by reconciliation) rather than via Maple's own uninstall.
	 */
	readonly disconnectedReason: SlackRevocationReason | null
	readonly disconnectedTeamName: string | null
	readonly disconnectedAt: number | null
	/**
	 * Required bot scopes the active installation has not granted (see
	 * {@link missingBotScopes}). Non-empty means the dashboard should prompt a
	 * reconnect. Always empty when not installed.
	 */
	readonly missingScopes: ReadonlyArray<string>
}

export interface SlackChannelSummary {
	readonly id: string
	readonly name: string
	readonly isPrivate: boolean
	readonly isMember: boolean
}

// --- Service ----------------------------------------------------------------

export interface SlackIntegrationServiceShape {
	readonly startInstall: (
		orgId: OrgId,
		userId: UserId,
		callbackUrl: string,
	) => Effect.Effect<{ readonly url: string }, IntegrationsValidationError | IntegrationsPersistenceError>
	readonly completeInstall: (
		code: string,
		state: string,
	) => Effect.Effect<
		{ readonly orgId: OrgId; readonly teamName: string | null; readonly updated: boolean },
		| IntegrationsValidationError
		| IntegrationsForbiddenError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly getStatus: (orgId: OrgId) => Effect.Effect<SlackInstallStatus, IntegrationsPersistenceError>
	readonly uninstall: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly uninstalled: boolean }, IntegrationsPersistenceError>
	readonly listChannels: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<SlackChannelSummary>,
		IntegrationsNotConnectedError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly resolveForBot: (
		teamId: string,
	) => Effect.Effect<SlackBotResolution, IntegrationsNotConnectedError | IntegrationsPersistenceError>
	/**
	 * Revoke a workspace binding by Slack team id without calling Slack's
	 * `auth.revoke` — for the two cases where Slack has already told us (or we've
	 * already confirmed) the token is dead: an inbound `app_uninstalled` /
	 * `tokens_revoked` event, or a failed {@link reconcileWorkspaces} probe.
	 * A no-op (`revoked: false`) when the team has no active row.
	 */
	readonly revokeByTeamId: (
		teamId: string,
		reason: SlackRevocationReason,
	) => Effect.Effect<{ readonly revoked: boolean }, IntegrationsPersistenceError>
	/**
	 * Backstop for {@link revokeByTeamId}'s event-driven callers: probes every
	 * active workspace's bot token with `auth.test` and locally revokes any that
	 * Slack confirms are dead. Catches deliveries the Events API webhook never
	 * sent (or that exhausted Slack's retries) and installs that predate it.
	 */
	readonly reconcileWorkspaces: () => Effect.Effect<
		{ readonly probed: number; readonly revoked: number },
		IntegrationsPersistenceError
	>
}

// Standalone with an explicit annotation (rather than inline in the class
// options) so the `SlackIntegrationService.of` in its return does not make the
// class's base expression circular.
const make: Effect.Effect<
	SlackIntegrationServiceShape,
	IntegrationsValidationError,
	Database | Env | ApiKeysService | OAuthStateRepository | HttpClient.HttpClient
> = Effect.gen(function* () {
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

	/** Keeps the source tag in the message so a new member of the union is visible. */
	const toPersistenceError = (error: DatabaseError | OAuthStatePersistenceError) =>
		new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })

	const encryptValue = (
		plaintext: string,
		aad: Buffer,
	): Effect.Effect<EncryptedValue, IntegrationsPersistenceError> =>
		encryptAes256Gcm(
			plaintext,
			encryptionKey,
			(message) => new IntegrationsPersistenceError({ message: `Encryption failed: ${message}` }),
			aad,
		)

	/**
	 * Decrypt one of a row's secret columns. Both are AAD-bound to
	 * `(org_id, team_id, column)`, so a ciphertext moved between rows or columns
	 * fails the GCM tag check and surfaces as a persistence error.
	 */
	const decryptRowSecret = (
		row: SlackWorkspaceRow,
		column: SlackSecretColumn,
	): Effect.Effect<string, IntegrationsPersistenceError> => {
		const encrypted =
			column === "bot_token"
				? { ciphertext: row.botTokenCiphertext, iv: row.botTokenIv, tag: row.botTokenTag }
				: {
						ciphertext: row.apiKeySecretCiphertext,
						iv: row.apiKeySecretIv,
						tag: row.apiKeySecretTag,
					}
		if (encrypted.ciphertext === null || encrypted.iv === null || encrypted.tag === null) {
			return Effect.fail(
				new IntegrationsPersistenceError({
					message: `Stored Slack installation has no ${column === "bot_token" ? "bot token" : "API key"}`,
				}),
			)
		}
		return decryptAes256Gcm(
			{ ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag },
			encryptionKey,
			() => new IntegrationsPersistenceError({ message: "Failed to decrypt stored Slack secret" }),
			slackSecretAad(row.orgId, row.teamId, column),
		)
	}

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
		yield* Effect.annotateCurrentSpan({ orgId })
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
				(error) =>
					new IntegrationsUpstreamError({
						message: `Slack OAuth request failed: ${error.message}`,
						cause: error,
					}),
			),
		)
		const json = yield* response.json.pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsUpstreamError({
						message: `Slack OAuth returned a non-JSON response: ${error.message}`,
						status: response.status,
						cause: error,
					}),
			),
		)
		const decoded = yield* decodeOAuthAccess(json).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsUpstreamError({
						message: `Slack OAuth returned an unexpected payload: ${error.message}`,
						status: response.status,
						cause: error,
					}),
			),
		)
		const accessToken = decoded.access_token
		const team = decoded.team
		if (!decoded.ok || !accessToken || !team?.id) {
			return yield* Effect.fail(
				new IntegrationsValidationError({
					message: `Slack authorization failed: ${decoded.error ?? "missing token or team"}`,
				}),
			)
		}
		return {
			accessToken,
			teamId: team.id,
			teamName: team.name ?? null,
			botUserId: decoded.bot_user_id ?? null,
			scope: decoded.scope ?? null,
		}
	})

	// Known gap: `state` is unguessable, single-use and TTL-bounded, but it is not
	// bound to the browser that started the install. An attacker who gets a Slack
	// admin to complete THEIR authorize URL binds that admin's workspace to the
	// attacker's org. Closing it needs an architecture call we deliberately have
	// not made: (a) set an HttpOnly state cookie on the authenticated v2 install
	// response — needs non-wildcard CORS on the whole public v2 API plus
	// `credentials: "include"` in the web client; (b) a top-level
	// `GET /oauth/slack/start` redirect — useless on its own, it carries no Clerk
	// session and would set the cookie in whichever browser opens the link; or
	// (c) move the callback onto the web app, routing the flow through it.
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

		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored Slack OAuth state has an invalid orgId: ${error.message}`,
					}),
			),
		)
		yield* Effect.annotateCurrentSpan({ orgId })
		const initiatedByUserId = yield* decodeUserId(row.initiatedByUserId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored Slack OAuth state has an invalid userId: ${error.message}`,
					}),
			),
		)
		const access = yield* exchangeCode(code, row.redirectUri, clientId, clientSecret)
		const teamId = access.teamId
		const teamName = access.teamName

		// Reject re-binding a team that is actively installed on a different org.
		const existingByTeam = yield* database
			.execute((db) =>
				db.select().from(slackWorkspaces).where(eq(slackWorkspaces.teamId, teamId)).limit(1),
			)
			.pipe(
				Effect.mapError(toPersistenceError),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
		if (
			Option.isSome(existingByTeam) &&
			existingByTeam.value.orgId !== orgId &&
			existingByTeam.value.revokedAt === null
		) {
			return yield* Effect.fail(new IntegrationsForbiddenError({ message: CROSS_ORG_CONFLICT_MESSAGE }))
		}
		const priorRow = Option.getOrUndefined(existingByTeam)

		// An in-place re-auth: the same org re-runs the OAuth install over its own
		// still-active binding — the flow for granting newly required scopes. The
		// existing API key is KEPT rather than rotated: the Slack agent caches the
		// resolved key with no invalidation hook, so a rotation here would break
		// its MCP calls until the cache expires. Reuse requires the key to still be
		// live (an out-of-band revoke falls back to minting a fresh one), and the
		// stored ciphertext stays valid as-is because its AAD is (org, team, column)
		// and both are unchanged on this path.
		const reusableSecret =
			priorRow !== undefined &&
			priorRow.orgId === orgId &&
			priorRow.revokedAt === null &&
			priorRow.apiKeyId !== null &&
			priorRow.apiKeySecretCiphertext !== null &&
			priorRow.apiKeySecretIv !== null &&
			priorRow.apiKeySecretTag !== null
				? {
						apiKeyId: priorRow.apiKeyId,
						ciphertext: priorRow.apiKeySecretCiphertext,
						iv: priorRow.apiKeySecretIv,
						tag: priorRow.apiKeySecretTag,
					}
				: undefined
		const reusableKeyId = reusableSecret ? decodeApiKeyIdOption(reusableSecret.apiKeyId) : Option.none()
		const priorKeyLive = Option.isSome(reusableKeyId)
			? yield* apiKeys.get(orgId, reusableKeyId.value).pipe(
					Effect.map((key) => !key.revoked && (key.expiresAt === null || key.expiresAt > now)),
					Effect.catch(() => Effect.succeed(false)),
				)
			: false
		const reusedKey = priorKeyLive ? reusableSecret : undefined

		let apiKeyId: string
		let apiKeyEnc: EncryptedValue
		// The minted key exists before the row that points at it, so every failure
		// from here on has to take it back out — otherwise the org keeps an active,
		// unusable full-access key. A no-op on the reuse path.
		let revokeMintedKey: Effect.Effect<void> = Effect.void
		if (reusedKey !== undefined) {
			apiKeyId = reusedKey.apiKeyId
			apiKeyEnc = { ciphertext: reusedKey.ciphertext, iv: reusedKey.iv, tag: reusedKey.tag }
		} else {
			// Mint a full-access MCP-kind API key for the bot; capture the plaintext.
			const created = yield* apiKeys
				.create(orgId, initiatedByUserId, {
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
			revokeMintedKey = apiKeys.revoke(orgId, created.id).pipe(Effect.ignore)
			apiKeyId = created.id
			apiKeyEnc = yield* encryptValue(
				created.secret,
				slackSecretAad(orgId, teamId, "api_key_secret"),
			).pipe(Effect.tapError(() => revokeMintedKey))
		}

		const botTokenEnc = yield* encryptValue(
			access.accessToken,
			slackSecretAad(orgId, teamId, "bot_token"),
		).pipe(Effect.tapError(() => revokeMintedKey))

		const values = {
			id: priorRow?.id ?? randomUUID(),
			orgId,
			teamId,
			teamName,
			botUserId: access.botUserId,
			scope: access.scope ?? SLACK_BOT_SCOPES,
			botTokenCiphertext: botTokenEnc.ciphertext,
			botTokenIv: botTokenEnc.iv,
			botTokenTag: botTokenEnc.tag,
			apiKeyId,
			apiKeySecretCiphertext: apiKeyEnc.ciphertext,
			apiKeySecretIv: apiKeyEnc.iv,
			apiKeySecretTag: apiKeyEnc.tag,
			installedByUserId: row.initiatedByUserId,
			createdAt: new Date(priorRow ? priorRow.createdAt.getTime() : now),
			updatedAt: new Date(now),
			revokedAt: null,
			revokedReason: null,
		}

		// Invariant: at most one active (revoked_at IS NULL) row per org. In one
		// transaction, first revoke any OTHER active workspace for this org (a
		// same-org install of a different team replaces the old one), then upsert
		// the new/refreshed row. The `setWhere` guard makes the cross-org rejection
		// race-safe: a concurrent install of the same team by a different org can't
		// clobber the existing binding — the update is skipped and we abort the
		// transaction (throwing is the only way to make drizzle roll back), and the
		// sentinel resurfaces as the `cause` of the wrapping DatabaseError. The
		// partial unique index on (org_id) is the backstop that ultimately enforces
		// the single-active-row invariant.
		const writeResult = yield* database
			.execute(async (db) =>
				db.transaction(async (tx) => {
					const revokedOthers = await tx
						.update(slackWorkspaces)
						.set({ revokedAt: new Date(now), revokedReason: "superseded", updatedAt: new Date(now) })
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
								revokedReason: null,
							},
						})
						.returning({ id: slackWorkspaces.id })

					// Zero rows means the same-team conflict hit an active row owned by a
					// different org (the setWhere blocked it) — abort so revoke-others
					// rolls back too.
					if (upserted.length === 0) throw new SlackCrossOrgConflict({ teamId, orgId })

					return { revokedOtherKeyIds: revokedOthers.map((r) => r.apiKeyId) }
				}),
			)
			.pipe(
				Effect.mapError((error) =>
					error.cause instanceof SlackCrossOrgConflict
						? new IntegrationsForbiddenError({ message: CROSS_ORG_CONFLICT_MESSAGE })
						: toPersistenceError(error),
				),
				Effect.tapError(() => revokeMintedKey),
			)

		// Best-effort: revoke the API keys of every workspace this install
		// replaced — the prior same-team row (whose key we just rotated — unless
		// this was an in-place re-auth that reused it) and any other-team rows we
		// deactivated above. Bookkeeping must not fail the install now that the DB
		// write has committed.
		const keyIdsToRevoke = [
			reusedKey !== undefined ? null : (priorRow?.apiKeyId ?? null),
			...writeResult.revokedOtherKeyIds,
		]
		yield* Effect.forEach(keyIdsToRevoke, (rawKeyId) => {
			if (!rawKeyId) return Effect.void
			const keyId = decodeApiKeyIdOption(rawKeyId)
			return Option.isSome(keyId) ? apiKeys.revoke(orgId, keyId.value).pipe(Effect.ignore) : Effect.void
		})

		// "Updated" = the org re-authorized its own still-active binding (the
		// permissions-refresh flow) rather than connecting from scratch.
		const updated = priorRow !== undefined && priorRow.orgId === orgId && priorRow.revokedAt === null
		yield* Effect.logInfo(updated ? "Slack workspace re-authorized" : "Slack workspace installed", {
			orgId,
			teamId,
			teamName,
			reusedApiKey: reusedKey !== undefined,
		})
		return { orgId, teamName, updated }
	})

	const getStatus = Effect.fn("SlackIntegrationService.getStatus")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rowOption = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
			Effect.mapError(toPersistenceError),
		)
		if (Option.isSome(rowOption)) {
			const row = rowOption.value
			return {
				installed: true,
				teamId: row.teamId,
				teamName: row.teamName,
				botUserId: row.botUserId,
				installedAt: row.createdAt.getTime(),
				disconnectedReason: null,
				disconnectedTeamName: null,
				disconnectedAt: null,
				missingScopes: missingBotScopes(row.scope),
			} satisfies SlackInstallStatus
		}
		// Not installed — check whether the most recent revocation came from
		// Slack's side, so the dashboard can say "disconnected in Slack" instead
		// of silently reverting to the never-installed state. A dashboard
		// uninstall (`uninstalled`), a replacement install (`superseded`), or a
		// pre-column revocation (null reason) all read as plain not-installed.
		const lastRevoked: SlackWorkspaceRow | undefined = (yield* database
			.execute((db) =>
				db
					.select()
					.from(slackWorkspaces)
					.where(and(eq(slackWorkspaces.orgId, orgId), isNotNull(slackWorkspaces.revokedAt)))
					.orderBy(desc(slackWorkspaces.revokedAt))
					.limit(1),
			)
			.pipe(Effect.mapError(toPersistenceError)))[0]
		const remoteReason = asRemoteRevocationReason(lastRevoked?.revokedReason ?? null)
		return {
			installed: false,
			teamId: null,
			teamName: null,
			botUserId: null,
			installedAt: null,
			disconnectedReason: remoteReason,
			disconnectedTeamName: remoteReason !== null ? (lastRevoked?.teamName ?? null) : null,
			disconnectedAt:
				remoteReason !== null ? (lastRevoked?.revokedAt?.getTime() ?? null) : null,
			missingScopes: [],
		} satisfies SlackInstallStatus
	})

	/** Tell Slack to invalidate the bot token. Callers treat failures as advisory. */
	const revokeBotTokenUpstream = Effect.fnUntraced(function* (botToken: string) {
		const response = yield* httpClient.post(SLACK_OAUTH_REVOKE_URL, {
			headers: { authorization: `Bearer ${botToken}`, accept: "application/json" },
		})
		const decoded = yield* decodeAuthRevoke(yield* response.json)
		if (!decoded.ok) {
			return yield* Effect.fail(
				new IntegrationsUpstreamError({
					message: `Slack auth.revoke error: ${decoded.error ?? "unknown"}`,
					status: response.status,
				}),
			)
		}
	})

	const uninstall = Effect.fn("SlackIntegrationService.uninstall")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		// A concurrent `completeInstall` upserts the SAME row id with fresh secrets
		// and a freshly minted API key, so the revocation update below is a
		// compare-and-set on (id, revoked_at, api_key_id): if it matches 0 rows we
		// lost the race — we revoked only the OLD key and must NOT null the new
		// install's secrets — so re-read and try once more against the fresh row.
		for (let attempt = 0; attempt < 2; attempt++) {
			const rowOption = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
				Effect.mapError(toPersistenceError),
			)
			if (Option.isNone(rowOption)) return { uninstalled: false }
			const row = rowOption.value
			const now = yield* Clock.currentTimeMillis
			// Revoke the minted API key (best-effort — bookkeeping must not fail the uninstall).
			if (row.apiKeyId) {
				const keyId = decodeApiKeyIdOption(row.apiKeyId)
				if (Option.isSome(keyId)) {
					yield* apiKeys.revoke(orgId, keyId.value).pipe(Effect.ignore)
				}
			}
			// Kill the token at Slack too — forgetting it locally leaves a live `xoxb-`
			// token on the workspace. Best-effort like the key revoke above.
			const revoked = yield* decryptRowSecret(row, "bot_token").pipe(
				Effect.flatMap(revokeBotTokenUpstream),
				Effect.tapError((error) =>
					Effect.logWarning("Slack auth.revoke failed", {
						orgId,
						teamId: row.teamId,
						message: error.message,
					}),
				),
				Effect.match({ onFailure: () => false, onSuccess: () => true }),
			)
			// Drop the stored secrets so a revoked row stops holding decryptable
			// credentials. The API key secret always goes: `apiKeys.revoke` above kills
			// it locally and only needs `apiKeyId`. The bot token is kept when Slack
			// did NOT confirm the revoke — it is the only way to retry killing a token
			// that is still live upstream.
			const updated = yield* database
				.execute((db) =>
					db
						.update(slackWorkspaces)
						.set({
							revokedAt: new Date(now),
							revokedReason: "uninstalled",
							updatedAt: new Date(now),
							apiKeySecretCiphertext: null,
							apiKeySecretIv: null,
							apiKeySecretTag: null,
							...(revoked
								? { botTokenCiphertext: null, botTokenIv: null, botTokenTag: null }
								: {}),
						})
						.where(
							and(
								eq(slackWorkspaces.id, row.id),
								isNull(slackWorkspaces.revokedAt),
								row.apiKeyId === null
									? isNull(slackWorkspaces.apiKeyId)
									: eq(slackWorkspaces.apiKeyId, row.apiKeyId),
							),
						)
						.returning({ id: slackWorkspaces.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))
			if (updated.length > 0) {
				yield* Effect.logInfo("Slack workspace uninstalled", { orgId, teamId: row.teamId })
				return { uninstalled: true }
			}
			yield* Effect.logWarning("Slack uninstall lost a race with a concurrent install — retrying", {
				orgId,
				teamId: row.teamId,
			})
		}
		// Two straight losses: a concurrent install keeps refreshing the row.
		// Leaving the newest install active is the correct end state.
		return { uninstalled: false }
	})

	/** Fetch one `conversations.list` page; returns the page's channels + next cursor. */
	const fetchChannelPage = Effect.fnUntraced(function* (botToken: string, cursor: Option.Option<string>) {
		const params = new URLSearchParams({
			types: "public_channel,private_channel",
			exclude_archived: "true",
			limit: "200",
		})
		if (Option.isSome(cursor)) params.set("cursor", cursor.value)
		const response = yield* httpClient
			.get(`${SLACK_CONVERSATIONS_LIST_URL}?${params.toString()}`, {
				headers: { authorization: `Bearer ${botToken}`, accept: "application/json" },
			})
			.pipe(
				Effect.mapError(
					(error) =>
						new IntegrationsUpstreamError({
							message: `Slack conversations.list failed: ${error.message}`,
							cause: error,
						}),
				),
			)
		const json = yield* response.json.pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsUpstreamError({
						message: `Slack conversations.list returned a non-JSON response: ${error.message}`,
						status: response.status,
						cause: error,
					}),
			),
		)
		const decoded = yield* decodeConversationsList(json).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsUpstreamError({
						message: `Slack conversations.list returned an unexpected payload: ${error.message}`,
						status: response.status,
						cause: error,
					}),
			),
		)
		if (!decoded.ok) {
			return yield* Effect.fail(
				new IntegrationsUpstreamError({
					message: `Slack conversations.list error: ${decoded.error ?? "unknown"}`,
					status: response.status,
				}),
			)
		}
		const channels: ReadonlyArray<SlackChannelSummary> = Arr.map(decoded.channels ?? [], (channel) => ({
			id: channel.id,
			name: channel.name ?? channel.id,
			isPrivate: channel.is_private ?? false,
			isMember: channel.is_member ?? false,
		}))
		// Slack signals "no more pages" with a missing or empty next_cursor.
		const next = decoded.response_metadata?.next_cursor
		return { channels, next: next ? Option.some(next) : Option.none<string>() }
	})

	/**
	 * Cursor-driven page walk, capped at {@link SLACK_MAX_CHANNEL_PAGES} pages.
	 */
	const collectChannelPages = Effect.fnUntraced(function* (botToken: string) {
		const collected: Array<SlackChannelSummary> = []
		let cursor = Option.none<string>()
		for (let page = 0; page < SLACK_MAX_CHANNEL_PAGES; page++) {
			const { channels, next } = yield* fetchChannelPage(botToken, cursor)
			collected.push(...channels)
			if (Option.isNone(next)) break
			cursor = next
		}
		return collected
	})

	const listChannels = Effect.fn("SlackIntegrationService.listChannels")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rowOption = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
			Effect.mapError(toPersistenceError),
		)
		if (Option.isNone(rowOption)) {
			return yield* Effect.fail(
				new IntegrationsNotConnectedError({
					message: "Slack is not connected for this organization",
				}),
			)
		}
		const botToken = yield* decryptRowSecret(rowOption.value, "bot_token")
		return yield* collectChannelPages(botToken)
	})

	const resolveForBot = Effect.fn("SlackIntegrationService.resolveForBot")(function* (teamId: string) {
		yield* Effect.annotateCurrentSpan({ teamId })
		const rowOption: Option.Option<SlackWorkspaceRow> = yield* database
			.execute((db) =>
				db
					.select()
					.from(slackWorkspaces)
					.where(and(eq(slackWorkspaces.teamId, teamId), isNull(slackWorkspaces.revokedAt)))
					.limit(1),
			)
			.pipe(
				Effect.mapError(toPersistenceError),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
		if (Option.isNone(rowOption)) {
			return yield* Effect.fail(
				new IntegrationsNotConnectedError({
					message: "No active Slack installation for this team",
				}),
			)
		}
		const row = rowOption.value
		const botToken = yield* decryptRowSecret(row, "bot_token")
		const mapleApiKey = yield* decryptRowSecret(row, "api_key_secret")
		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored Slack workspace has an invalid orgId: ${error.message}`,
					}),
			),
		)
		// The one cross-tenant lookup in this service — the resolved org belongs on
		// the span, not just the team it was resolved from.
		yield* Effect.annotateCurrentSpan({ orgId })
		return {
			orgId,
			teamId: row.teamId,
			teamName: row.teamName,
			botToken,
			mapleApiKey,
		} satisfies SlackBotResolution
	})

	const revokeByTeamId = Effect.fn("SlackIntegrationService.revokeByTeamId")(function* (
		teamId: string,
		reason: SlackRevocationReason,
	) {
		yield* Effect.annotateCurrentSpan({ teamId, reason })
		const rowOption: Option.Option<SlackWorkspaceRow> = yield* database
			.execute((db) =>
				db
					.select()
					.from(slackWorkspaces)
					.where(and(eq(slackWorkspaces.teamId, teamId), isNull(slackWorkspaces.revokedAt)))
					.limit(1),
			)
			.pipe(
				Effect.mapError(toPersistenceError),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
		if (Option.isNone(rowOption)) return { revoked: false }
		const row = rowOption.value
		const orgId = yield* decodeOrgId(row.orgId).pipe(
			Effect.mapError(
				(error) =>
					new IntegrationsPersistenceError({
						message: `Stored Slack workspace has an invalid orgId: ${error.message}`,
					}),
			),
		)
		yield* Effect.annotateCurrentSpan({ orgId })
		const now = yield* Clock.currentTimeMillis
		// Revoke the minted API key (best-effort — bookkeeping must not fail the
		// revoke). Unlike `uninstall`, there is no `auth.revoke` call here: the
		// caller already knows the bot token is dead (Slack told us via the
		// event, or reconciliation just confirmed it via `auth.test`), so both
		// secret columns are always dropped below.
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
					.set({
						revokedAt: new Date(now),
						revokedReason: reason,
						updatedAt: new Date(now),
						apiKeySecretCiphertext: null,
						apiKeySecretIv: null,
						apiKeySecretTag: null,
						botTokenCiphertext: null,
						botTokenIv: null,
						botTokenTag: null,
					})
					.where(eq(slackWorkspaces.id, row.id)),
			)
			.pipe(Effect.mapError(toPersistenceError))
		yield* Effect.logInfo("Slack workspace revoked remotely", { orgId, teamId, reason })
		return { revoked: true }
	})

	/** Ask Slack whether a bot token still works — raw `auth.test` result. */
	const probeBotToken = Effect.fnUntraced(function* (botToken: string) {
		const response = yield* httpClient.post(SLACK_AUTH_TEST_URL, {
			headers: { authorization: `Bearer ${botToken}`, accept: "application/json" },
		})
		return yield* decodeAuthTest(yield* response.json)
	})

	/**
	 * Probe one workspace's bot token; revoke it locally (best-effort) if
	 * `auth.test` gives a definitive dead-token answer. Any other outcome —
	 * `ok:true`, an unrecognized error code, a decrypt failure, a network
	 * error — leaves the row untouched: only a confirmed-dead token is acted
	 * on unattended.
	 */
	const probeAndRevokeIfDead = Effect.fnUntraced(function* (row: SlackWorkspaceRow) {
		const outcome = yield* decryptRowSecret(row, "bot_token").pipe(
			Effect.flatMap(probeBotToken),
			Effect.match({
				onFailure: () => false,
				onSuccess: (decoded) => !decoded.ok && DEAD_TOKEN_AUTH_TEST_ERRORS.has(decoded.error ?? ""),
			}),
		)
		if (!outcome) return false
		// A confirmed-dead token whose local revoke fails must NOT be counted as
		// revoked — the row is still active and the next reconcile run retries it.
		return yield* revokeByTeamId(row.teamId, "reconciliation").pipe(
			Effect.tapError((error) =>
				Effect.logError("Slack reconciliation revoke failed", {
					teamId: row.teamId,
					message: error.message,
				}),
			),
			Effect.match({ onFailure: () => false, onSuccess: () => true }),
		)
	})

	const reconcileWorkspaces = Effect.fn("SlackIntegrationService.reconcileWorkspaces")(function* () {
		const rows: ReadonlyArray<SlackWorkspaceRow> = yield* database
			.execute((db) => db.select().from(slackWorkspaces).where(isNull(slackWorkspaces.revokedAt)))
			.pipe(Effect.mapError(toPersistenceError))
		const revokedFlags = yield* Effect.forEach(rows, probeAndRevokeIfDead)
		const revoked = Arr.filter(revokedFlags, (flag) => flag).length
		yield* Effect.annotateCurrentSpan({
			"slack.reconcile.probed": rows.length,
			"slack.reconcile.revoked": revoked,
		})
		return { probed: rows.length, revoked }
	})

	return SlackIntegrationService.of({
		startInstall,
		completeInstall,
		getStatus,
		uninstall,
		listChannels,
		resolveForBot,
		revokeByTeamId,
		reconcileWorkspaces,
	})
})

export class SlackIntegrationService extends Context.Service<
	SlackIntegrationService,
	SlackIntegrationServiceShape
>()("@maple/api/services/SlackIntegrationService", { make }) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
