import { defaultSlackAuth, slackChannel } from "eve/channels/slack"
import type { SlackContext, SlackMentionResult, SlackMessage, SlackWebhookVerifier } from "eve/channels/slack"
import { acknowledgeIncomingMessage } from "#lib/ack-reaction.js"
import { describeActions, truncateTypingStatus } from "#lib/action-status.js"
import { botUserIdForTeam, rememberBotUserId } from "#lib/bot-identity.js"
import { loadChannelContext } from "#lib/channel-context.js"
import { resolveBotToken, verifySlackV0Signature, type SlackTokenContext } from "#lib/maple.js"
import { loadThreadContext } from "#lib/thread-context.js"
import { promoteThreadFollowUp, recordThreadEngagement } from "#lib/thread-follow-up.js"
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

	// Every event_callback names this workspace's bot user under
	// `authorizations`, so thread-context attribution gets it for free — no
	// auth.test round-trip (#lib/bot-identity.js).
	rememberBotUserId(body)

	// Learn engagement from events that already prove it — the bot's own posts
	// echoing back, and @mentions of it — so the promotion below can answer from
	// cache instead of spending Slack's webhook budget on `conversations.replies`
	// in a thread the bot is demonstrably active in (#lib/thread-follow-up.js).
	// Synchronous and network-free; must run before the promotion.
	recordThreadEngagement(body)

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

/**
 * Stands in for eve's default mention/DM pipeline: same two steps — a
 * "Thinking..." typing indicator and workspace-scoped auth derivation — plus
 * the conversation around the mention as turn context.
 *
 * The context is ours rather than the channel's `threadContext` option because
 * eve reads a message's content from `text` alone and treats every bot post as
 * the agent's own last reply. Maple's alert notifications are Block Kit inside
 * an attachment with no top-level text, so both rules misfired at once and an
 * @mention in an alert thread reached the model with the alert blank and
 * everything before it cut away — see #lib/thread-context.js.
 *
 * Exactly one of the two loads produces anything, and which one is structural:
 * a mention inside a thread gets the thread transcript, a mention that starts
 * its own thread gets the channel's last few messages (#lib/channel-context.js)
 * — the case where the user @-mentions the bot under a pair of alert cards
 * without replying in either one's thread. The model cannot ask for context it
 * has never been shown a trace of, so this cannot wait for it to notice.
 *
 * Runs after eve has already returned 200 to Slack (`waitUntil`), so the Slack
 * fetches are off the webhook's delivery budget. It must not throw: eve drops
 * the whole mention when this handler does, so both loads degrade to no context
 * instead.
 */
async function dispatchWithConversationContext(
	ctx: SlackContext,
	message: SlackMessage,
): Promise<SlackMentionResult> {
	await ctx.thread.startTyping("Thinking...")
	const [threadContext, channelContext] = await Promise.all([
		loadThreadContext(ctx.thread, message, { botUserId: botUserIdForTeam(message.teamId) }),
		loadChannelContext(message),
	])
	// Channel first: it is the background the thread happens in.
	return { auth: defaultSlackAuth(message, ctx), context: [...channelContext, ...threadContext] }
}

export default slackChannel({
	credentials: {
		webhookVerifier,
		// Per-team bot token. Our patched eve passes the outbound call's
		// { teamId, channelId, threadTs }; context-less paths fall back to
		// SLACK_BOT_TOKEN.
		botToken: async (context?: SlackTokenContext) => resolveBotToken(context),
	},
	// Thread and channel context are loaded by these two handlers, not by the
	// channel's `threadContext` option — see dispatchWithConversationContext above.
	onAppMention: dispatchWithConversationContext,
	onDirectMessage: dispatchWithConversationContext,
	events: {
		// Eve's default flashes the raw tool-call label (`maple__list_services
		// startTime=...`) into the typing status. Replace it with a plain
		// descriptive phrase per tool (#lib/action-status.js), keeping the
		// default's one nicety: if the model narrated its own reason for
		// the tool calls (`pendingToolCallMessage`, set by the default
		// `message.completed` handler), that text wins over our phrase.
		async "actions.requested"(event, channel) {
			const narrated = channel.state.pendingToolCallMessage
			channel.state.pendingToolCallMessage = null
			await channel.thread.startTyping(
				narrated ? truncateTypingStatus(narrated) : describeActions(event.actions),
			)
		},
	},
})
