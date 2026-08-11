import type { SlackThreadMessage } from "eve/channels/slack"
import { botUserIdFromEnvelope } from "./bot-identity.js"
import { createTtlCache } from "./ttl-cache.js"

/**
 * Thread follow-up promotion: lets users keep talking to the bot in a thread
 * without re-@-mentioning it on every message.
 *
 * eve's Slack channel only dispatches `app_mention` events and DMs
 * (`message` with `channel_type: "im"`); a plain reply in a channel thread
 * arrives as a `message.channels` / `message.groups` event and is dropped as
 * `unsupported` before any handler runs. Rather than patching eve's parser,
 * we exploit the fact that our custom `webhookVerifier` returns the body eve
 * parses downstream: a thread reply that *could* be a follow-up gets its
 * `event.type` rewritten to `"app_mention"` so eve treats it exactly like a
 * mention — same session (continuation token is `channelId:threadTs`), same
 * incremental `threadContext`, same event-id dedupe.
 *
 * **The promotion is optimistic, and that is the whole design.** Deciding
 * whether the bot is actually engaged in a thread needs the thread, and the
 * verifier is the only awaited work before eve's 200 — so anything it fetches
 * is spent out of Slack's ~3s delivery budget. Two production incidents came
 * out of deciding there, both surfacing as the bot going completely silent:
 *
 *   1. **Restart.** The engagement cache is in-memory and a deploy wipes it, so
 *      the first follow-up after one paid the full cold-cache round-trip
 *      (workspace resolve + `conversations.replies`) inside the budget, blew the
 *      2s promotion deadline, and was dropped. Observed: a webhook that took
 *      exactly 2009ms, no turn, no log, not even the `:eyes:` ack — three
 *      minutes after the bot's own last post in that same thread.
 *   2. **Delay.** Engagement expired after 30 minutes, and the
 *      `conversations.replies` fetch derived its `oldest` bound from that same
 *      constant. So for a reply 61.3 minutes after the bot's last post, the
 *      fetch window *started 31 minutes after the bot had last spoken*: the
 *      check could not see the bot's own messages and could only ever answer
 *      "not engaged". The webhook completed in 406ms — no timeout, just a
 *      confident wrong answer.
 *
 * Widening the window would have made (1) worse (a longer window is a heavier
 * in-budget fetch), so both are fixed the same way: **promote first, confirm
 * afterwards.** `promoteThreadFollowUp` is now synchronous and network-free —
 * it parses, decides the event is a plausible candidate, registers it as
 * pending, and rewrites the type. `confirmThreadFollowUp` then runs from
 * `#channels/slack.js`'s handler, which eve invokes inside `waitUntil` *after*
 * the 200, against the thread that handler already loads for turn context. No
 * second Slack fetch, no deadline, nothing on the webhook's budget.
 *
 * A reply is a **candidate** when ALL of:
 *   - it is a threaded `message` in a channel/group (not a thread root, not a
 *     DM — DMs already dispatch on their own);
 *   - it is user-authored (no `bot_id`, no subtype except `file_share` —
 *     mirrors eve's own DM filter, and keeps the bot's replies from
 *     re-triggering itself);
 *   - it does NOT already @-mention the bot (those arrive as a separate,
 *     real `app_mention` event; promoting the `message` twin would double-
 *     dispatch the same turn).
 *
 * It is **confirmed** when the bot is engaged in the thread — it has posted
 * there, or someone mentioned it there — and both bounds below still hold.
 * Unconfirmed follow-ups are dropped by the handler throwing (eve's
 * `dispatchInboundMessage` catches handler failures and abandons the turn),
 * and the user is told why over DM (`#lib/disengage-notice.js`) when the bot
 * had actually been working in that thread.
 *
 * Requires the Slack app to subscribe to `message.channels` (public) /
 * `message.groups` (private) bot events. The bot only receives channel messages
 * for channels it is a member of, which naturally bounds the event volume.
 */

