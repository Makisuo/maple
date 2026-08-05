import { botUserIdForTeam } from "./bot-identity.js"
import { resolveBotToken, type SlackTokenContext } from "./maple.js"
import { lookupAckedTriggeringMessage } from "./reaction.js"
import { formatContextBlock, type RenderableSlackMessage } from "./slack-context-format.js"

/**
 * The channel around the mention: the top-level messages posted just before the
 * one the agent is answering.
 *
 * `#lib/thread-context.js` covers a mention *inside* a thread. It cannot cover
 * the case in the screenshot that motivated this file: Maple posts two alert
 * cards to a channel, and someone writes "the ship is sinking help my friend
 * @Maple" as a new channel message rather than as a reply in either alert's
 * thread. That mention is its own thread root, so the thread transcript is one
 * message long — the user's own — and the model answers with no idea that two
 * incidents are sitting directly above it.
 *
 * Two entry points, because "the agent notices it needs context" only works
 * when the agent can tell there is any:
 *
 *   1. **Eager** (`loadChannelContext`, wired in `#channels/slack.js`): a
 *      mention that is not in a thread carries the last few channel messages
 *      as `<slack_channel_context>`. Structural trigger, no model judgment —
 *      the model cannot suspect what it has never been shown.
 *   2. **On demand** (`readChannelHistory`, behind the `read_channel_history`
 *      tool): for a mention inside a thread, where the thread is the subject
 *      but the channel may hold the reason.
 *
 * `conversations.history` returns top-level messages only — thread replies stay
 * out unless they were also sent to the channel — so the two surfaces do not
 * duplicate each other.
 *
 * DMs get the same treatment, and want it more: an unthreaded DM is its own
 * session (eve keys them `channelId:threadTs`), so without this each message a
 * user sends starts from nothing.
 *
 * Scope-wise this is free: `channels:history` / `groups:history` / `im:history`
 * are already installed for `#lib/thread-follow-up.js` and eve's thread fetch.
 * `mpim:history` is NOT requested, so a group DM answers `missing_scope`; that
 * degrades to a note, not a failure, and adding the scope would make every
 * existing install report missing scopes until it is reinstalled.
 */

/** How many channel messages the eager path injects for a threadless mention. */
export const CHANNEL_CONTEXT_MESSAGE_COUNT = 5

/**
 * Ceiling on the `read_channel_history` tool's `limit`. Slack caps
 * `conversations.history` at 15 messages per call for apps created after
 * 2025-05-29 (the non-Marketplace rate-limit tier), so asking for more can
 * silently return fewer — better to make the bound explicit than to let the
 * model believe it read further back than it did.
 */
export const CHANNEL_CONTEXT_MAX_MESSAGES = 15

/**
 * Per-message content ceiling. A thread the bot was invited into is bounded by
 * the conversation; a channel is not — one pasted stack trace or log dump would
 * otherwise ride along on every turn of the session.
 */
const MAX_CONTENT_CHARS = 2_000

/**
 * The fetch runs after eve's 200 to Slack, so it does not spend the webhook
 * budget — but it does hold up the turn, and a stalled Slack API must not hang
 * a reply behind context that is only ever an improvement.
 */
const FETCH_TIMEOUT_MS = 5_000

/** A Slack Web API error surfaced with its code, so callers can explain it. */
export class SlackHistoryError extends Error {
	readonly code: string
	constructor(code: string) {
		super(`Slack conversations.history failed: ${code}`)
		this.name = "SlackHistoryError"
		this.code = code
	}
}

export interface FetchChannelHistoryOptions {
	readonly botToken: string
	readonly channelId: string
	/** Slack ts of the triggering message — the exclusive upper bound. */
	readonly latest: string
	readonly limit: number
	readonly signal?: AbortSignal
}

