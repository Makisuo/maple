import { defaultSlackAuth, slackChannel } from "eve/channels/slack"
import type { SlackContext, SlackMentionResult, SlackMessage, SlackWebhookVerifier } from "eve/channels/slack"
import { acknowledgeIncomingMessage, acknowledgeMessage } from "#lib/ack-reaction.js"
import { describeActions, truncateTypingStatus } from "#lib/action-status.js"
import { botUserIdForTeam, rememberBotUserId } from "#lib/bot-identity.js"
import { loadChannelContext } from "#lib/channel-context.js"
import { notifyThreadDisengagement } from "#lib/disengage-notice.js"
import { resolveBotToken, verifySlackV0Signature, type SlackTokenContext } from "#lib/maple.js"
import { emitAgentLog } from "#lib/telemetry-log.js"
import { formatThreadContext, loadThreadMessages } from "#lib/thread-context.js"
import {
	confirmThreadFollowUp,
	pendingFollowUp,
	promoteThreadFollowUp,
	recordThreadEngagement,
} from "#lib/thread-follow-up.js"
import { formatTurnTime } from "#lib/turn-time.js"
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
	// echoing back, and @mentions of it — so the confirmation step downstream can
	// answer from memory in a thread the bot is demonstrably active in
	// (#lib/thread-follow-up.js). Synchronous and network-free.
	recordThreadEngagement(body)

	// app_uninstalled / tokens_revoked: eve only dispatches app_mention + DM
	// events downstream, so it would otherwise drop these as "unsupported".
	// Fired without awaiting — it must never delay this webhook's ack, and it
	// never throws (see forwardUninstallEvent).
	void forwardUninstallEvent(body)

	// Instant "received" ack: react with :eyes: on any message eve will
	// dispatch as an agent turn (real mentions + DMs), before the turn is even
	// scheduled. Fired without awaiting — never delays the webhook ack.
	// Slack redelivery retries skip it (`already_reacted` is also tolerated
	// downstream, this just avoids the pointless call).
	//
	// Promoted follow-ups are deliberately NOT ack'd here. Their promotion is
	// optimistic and `dispatchWithConversationContext` may still drop them, and
	// acking a message we then never answer is worse than not acking at all: the
	// :eyes: is a promise. They get their ack there, once the promotion is
	// confirmed.
	const isSlackRetry = request.headers.get("x-slack-retry-num") !== null
	if (!isSlackRetry) void acknowledgeIncomingMessage(body)

	// eve parses whatever body we return, which is also our hook for thread
	// follow-ups: eve only dispatches app_mention + DM events, so an un-mentioned
	// reply in a thread that could be a follow-up gets its `event.type` promoted
	// to "app_mention" here (see #lib/thread-follow-up.js). Everything else
	// passes through verified-but-unchanged.
	//
	// This is the LAST awaited work before eve returns 200, i.e. the only thing
	// still spending Slack's ~3s delivery budget — which is why the promotion is
	// parse-only and synchronous, and why the engagement decision itself now
	// happens after the 200. It cannot throw, but a throw here would fail every
	// inbound event, so the guard stays.
	try {
		return promoteThreadFollowUp(body, { isSlackRetry }) ?? body
	} catch (error) {
		console.warn(
			"[slack-webhook] Thread follow-up promotion failed; passing the event through unchanged.",
			error,
		)
		return body
	}
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
 * The turn also carries the clock (#lib/turn-time.js). Nothing else in the
 * prompt does, and without it the model took the oldest `message_ts` in the
 * transcript for "now" — so a follow-up an hour into an alert thread charted
 * the alert's window instead of the current one.
 *
 * Runs after eve has already returned 200 to Slack (`waitUntil`), so the Slack
 * fetches are off the webhook's delivery budget. That is also why the thread
 * follow-up decision lives here rather than in the verifier: this handler
 * already loads the thread, and here it can take as long as it needs. It must
 * not otherwise throw: eve drops the whole mention when this handler does, so
 * both loads degrade to no context instead — the one deliberate throw is the
 * disengagement drop below, which is exactly what that escape hatch is for.
 */
async function dispatchWithConversationContext(
	ctx: SlackContext,
	message: SlackMessage,
): Promise<SlackMentionResult> {
	// Non-null only for a follow-up the verifier promoted optimistically — the
	// one kind of dispatch that still has to earn its turn. Registry lookup, not
	// a text sniff: eve re-renders inbound mrkdwn, so `message.text` is no longer
	// proof of what Slack actually sent (#lib/thread-follow-up.js).
	const pending = pendingFollowUp({
		teamId: message.teamId,
		channelId: message.channelId,
		messageTs: message.ts,
	})

	// A real mention is answered for certain, so it gets the typing indicator
	// immediately. A follow-up waits until it is confirmed: "Thinking..." on a
	// message the bot then silently drops reads worse than saying nothing.
	if (pending === null) await ctx.thread.startTyping("Thinking...")

	const botUserId = botUserIdForTeam(message.teamId)
	const [threadMessages, channelContext] = await Promise.all([
		loadThreadMessages(ctx.thread, message),
		loadChannelContext(message),
	])

	if (pending !== null) {
		const decision = confirmThreadFollowUp(pending, threadMessages)
		if (!decision.engaged) {
			// The drop is silent by construction — no turn, no reply, no reaction —
			// so this log is the only trace it leaves. hooks/outcome-log.ts cannot
			// cover it: there is no turn for it to report on. Ids only, never text.
			//
			// Severity splits on the same distinction the DM does: declining a
			// thread the bot was never in is the ordinary outcome of promoting
			// optimistically (most channel replies are not follow-ups), while
			// leaving a conversation the bot WAS in is a user who did not get an
			// answer, and worth finding later.
			emitAgentLog(decision.workedInThread ? "warn" : "info", "follow_up_disengaged", {
				"maple.agent.event": "follow_up_disengaged",
				"maple.agent.disengage_reason": decision.reason,
				"maple.agent.worked_in_thread": decision.workedInThread,
				"maple.slack.team_id": pending.teamId,
				"maple.slack.channel_id": pending.channelId,
				"maple.slack.thread_ts": pending.threadTs,
				"maple.slack.message_ts": pending.messageTs,
			})
			// Only for a thread the bot actually worked in: leaving those people
			// wondering why it stopped answering is the failure this fixes. A thread
			// it was never in is ordinary channel chatter and must stay silent.
			if (decision.workedInThread && threadMessages !== null) {
				void notifyThreadDisengagement({
					teamId: pending.teamId,
					channelId: pending.channelId,
					threadTs: pending.threadTs,
					messageTs: pending.messageTs,
					reason: decision.reason,
					messages: threadMessages,
					replierUserId: message.author?.userId,
					botUserId,
				})
			}
			// eve's `dispatchInboundMessage` catches a throwing handler and abandons
			// the turn before the model sees anything — the only way to un-dispatch
			// an event it has already accepted.
			throw new Error(
				`Thread follow-up not dispatched (${decision.reason}): the bot is no longer engaged in ${pending.channelId}:${pending.threadTs}.`,
			)
		}
		// Confirmed, so the :eyes: is now a promise we keep.
		if (pending.ackable) {
			void acknowledgeMessage({
				teamId: pending.teamId,
				channelId: pending.channelId,
				messageTs: pending.messageTs,
				threadTs: pending.threadTs,
			})
		}
		await ctx.thread.startTyping("Thinking...")
	}

	const threadContext = formatThreadContext(threadMessages ?? [], { botUserId })
	// Channel first: it is the background the thread happens in. The clock last,
	// so it sits closest to the message being answered — and so that in a thread
	// with several turns' worth of these, the newest is the one nearest the ask.
	return {
		auth: defaultSlackAuth(message, ctx),
		context: [
			...channelContext,
			...(threadContext === undefined ? [] : [threadContext]),
			formatTurnTime(message),
		],
	}
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