/**
 * Engagement expires. Without a bound, one @mention makes every later human
 * reply in that thread — by anyone, forever — dispatch a full agent turn: a
 * cost amplifier and a permanently open prompt-injection intake on a thread
 * that has long since moved on to something else.
 *
 * Two bounds, both must hold:
 *
 *   - **The thread is not dormant.** Measured from the message immediately
 *     before the reply, NOT from the bot's last post. That distinction is the
 *     fix for incident (2): a thread where people are still talking is a live
 *     conversation whether or not the bot has said anything lately, and an hour
 *     of human back-and-forth is a normal shape for an incident thread. What is
 *     genuinely over is a thread nobody has touched for a day.
 *   - **The bot's engagement is within the trailing 15 messages.** This is the
 *     real guard, and the one the clock was always a poor proxy for: a thread
 *     that ran away from the bot has moved on regardless of how recently it
 *     did so.
 *
 * Past either bound the reply is dropped, the humans in the thread get a DM
 * saying so, and re-@-mentioning the bot is one keystroke.
 */
const THREAD_DORMANT_MAX_SECONDS = 24 * 60 * 60
const ENGAGEMENT_RECENT_MESSAGE_WINDOW = 15

/**
 * eve's `thread.refresh()` fetches ONE oldest-first page of 50 replies, so on a
 * longer thread the messages we get back are the *start* of it and the tail —
 * where any recent engagement lives — is exactly what is missing.
 *
 * `loadThreadContextMessages` drops the triggering message from that page, so a
 * full page reaches us as 49 (or as 50, when the triggering message was past
 * the page and never in it). Either count means "there is more thread than we
 * can see", and see `confirmThreadFollowUp` for why that promotes rather than
 * drops.
 */
const EVE_THREAD_PAGE_SIZE = 50

// Engagement cache

// Engagement is sticky once established (the bot's reply stays in the thread
// forever), so an entry could live long; it is deliberately short instead,
// because what this cache now answers is not "has the bot ever been here" — the
// thread page answers that, for free, on the confirm path — but "is the bot
// demonstrably active here *right now*". `recordThreadEngagement` refreshes it
// from every post of the bot's own that echoes back through the webhook, so a
// thread the bot is actively replying in never goes cold, and a hit is proof
// that the bot did something here within the last ENGAGED_TTL_MS.
//
// That proof is what makes the hit a legitimate short-circuit: an entry cannot
// be older than this TTL, which is three orders of magnitude inside the
// dormancy bound, so a warm entry can never resurrect a dead thread. It also
// covers the one case the thread page structurally cannot — a thread longer
// than eve's 50-message page.
//
// There are no negative entries. They used to exist to spare a busy channel one
// `conversations.replies` call per message; the confirm path spends no network
// at all, so a cached "no" would save nothing and could only go stale.
const ENGAGED_TTL_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 500
const CACHE_SWEEP_INTERVAL_MS = 60_000

interface EngagementCacheEntry {
	readonly expiresAt: number
}

const engagementCache = createTtlCache<EngagementCacheEntry>({
	maxEntries: CACHE_MAX_ENTRIES,
	sweepIntervalMs: CACHE_SWEEP_INTERVAL_MS,
})

/**
 * The caches are process-global and this app serves every workspace that
 * installed the Slack app. Slack channel ids are only unique per workspace, so
 * a bare `channel:thread` key would let one tenant's engagement decide
 * another tenant's dispatch.
 */
function engagementCacheKey(teamId: string | undefined, channelId: string, threadTs: string): string {
	return `${teamId ?? "-"}:${channelId}:${threadTs}`
}

// Pending-promotion registry

/**
 * A promotion the handler still has to confirm. Keyed by the message's own ts,
 * which is what separates an optimistically promoted follow-up from a real
 * `app_mention` once both are indistinguishable `app_mention` bodies.
 *
 * The alternative — re-reading `message.text` for `<@bot>` in the handler — does
 * not work: eve re-renders inbound mrkdwn, so the text the handler sees is not
 * necessarily the text Slack sent.
 */
export interface PendingFollowUp {
	readonly teamId: string | undefined
	readonly channelId: string
	readonly threadTs: string
	/** Slack ts of the reply itself (not the thread root). */
	readonly messageTs: string
	/** The workspace's bot user id, straight off the envelope's `authorizations`. */
	readonly botUserId: string
	/**
	 * Whether this delivery should still place the `:eyes:` ack. False for a
	 * Slack redelivery, where the reaction is already on the message —
	 * `already_reacted` is tolerated downstream, this just skips a pointless
	 * call.
	 */
	readonly ackable: boolean
}