/** Injectable dependencies so tests never touch the network. */
export interface ChannelContextDeps {
	resolveBotToken(context: SlackTokenContext): Promise<string>
	fetchChannelHistory(options: FetchChannelHistoryOptions): Promise<readonly RenderableSlackMessage[]>
	botUserIdForTeam(teamId: string | undefined): string | undefined
	lookupAckedMessage(context: {
		readonly teamId?: string
		readonly channelId: string
		readonly threadTs?: string
	}): string | undefined
}

export const defaultChannelContextDeps: ChannelContextDeps = {
	resolveBotToken,
	fetchChannelHistory: fetchChannelHistoryFromSlack,
	botUserIdForTeam,
	lookupAckedMessage: lookupAckedTriggeringMessage,
}

/**
 * Eager path: the channel messages preceding a threadless mention, rendered as
 * one `<slack_channel_context>` string.
 *
 * Returns `[]` when the mention is inside a thread (thread context has it), and
 * on any failure. Never throws — eve drops the whole mention when an
 * `onAppMention` handler throws, so a Slack hiccup must cost the context, not
 * the reply.
 */
export async function loadChannelContext(
	message: {
		readonly channelId: string
		readonly teamId: string | undefined
		readonly ts: string
		readonly threadTs: string
	},
	deps: ChannelContextDeps = defaultChannelContextDeps,
): Promise<readonly string[]> {
	// eve sets `threadTs === ts` for a message that is not a thread reply. A real
	// thread reply already has its transcript; injecting channel history there
	// too would bury the thread the user is actually in.
	if (message.threadTs !== message.ts) return []

	try {
		const rendered = await renderChannelContext(
			{
				teamId: message.teamId,
				channelId: message.channelId,
				latest: message.ts,
				limit: CHANNEL_CONTEXT_MESSAGE_COUNT,
			},
			deps,
		)
		return rendered === undefined ? [] : [rendered]
	} catch (error) {
		console.warn("[slack-channel-context] Failed to load channel context; dispatching without it.", error)
		return []
	}
}

export type ChannelHistoryResult =
	| { readonly read: true; readonly messageCount: number; readonly context: string }
	| { readonly read: false; readonly note: string }

/** The slice of eve's session context the tool reads. */
export interface ChannelHistorySession {
	readonly id: string
	/** Slack auth attributes: `team_id`, `channel_id`, `thread_ts`. */
	readonly attributes: Readonly<Record<string, unknown>>
}

/**
 * On-demand path behind the `read_channel_history` tool: the last `limit`
 * top-level channel messages before the message that triggered this turn.
 *
 * Never throws — a tool that throws costs the model its turn, and missing
 * channel context is worth a sentence, not a failed reply.
 */
export async function readChannelHistory(
	limit: number,
	session: ChannelHistorySession,
	deps: ChannelContextDeps = defaultChannelContextDeps,
): Promise<ChannelHistoryResult> {
	const teamId = slackString(session.attributes.team_id)
	const channelId = slackString(session.attributes.channel_id)
	const threadTs = slackString(session.attributes.thread_ts)
	if (!channelId) {
		return { read: false, note: "This session has no Slack channel, so there is no history to read." }
	}

	// The `:eyes:` ack registered the exact triggering message; the thread root
	// (which for an unthreaded message IS that message) is the degrade path.
	// Both are upper bounds, so a miss reads slightly less recent history rather
	// than the wrong history.
	const latest = deps.lookupAckedMessage({ teamId, channelId, threadTs }) ?? threadTs
	if (!latest) {
		return { read: false, note: "The triggering message could not be identified." }
	}

	try {
		const rendered = await renderChannelContext(
			{ teamId, channelId, latest, limit: boundedLimit(limit) },
			deps,
		)
		if (rendered === undefined) {
			return {
				read: false,
				note: "Nothing was posted in this channel before the message you are answering. Do not retry.",
			}
		}
		return {
			read: true,
			messageCount: countMessages(rendered),
			context: rendered,
		}
	} catch (error) {
		console.warn(`[slack-agent] read_channel_history failed session=${session.id}`, error)
		return { read: false, note: explainFailure(error) }
	}
}

