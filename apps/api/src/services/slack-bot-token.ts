import { slackWorkspaces } from "@maple/db"
import { AlertDeliveryError } from "@maple/domain/http"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Data, Effect, Layer, Option, Redacted } from "effect"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database, type DatabaseShape } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"

/*
 * Slack bot-token resolution for the alert-delivery `slack-bot` arm. This module
 * is imported by the alerting worker (apps/alerting/src/worker.ts) through
 * NotificationDispatcher/AlertsService, whose bundle is size-constrained (CF
 * error 10027, 3 MB) — keep its imports to Database, Crypto and @maple/db so the
 * full SlackIntegrationService (API keys, OAuth state, HttpClient) stays out of
 * that graph.
 */

/** Which `slack_workspaces` secret an AAD binds to. */
export type SlackSecretColumn = "bot_token" | "api_key_secret"

/**
 * AAD for a `slack_workspaces` secret. Authenticated but not stored, so it binds
 * the ciphertext to its row: an attacker with DB write access cannot relocate an
 * `(iv, ciphertext, tag)` triple onto another org's row, and the bot token and
 * the Maple API key are not interchangeable with each other.
 */
export const slackSecretAad = (orgId: string, teamId: string, column: SlackSecretColumn): Buffer =>
	Buffer.from(`slack_workspaces:v1:${orgId}:${teamId}:${column}`, "utf8")

/** The single active (non-revoked) installation for an org, if any. */
export const loadActiveWorkspaceByOrg = Effect.fnUntraced(function* (database: DatabaseShape, orgId: string) {
	const rows = yield* database.execute((db) =>
		db
			.select()
			.from(slackWorkspaces)
			.where(and(eq(slackWorkspaces.orgId, orgId), isNull(slackWorkspaces.revokedAt)))
			.limit(1),
	)
	return Option.fromNullishOr(rows[0])
})

const notConnected = (message: string) => new AlertDeliveryError({ message, destinationType: "slack-bot" })

/**
 * Resolve the decrypted Slack bot token for an org's active installation.
 * Fails with an {@link AlertDeliveryError} when there is no active install.
 */
export const resolveSlackBotTokenForDispatch = Effect.fn("SlackBotTokenResolver.resolve")(function* (
	database: DatabaseShape,
	encryptionKey: Buffer,
	orgId: string,
) {
	yield* Effect.annotateCurrentSpan({ orgId })
	const rowOption = yield* loadActiveWorkspaceByOrg(database, orgId).pipe(
		Effect.mapError((error) => notConnected(`Failed to load Slack installation: ${error.message}`)),
	)
	if (Option.isNone(rowOption)) {
		return yield* Effect.fail(
			notConnected("Slack is not connected for this organization — install the Maple Slack app"),
		)
	}
	const row = rowOption.value
	// The bot-token columns are nulled on uninstall, so an active row always has
	// them — a null here means the row was tampered with or half-written.
	if (row.botTokenCiphertext === null || row.botTokenIv === null || row.botTokenTag === null) {
		return yield* Effect.fail(notConnected("Stored Slack installation has no bot token"))
	}
	return yield* decryptAes256Gcm(
		{ ciphertext: row.botTokenCiphertext, iv: row.botTokenIv, tag: row.botTokenTag },
		encryptionKey,
		() => notConnected("Failed to decrypt stored Slack bot token"),
		slackSecretAad(row.orgId, row.teamId, "bot_token"),
	)
})

class SlackBotTokenConfigError extends Data.TaggedError("@maple/api/services/SlackBotTokenConfigError")<{
	readonly message: string
}> {}

export interface SlackBotTokenResolverShape {
	readonly resolve: (orgId: string) => Effect.Effect<string, AlertDeliveryError>
}

const make: Effect.Effect<SlackBotTokenResolverShape, SlackBotTokenConfigError, Database | Env> = Effect.gen(
	function* () {
		const database = yield* Database
		const env = yield* Env

		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) =>
				new SlackBotTokenConfigError({ message: `MAPLE_INGEST_KEY_ENCRYPTION_KEY: ${message}` }),
		)

		return SlackBotTokenResolver.of({
			resolve: (orgId) => resolveSlackBotTokenForDispatch(database, encryptionKey, orgId),
		})
	},
)

export class SlackBotTokenResolver extends Context.Service<
	SlackBotTokenResolver,
	SlackBotTokenResolverShape
>()("@maple/api/services/SlackBotTokenResolver", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