/**
 * Long enough to cover eve's `waitUntil` dispatch (which runs immediately,
 * in-process, right after the 200) with room for a queued handler, short enough
 * that an event whose handler never ran does not linger.
 */
const PENDING_TTL_MS = 5 * 60_000
const PENDING_MAX_ENTRIES = 4096

interface PendingEntry extends PendingFollowUp {
	readonly expiresAt: number
}

const pendingPromotions = createTtlCache<PendingEntry>({
	maxEntries: PENDING_MAX_ENTRIES,
	sweepIntervalMs: CACHE_SWEEP_INTERVAL_MS,
})

function pendingKey(teamId: string | undefined, channelId: string, messageTs: string): string {
	return `${teamId ?? "-"}:${channelId}:${messageTs}`
}

/** Test-only: clears both caches so each test starts cold. */
export function resetThreadFollowUpStateForTests(): void {
	engagementCache.clear()
	pendingPromotions.clear()
}

/**
 * The pending promotion for a dispatched message, or null when the message
 * reached the handler as a real `app_mention` (or a DM) and needs no
 * confirmation.
 *
 * Deliberately a read, not a take: a message ts identifies exactly one Slack
 * message, so a re-entry for the same ts is the same follow-up and must be
 * judged the same way rather than being silently upgraded to "real mention".
 */
export function pendingFollowUp(target: {
	readonly teamId: string | undefined
	readonly channelId: string
	readonly messageTs: string
}): PendingFollowUp | null {
	return pendingPromotions.get(pendingKey(target.teamId, target.channelId, target.messageTs)) ?? null
}

// Learning engagement from the event stream

/**
 * Refreshes the engagement cache from an event that already *proves* the bot is
 * engaged — its own post echoing back through the events stream, or someone
 * @-mentioning it. Free: the envelope in hand carries exactly what the thread
 * page would otherwise have to be scanned for.
 *
 * Call it on every verified inbound body. Never throws — an envelope we cannot
 * read simply teaches us nothing.
 */
export function recordThreadEngagement(rawBody: string): void {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return
	}
	if (!isRecord(parsed) || parsed.type !== "event_callback") return

	const event = parsed.event
	if (!isRecord(event)) return
	if (event.type !== "message" && event.type !== "app_mention") return

	// Promotion only ever applies to channel threads, so nothing else is worth
	// caching. `app_mention` carries no `channel_type`, and only arrives from a
	// channel the app is in — so the filter applies to `message` events only.
	const channelType = event.channel_type
	if (
		event.type === "message" &&
		channelType !== "channel" &&
		channelType !== "group" &&
		channelType !== "mpim"
	) {
		return
	}

	// Edits and deletions carry the original under a nested `message`; their
	// top-level ts is not a new engagement. Same filter as the dispatch path.
	const subtype = event.subtype
	if (typeof subtype === "string" && subtype.length > 0 && subtype !== "file_share") return

	const channelId = typeof event.channel === "string" ? event.channel : ""
	const ts = typeof event.ts === "string" ? event.ts : ""
	if (!channelId || !ts) return

	const botUserId = botUserIdFromEnvelope(parsed)
	if (!botUserId) return

	// The same predicate `lastEngagementIndex` applies to fetched thread messages
	// — the two must agree, or whether a thread counts as engaged would depend on
	// which path happened to observe it.
	//
	// `bot_id` is deliberately NOT rejected here. `parseFollowUpCandidate` drops
	// bot-authored messages to stop the bot dispatching a turn on its own reply;
	// that is a rule about *dispatch*. For *learning*, the bot's own post is the
	// single most reliable engagement signal there is.
	const text = typeof event.text === "string" ? event.text : ""
	const isOwnPost = typeof event.user === "string" && event.user === botUserId
	if (!isOwnPost && !text.includes(`<@${botUserId}>`)) return

	// A root-level mention has no `thread_ts` yet — its own ts is what becomes
	// the thread's id once the bot replies, so key on that and the thread is
	// already warm for its very first follow-up.
	const threadTs = typeof event.thread_ts === "string" && event.thread_ts.length > 0 ? event.thread_ts : ts
	const teamId = typeof parsed.team_id === "string" ? parsed.team_id : undefined

	engagementCache.set(engagementCacheKey(teamId, channelId, threadTs), {
		expiresAt: Date.now() + ENGAGED_TTL_MS,
	})
}

// Promotion (webhook path — synchronous, zero network)

export interface PromotionOptions {
	/** Slack redelivery (`x-slack-retry-num` present); suppresses the `:eyes:` ack. */
	readonly isSlackRetry?: boolean
}

/**
 * Inspects a verified inbound Slack webhook body. Returns a rewritten body
 * (the same envelope with `event.type` promoted to `"app_mention"`) when the
 * event is a plausible thread follow-up, or `null` when the body should pass
 * through unchanged.
 *
 * Parse-only and synchronous by contract: this runs inside Slack's ~3s webhook
 * budget as the last awaited step before eve's 200, and the two incidents in
 * this file's header were both bought by doing more than parsing here. Never
 * throws on malformed input — anything unexpected simply doesn't qualify.
 */
export function promoteThreadFollowUp(rawBody: string, options: PromotionOptions = {}): string | null {
	const candidate = parseFollowUpCandidate(rawBody)
	if (!candidate) return null

	pendingPromotions.set(pendingKey(candidate.teamId, candidate.channelId, candidate.eventTs), {
		teamId: candidate.teamId,
		channelId: candidate.channelId,
		threadTs: candidate.threadTs,
		messageTs: candidate.eventTs,
		botUserId: candidate.botUserId,
		ackable: options.isSlackRetry !== true,
		expiresAt: Date.now() + PENDING_TTL_MS,
	})

	candidate.envelope.event.type = "app_mention"
	return JSON.stringify(candidate.envelope)
}

interface FollowUpCandidate {
	readonly envelope: { event: { type: string } } & Record<string, unknown>
	readonly teamId: string | undefined
	readonly channelId: string
	readonly threadTs: string
	readonly botUserId: string
	/** The incoming reply's own ts, verbatim. */
	readonly eventTs: string
}

function parseFollowUpCandidate(rawBody: string): FollowUpCandidate | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return null
	}
	if (!isRecord(parsed) || parsed.type !== "event_callback") return null

	const event = parsed.event
	if (!isRecord(event) || event.type !== "message") return null

	const channelType = event.channel_type
	if (channelType !== "channel" && channelType !== "group" && channelType !== "mpim") {
		return null
	}

	// User-authored plain messages only — mirrors eve's DM filter.
	const subtype = event.subtype
	if (typeof subtype === "string" && subtype.length > 0 && subtype !== "file_share") {
		return null
	}
	if (typeof event.bot_id === "string" && event.bot_id.length > 0) return null
	if (typeof event.user !== "string" || event.user.length === 0) return null

	// Thread replies only: a root message has no thread_ts (or thread_ts === ts).
	const ts = typeof event.ts === "string" ? event.ts : ""
	const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : ""
	if (!ts || !threadTs || threadTs === ts) return null

	const channelId = typeof event.channel === "string" ? event.channel : ""
	if (!channelId) return null

	const botUserId = botUserIdFromEnvelope(parsed)
	if (!botUserId) return null

	// A reply that @-mentions the bot arrives as a real app_mention event too —
	// promoting this twin would dispatch the same turn twice. Reading `text` is
	// safe *here*, on the raw Slack envelope: it is the original mrkdwn, where a
	// mention is always literally `<@Uxxxx>`.
	const text = typeof event.text === "string" ? event.text : ""
	if (text.includes(`<@${botUserId}>`)) return null

	return {
		envelope: parsed as FollowUpCandidate["envelope"],
		teamId: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
		channelId,
		threadTs,
		botUserId,
		eventTs: ts,
	}
}

// Confirmation (dispatch path — post-200, no budget, no extra fetch)

export type FollowUpEngagedReason =
	/** The bot posted or was mentioned here within ENGAGED_TTL_MS. */
	| "cached-engagement"
	/** The thread page shows the bot inside both bounds. */
	| "recent-engagement"
	/** The thread could not be read at all; promoted rather than lost. */
	| "thread-unreadable"
	/** The page is a full 50 and the tail we would need is past it. */
	| "page-truncated"

/** The two bounds a follow-up can trip in a thread the bot really worked in. */
export type FollowUpDisengagedReason = "thread-dormant" | "engagement-buried"

/**
 * `workedInThread` is the discriminant that matters downstream: it is the
 * difference between "the bot has stepped out of a conversation it was part of"
 * — worth telling the humans about (`#lib/disengage-notice.js`) — and "the bot
 * was never in this thread", which is just ordinary channel chatter and must
 * stay silent.
 */