async function renderChannelContext(
	request: {
		readonly teamId: string | undefined
		readonly channelId: string
		readonly latest: string
		readonly limit: number
	},
	deps: ChannelContextDeps,
): Promise<string | undefined> {
	const botToken = await deps.resolveBotToken({
		teamId: request.teamId,
		channelId: request.channelId,
	})
	const messages = await deps.fetchChannelHistory({
		botToken,
		channelId: request.channelId,
		latest: request.latest,
		limit: request.limit,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	return formatContextBlock("slack_channel_context", messages, {
		botUserId: deps.botUserIdForTeam(request.teamId),
		maxContentChars: MAX_CONTENT_CHARS,
	})
}

/**
 * `conversations.history` via the Slack Web API, newest-first, reversed to
 * oldest-first so the rendered transcript reads in the order it happened.
 *
 * `latest` is the triggering message's own ts and `inclusive` is false, so the
 * message the agent is already answering is never repeated back to it. Slack
 * rejects JSON for this method — form-encoded only.
 *
 * Exported for the request-shape tests; production reaches it through
 * `defaultChannelContextDeps`.
 */
export async function fetchChannelHistoryFromSlack(
	options: FetchChannelHistoryOptions,
): Promise<readonly RenderableSlackMessage[]> {
	const res = await fetch("https://slack.com/api/conversations.history", {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.botToken}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			channel: options.channelId,
			latest: options.latest,
			inclusive: "false",
			limit: String(options.limit),
		}),
		...(options.signal ? { signal: options.signal } : {}),
	})
	if (!res.ok) {
		throw new SlackHistoryError(`http_${res.status}`)
	}
	const payload = (await res.json()) as {
		ok: boolean
		error?: string
		messages?: ReadonlyArray<Record<string, unknown>>
	}
	if (!payload.ok) {
		throw new SlackHistoryError(payload.error ?? "unknown_error")
	}
	return (payload.messages ?? [])
		.map((message): RenderableSlackMessage => ({
			// Raw Slack text is mrkdwn: eve's GFM rendering only exists for
			// messages that came through its own thread fetch.
			text: typeof message.text === "string" ? message.text : undefined,
			user: typeof message.user === "string" ? message.user : undefined,
			botId: typeof message.bot_id === "string" ? message.bot_id : undefined,
			ts: typeof message.ts === "string" ? message.ts : undefined,
			// Present only when the message itself has replies — worth showing:
			// it tells the model the discussion continued somewhere it cannot see.
			threadTs: typeof message.thread_ts === "string" ? message.thread_ts : undefined,
			raw: message,
		}))
		.reverse()
}

/**
 * Turns a Slack failure into something the model can act on. The distinction
 * that matters is "this will never work here" (a scope or membership problem,
 * so stop asking) versus "this failed now" (retrying is pointless within a turn
 * either way, but the user deserves a different sentence).
 */
function explainFailure(error: unknown): string {
	const code = error instanceof SlackHistoryError ? error.code : ""
	switch (code) {
		case "missing_scope":
			return "This Slack app cannot read this conversation's history (missing scope — group DMs are not covered). Do not retry; answer from the thread, or ask the user to paste what you need."
		case "not_in_channel":
		case "channel_not_found":
			return "The bot is not a member of this channel, so its history is unreadable. Do not retry; ask the user to invite the bot or paste the relevant messages."
		case "ratelimited":
			return "Slack rate-limited the history read. Do not retry in this turn; answer from what you already have."
		default:
			return "Reading the channel history failed. Do not retry; answer from what you already have."
	}
}

function countMessages(rendered: string): number {
	return rendered.split("<slack_message>").length - 1
}

function boundedLimit(limit: number): number {
	if (!Number.isFinite(limit)) return CHANNEL_CONTEXT_MESSAGE_COUNT
	return Math.min(Math.max(Math.trunc(limit), 1), CHANNEL_CONTEXT_MAX_MESSAGES)
}

const slackString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined
