import { Schema } from "effect"
import { OrgId } from "../primitives"

/**
 * Internal contract between apps/api and the Railway-hosted Maple Slack bot.
 * The bot calls `GET /internal/slack/workspaces/:teamId` with
 * `Authorization: Bearer maple_svc_<SLACK_INTERNAL_SERVICE_TOKEN>` and gets the
 * bound org's decrypted Slack bot token plus the Maple API key minted for it.
 *
 * The JSON shape is FIXED — the deployed bot is built against exactly these
 * keys, so fields must not be renamed, dropped or made optional.
 */
export const SlackBotResolutionResponseSchema = Schema.Struct({
	orgId: OrgId,
	teamId: Schema.String,
	teamName: Schema.NullOr(Schema.String),
	botToken: Schema.String,
	mapleApiKey: Schema.String,
})

export type SlackBotResolution = Schema.Schema.Type<typeof SlackBotResolutionResponseSchema>