export type FollowUpDecision =
	| { readonly engaged: true; readonly reason: FollowUpEngagedReason }
	| {
			readonly engaged: false
			readonly workedInThread: true
			readonly reason: FollowUpDisengagedReason
	  }
	| { readonly engaged: false; readonly workedInThread: false; readonly reason: "never-engaged" }

/**
 * Decides whether an optimistically promoted follow-up should actually become a
 * turn, from the thread the handler has already loaded for context. Pass `null`
 * for `messages` when the thread could not be read.
 *
 * Pure and synchronous: everything it needs is either in hand or in memory.
 *
 * **It fails open.** Where the evidence is absent rather than negative — the
 * thread unreadable, or truncated past eve's page — the follow-up is promoted.
 * The two outcomes are not symmetric: a wrong drop costs a user their message
 * with no reply, no ack and nothing on screen to explain it (that is precisely
 * how both incidents presented), while a wrong dispatch costs one turn in a
 * thread the bot was already part of.
 */
export function confirmThreadFollowUp(
	pending: PendingFollowUp,
	messages: readonly SlackThreadMessage[] | null,
): FollowUpDecision {
	const cacheKey = engagementCacheKey(pending.teamId, pending.channelId, pending.threadTs)
	// A warm entry is at most ENGAGED_TTL_MS old, so it is proof of activity now,
	// not a remembered verdict — see the cache's own comment for why that makes
	// short-circuiting safe against both bounds below.
	if (engagementCache.get(cacheKey) !== undefined) {
		return { engaged: true, reason: "cached-engagement" }
	}

	if (messages === null) {
		return { engaged: true, reason: "thread-unreadable" }
	}

	const engagementIndex = lastEngagementIndex(messages, pending.botUserId)
	if (engagementIndex === -1) {
		if (messages.length >= EVE_THREAD_PAGE_SIZE - 1) {
			return { engaged: true, reason: "page-truncated" }
		}
		return { engaged: false, workedInThread: false, reason: "never-engaged" }
	}

	// Bound 1: the thread itself is still alive. Measured against the message
	// immediately before this reply — `loadThreadContextMessages` returns the
	// thread oldest-first and excludes the triggering message, so that is the
	// last element.
	const replySeconds = Number(pending.messageTs)
	const previousSeconds = Number(messages[messages.length - 1]?.ts)
	if (
		Number.isFinite(replySeconds) &&
		Number.isFinite(previousSeconds) &&
		replySeconds - previousSeconds > THREAD_DORMANT_MAX_SECONDS
	) {
		return { engaged: false, workedInThread: true, reason: "thread-dormant" }
	}

	// Bound 2: the bot is still in the thread's trailing window. The incoming
	// reply counts as one of those messages — it is part of what buried the
	// engagement.
	const messagesSinceEngagement = messages.length - engagementIndex + 1
	if (messagesSinceEngagement > ENGAGEMENT_RECENT_MESSAGE_WINDOW) {
		return { engaged: false, workedInThread: true, reason: "engagement-buried" }
	}

	// Learned the expensive way (a full scan of the page, after a restart wiped
	// the cache); the thread's next follow-up gets it for free.
	engagementCache.set(cacheKey, { expiresAt: Date.now() + ENGAGED_TTL_MS })
	return { engaged: true, reason: "recent-engagement" }
}

/**
 * Index of the last message that engages the bot — its own post, or an @mention
 * of it — or -1 when the visible thread has none.
 *
 * Identity comes from `botUserId` (learned per team from the envelope's
 * `authorizations`, `#lib/bot-identity.js`), never from eve's `isMe`: that is
 * `bot_id !== undefined`, i.e. ANY bot, so in a channel that also hosts a GitHub
 * or CI app every one of their posts would read as ours.
 *
 * Mentions are matched against `text`, the original Slack mrkdwn, where a
 * mention is always literally `<@Uxxxx>`; `markdown` is eve's re-rendering of it
 * and may have resolved the id away.
 */
function lastEngagementIndex(messages: readonly SlackThreadMessage[], botUserId: string): number {
	const mention = `<@${botUserId}>`
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message === undefined) continue
		if (message.user === botUserId) return index
		if (message.text.includes(mention)) return index
	}
	return -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
