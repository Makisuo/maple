import {
	AlertDeliveryError,
	AlertDeliveryTargetMissingError,
	type AlertDeliveryFailure,
	type OrgId,
} from "@maple/domain/http"
import { Effect, Result, Schema } from "effect"
import {
	buildSlackBlocks,
	buildSlackBlocksFromTemplate,
	buildSlackFallbackText,
} from "../../AlertDeliveryDispatch"
import { slackAttachmentColor } from "../../alert-formatting"
import type { HttpTransport, ProviderAck, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"slack-bot">

export interface SlackTransportDeps {
	readonly resolveSlackBotToken: (orgId: OrgId) => Effect.Effect<string, AlertDeliveryFailure>
}

/**
 * Slack Web API `chat.postMessage` response envelope. Slack returns HTTP 200
 * with `{ ok: false, error }` on logical failures, so the body — not the status
 * — is the source of truth.
 */
const SlackPostMessageResponseSchema = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	error: Schema.optionalKey(Schema.String),
	ts: Schema.optionalKey(Schema.String),
})
const decodeSlackResponse = Schema.decodeUnknownResult(SlackPostMessageResponseSchema)

const slackError = (message: string, providerErrorCode?: string) =>
	new AlertDeliveryError({
		message,
		destinationType: "slack-bot",
		...(providerErrorCode === undefined ? {} : { providerErrorCode }),
	})

/**
 * The bot token is not in the destination's secret config — it is resolved per
 * org from the `slack_workspaces` row — which is why this is the one transport
 * with a `prepare` step.
 */
export const makeSlackTransport = (deps: SlackTransportDeps): HttpTransport<Config, string> => ({
	kind: "http",
	type: "slack-bot",
	peerService: "slack",
	providerLabel: "Slack",
	prepare: (input) => deps.resolveSlackBotToken(input.context.destination.orgId),
	render: (input: RenderInput<Config>, botToken: string) => {
		const { context, templated, linkUrl, chatUrl } = input
		const blocks = templated
			? buildSlackBlocksFromTemplate(templated.title, templated.body, context, linkUrl, chatUrl)
			: buildSlackBlocks(context, linkUrl, chatUrl)
		return {
			// Fixed vendor host; the credential is a header, not a path segment.
			url: "https://slack.com/api/chat.postMessage",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${botToken}`,
			},
			guarded: false,
			sensitivePath: false,
			body: JSON.stringify({
				channel: input.config.channelId,
				// Blocks ride inside a colored attachment so the message carries the
				// severity color bar (which has no Block Kit equivalent). No
				// top-level `text`: alongside attachments Slack renders it as a
				// duplicate line above the bar, so `fallback` carries the
				// notification-preview one-liner instead.
				attachments: [
					{
						color: slackAttachmentColor(context.eventType, context.severity),
						fallback: templated?.title ?? buildSlackFallbackText(context),
						blocks,
					},
				],
			}),
		}
	},
	interpret: (input, rawBody): Result.Result<ProviderAck, AlertDeliveryFailure> => {
		const parsed = Result.try({
			try: (): unknown => JSON.parse(rawBody),
			catch: () => slackError("Slack returned a non-JSON response"),
		})
		if (Result.isFailure(parsed)) return Result.fail(parsed.failure)

		const decoded = decodeSlackResponse(parsed.success)
		if (Result.isFailure(decoded)) {
			return Result.fail(
				slackError(`Slack returned an unexpected response payload: ${decoded.failure.message}`),
			)
		}

		const payload = decoded.success
		if (!payload.ok) {
			const error = payload.error ?? "unknown_error"
			// Slack reports channel problems as HTTP 200 + `ok:false`, so the status
			// classifier never sees them. These are the dominant operational failure
			// (a rename or a kick) and no amount of retrying fixes either — someone
			// has to re-invite the bot or repoint the destination.
			if (error === "not_in_channel" || error === "channel_not_found") {
				return Result.fail(
					new AlertDeliveryTargetMissingError({
						message: `Slack rejected the message (${error}) — invite the Maple bot to the channel and try again`,
						destinationType: "slack-bot",
						providerErrorCode: error,
					}),
				)
			}
			return Result.fail(slackError(`Slack rejected the message: ${error}`, error))
		}
		return Result.succeed({
			providerMessage: `Delivered to Slack #${input.config.channelName ?? input.config.channelId}`,
			providerReference: payload.ts ?? null,
		})
	},
	// Unreachable: `interpret` always claims the response. Present because the
	// interface requires a success shape for the no-interpret path.
	ack: (input) => ({
		providerMessage: `Delivered to Slack #${input.config.channelName ?? input.config.channelId}`,
		providerReference: null,
	}),
})
