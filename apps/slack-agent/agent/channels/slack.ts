import { slackChannel } from "eve/channels/slack"
import type { SlackWebhookVerifier } from "eve/channels/slack"
import { acknowledgeIncomingMessage } from "#lib/ack-reaction.js"
import { describeActionsFriendly, truncateTypingStatus } from "#lib/action-status.js"
import { resolveBotToken, verifySlackV0Signature, type SlackTokenContext } from "#lib/maple.js"
import { promoteThreadFollowUp } from "#lib/thread-follow-up.js"
import { forwardUninstallEvent } from "#lib/uninstall-detection.js"

/**
 * Multi-workspace, self-managed Slack app — no Vercel Connect.
 *
 * The Slack signing secret is per-app/static (`SLACK_SIGNING_SECRET`); only the
 * *bot token* varies per workspace. So we:
 *   1. Verify every inbound webhook's v0 signature with the static secret in a
 *      custom `webhookVerifier`.
 *   2. Resolve the outbound bot token per team via Maple's resolve endpoint.
 *      Our patched eve (patches/eve@0.25.3.patch, tracking vercel/eve#222)
 *      passes `{ teamId, channelId, threadTs }` into the credential;
 *      `SLACK_BOT_TOKEN` is the fallback for single-workspace dev and
 *      context-less paths.
 *
 * Slack delivers events to POST /eve/v1/slack.
 */

const webhookVerifier: SlackWebhookVerifier = async (request, body) => {
	const signingSecret = process.env.SLACK_SIGNING_SECRET
	if (!signingSecret) {
		console.warn(
			"[slack-webhook] Rejected inbound Slack webhook: SLACK_SIGNING_SECRET is not set, so no request can be verified.",
		)
		return false
	}

	if (!verifySlackV0Signature(body, request.headers, signingSecret)) {
		console.warn(
			"[slack-webhook] Rejected inbound Slack webhook: v0 signature verification failed (missing headers, stale timestamp, or signature mismatch — check that SLACK_SIGNING_SECRET matches the Slack app).",
		)
		return false
	}

	// app_uninstalled / tokens_revoked: eve only dispatches app_mention + DM
	// events downstream, so it would otherwise drop these as "unsupported".
	// Fired without awaiting — it must never delay this webhook's ack, and it
	// never throws (see forwardUninstallEvent).
	void forwardUninstallEvent(body)

	// Instant "received" ack: react with :eyes: on any message eve will
	// dispatch as an agent turn (mentions + DMs), before the turn is even
	// scheduled. Fired without awaiting — never delays the webhook ack.
	// Slack redelivery retries skip it (`already_reacted` is also tolerated
	// downstream, this just avoids the pointless call).
	const isSlackRetry = request.headers.get("x-slack-retry-num") !== null
	if (!isSlackRetry) void acknowledgeIncomingMessage(body)

	// eve parses whatever body we return, which is also our hook for thread
	// follow-ups: eve only dispatches app_mention + DM events, so an un-mentioned
	// reply in a thread the bot is engaged in gets its `event.type` promoted to
	// "app_mention" here (see #lib/thread-follow-up.js). Everything else passes
	// through verified-but-unchanged.
	try {
		const promoted = await promoteThreadFollowUp(body)
		if (promoted !== null) {
			// A promoted follow-up is agent work too, but its raw body (a plain
			// channel `message`) doesn't qualify above — ack it now that we know
			// the bot is engaged.
			if (!isSlackRetry) void acknowledgeIncomingMessage(promoted)
			return promoted
		}
	} catch (error) {
		console.warn(
			"[slack-webhook] Thread follow-up promotion failed; passing the event through unchanged.",
			error,
		)
	}
	return body
}

export default slackChannel({
	credentials: {
		webhookVerifier,
		// Per-team bot token. Our patched eve passes the outbound call's
		// { teamId, channelId, threadTs }; context-less paths fall back to
		// SLACK_BOT_TOKEN.
		botToken: async (context?: SlackTokenContext) => resolveBotToken(context),
	},
	// Repeated mentions in a thread only inject what's new since the agent's
	// last reply, instead of re-reading the whole thread each time.
	threadContext: { since: "last-agent-reply" },
	events: {
		// Eve's default flashes the raw tool-call label (`maple__list_services
		// startTime=...`) into the typing status. Replace it with a random
		// human phrase per action category (#lib/action-status.js), keeping
		// the default's one nicety: if the model narrated its own reason for
		// the tool calls (`pendingToolCallMessage`, set by the default
		// `message.completed` handler), that text wins over our phrase.
		async "actions.requested"(event, channel) {
			const narrated = channel.state.pendingToolCallMessage
			channel.state.pendingToolCallMessage = null
			await channel.thread.startTyping(
				narrated ? truncateTypingStatus(narrated) : describeActionsFriendly(event.actions),
			)
		},
	},
})
