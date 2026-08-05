import { botUserIdFromEnvelope } from "./bot-identity.js"
import { resolveBotToken } from "./maple.js"
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
 * parses downstream: when a thread reply qualifies as a follow-up to a
 * conversation the bot is engaged in, we rewrite `event.type` to
 * `"app_mention"` so eve treats it exactly like a mention — same session
 * (continuation token is `channelId:threadTs`), same incremental
 * `threadContext`, same event-id dedupe.
 *
 * A reply qualifies when ALL of:
 *   - it is a threaded `message` in a channel/group (not a thread root, not a
 *     DM — DMs already dispatch on their own);
 *   - it is user-authored (no `bot_id`, no subtype except `file_share` —
 *     mirrors eve's own DM filter, and keeps the bot's replies from
 *     re-triggering itself);
 *   - it does NOT already @-mention the bot (those arrive as a separate,
 *     real `app_mention` event; promoting the `message` twin would double-
 *     dispatch the same turn);
 *   - the bot is "engaged" in the thread: it has posted there, or someone
 *     mentioned it there (covers the follow-up racing ahead of the bot's
 *     first reply) — and that engagement is still RECENT (see
 *     `ENGAGEMENT_MAX_AGE_SECONDS` / `ENGAGEMENT_RECENT_MESSAGE_WINDOW`).
 *
 * Requires the Slack app to subscribe to `message.channels` (public) /
 * `message.groups` (private) bot events; the engagement check reuses the
 * `channels:history` / `groups:history` scopes that `threadContext` already
 * needs. The bot only receives channel messages for channels it is a member
 * of, which naturally bounds the event volume.
 */

/** One message returned by `conversations.replies` (only what we inspect). */
export interface ThreadReplyMessage {
	readonly user?: string
	readonly botId?: string
	readonly text?: string
	/** Slack ts ("1700000000.000100"); required for the recency bound. */
	readonly ts?: string
}

/** Injectable dependencies so tests never touch the network. */
export interface ThreadFollowUpDeps {
	resolveBotToken(context: { teamId?: string }): Promise<string>
	fetchThreadReplies(options: {
		readonly botToken: string
		readonly channelId: string
		readonly threadTs: string
		/**
		 * Slack ts (epoch seconds) of the recency horizon: messages older than
		 * this cannot count as engagement, so the fetch itself is bounded to them
		 * and the trailing window is correct regardless of thread length.
		 */
		readonly oldest: string
		/** Slack ts of the incoming reply — nothing after it can have engaged. */
		readonly latest: string
		/** Aborts when the promotion deadline expires. */
		readonly signal: AbortSignal
	}): Promise<readonly ThreadReplyMessage[]>
	/** Test-only override of `PROMOTION_DEADLINE_MS`. */
	readonly promotionDeadlineMs?: number
}

const defaultDeps: ThreadFollowUpDeps = {
	resolveBotToken,
	fetchThreadReplies: fetchThreadRepliesFromSlack,
}

// Engagement is sticky once established (the bot's reply stays in the thread
// forever), so positive entries can live long. Negative entries stay short so
// a thread the bot joins moments later is picked up quickly. What the cache
// stores is the *timestamp* of the engagement, not a boolean, so the recency
// bound below is re-applied on every hit instead of being frozen for the TTL.
const ENGAGED_TTL_MS = 5 * 60_000
const NOT_ENGAGED_TTL_MS = 20_000
const CACHE_MAX_ENTRIES = 500
const CACHE_SWEEP_INTERVAL_MS = 60_000

/**
 * Engagement expires. Without a bound, one @mention makes every later human
 * reply in that thread — by anyone, forever — dispatch a full agent turn: a
 * cost amplifier and a permanently open prompt-injection intake on a thread
 * that has long since moved on to something else.
 *
 * Two bounds, both must hold, both measured against the incoming reply:
 *   - 30 minutes since the mention / the bot's last message. A Slack thread
 *     that goes half an hour without the bot saying anything is a different
 *     conversation; re-@-mentioning it is one keystroke.
 *   - the engagement must be within the last 15 messages of the thread, so a
 *     fast-moving thread that ran away from the bot in under 30 minutes stops
 *     too.
 * Past either bound the reply passes through unpromoted and the user simply
 * @-mentions the bot again.
 */
const ENGAGEMENT_MAX_AGE_SECONDS = 30 * 60
const ENGAGEMENT_RECENT_MESSAGE_WINDOW = 15

/**
 * Combined budget for the whole promotion side-trip on a cold cache: workspace
 * resolve AND thread fetch together. Slack's webhook budget is ~3s total and
 * this runs inside it, so the two calls cannot each get their own timeout
 * (resolve alone is capped at 5s in maple.ts — already over budget). Past the
 * deadline the event passes through unpromoted; the user can re-@-mention.
 */
const PROMOTION_DEADLINE_MS = 2_000

interface EngagementCacheEntry {
	/** Slack ts (epoch seconds) of the engaging message, or null if none. */
	readonly engagedAtSeconds: number | null
	readonly expiresAt: number
}

const engagementCache = createTtlCache<EngagementCacheEntry>({
	maxEntries: CACHE_MAX_ENTRIES,
	sweepIntervalMs: CACHE_SWEEP_INTERVAL_MS,
})

/** Test-only: clears the engagement cache so each test starts cold. */
export function resetThreadEngagementCacheForTests(): void {
	engagementCache.clear()
}

/**
 * Inspects a verified inbound Slack webhook body. Returns a rewritten body
 * (the same envelope with `event.type` promoted to `"app_mention"`) when the
 * event is a qualifying thread follow-up, or `null` when the body should
 * pass through unchanged. Never throws on malformed input — anything
 * unexpected simply doesn't qualify.
 */
export async function promoteThreadFollowUp(
	rawBody: string,
	deps: ThreadFollowUpDeps = defaultDeps,
): Promise<string | null> {
	const candidate = parseFollowUpCandidate(rawBody)
	if (!candidate) return null

	const engaged = await isBotEngagedInThread(candidate, deps)
	if (!engaged) return null

	candidate.envelope.event.type = "app_mention"
	return JSON.stringify(candidate.envelope)
}

interface FollowUpCandidate {
	readonly envelope: { event: { type: string } } & Record<string, unknown>
	readonly teamId?: string
	readonly channelId: string
	readonly threadTs: string
	readonly botUserId: string
	/** The incoming reply's own ts, verbatim — upper bound for the thread fetch. */
	readonly eventTs: string
	/** The incoming reply's own ts, in epoch seconds — the recency reference. */
	readonly eventTsSeconds: number
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
	// promoting this twin would dispatch the same turn twice.
	const text = typeof event.text === "string" ? event.text : ""
	if (text.includes(`<@${botUserId}>`)) return null

	// Use the event's own clock rather than Date.now(): Slack retries deliver
	// the same event minutes later, and the decision must not drift with them.
	const eventTsSeconds = Number(ts)
	if (!Number.isFinite(eventTsSeconds)) return null

	return {
		envelope: parsed as FollowUpCandidate["envelope"],
		teamId: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
		channelId,
		threadTs,
		botUserId,
		eventTs: ts,
		eventTsSeconds,
	}
}

async function isBotEngagedInThread(
	candidate: FollowUpCandidate,
	deps: ThreadFollowUpDeps,
): Promise<boolean> {
	// teamId is part of the key: the cache is process-global and this app serves
	// every workspace that installed the Slack app. Slack channel ids are only
	// unique per workspace, so a bare `channel:thread` key lets one tenant's
	// engagement decide another tenant's dispatch.
	const cacheKey = `${candidate.teamId ?? "-"}:${candidate.channelId}:${candidate.threadTs}`
	const cached = engagementCache.get(cacheKey)
	if (cached) return isEngagementRecent(cached.engagedAtSeconds, candidate)

	// One deadline for BOTH network round-trips (see PROMOTION_DEADLINE_MS).
	const deadline = AbortSignal.timeout(deps.promotionDeadlineMs ?? PROMOTION_DEADLINE_MS)
	let botToken: string
	let replies: readonly ThreadReplyMessage[]
	try {
		// The resolve itself is deliberately NOT aborted at the deadline: it is a
		// shared, de-duped, cached promise (maple.ts), so letting it finish in the
		// background warms the workspace cache for the thread's next reply — we
		// merely stop waiting for it here.
		botToken = await withDeadline(deps.resolveBotToken({ teamId: candidate.teamId }), deadline)
		replies = await withDeadline(
			deps.fetchThreadReplies({
				botToken,
				channelId: candidate.channelId,
				threadTs: candidate.threadTs,
				// Bound the fetch to the recency horizon so the trailing window is
				// computed over the true tail even for threads longer than one page.
				oldest: String(candidate.eventTsSeconds - ENGAGEMENT_MAX_AGE_SECONDS),
				latest: candidate.eventTs,
				signal: deadline,
			}),
			deadline,
		)
	} catch (error) {
		// Deadline expiry is an expected cold-cache outcome, not a failure: fall
		// through unpromoted (nothing cached — the next reply retries, warmer).
		if (deadline.aborted) return false
		throw error
	}

	const engagedAtSeconds = latestEngagementSeconds(replies, candidate)

	engagementCache.set(cacheKey, {
		engagedAtSeconds,
		expiresAt: Date.now() + (engagedAtSeconds === null ? NOT_ENGAGED_TTL_MS : ENGAGED_TTL_MS),
	})
	return isEngagementRecent(engagedAtSeconds, candidate)
}

/**
 * Resolves/rejects with `promise`, but rejects as soon as `signal` aborts —
 * even when the underlying work ignores the signal. The work itself is not
 * cancelled; we just stop waiting for it.
 *
 * The abort listener is deliberately NOT removed once `promise` settles, which
 * looks like a leak and is not one: `{ once: true }` drops it when it fires,
 * the signal is created per promotion and lives at most
 * `PROMOTION_DEADLINE_MS`, and rejecting an already-settled promise is a no-op.
 *
 * Removing it explicitly — the obvious tidier version — breaks this outright
 * under Bun (1.3.14): taking the last `abort` listener off a signal from
 * `AbortSignal.timeout()` stops its timer for good, so `.aborted` never
 * becomes true and the deadline silently ceases to exist. Node is unaffected,
 * so production behaved correctly and only the test runner saw it — which is
 * precisely why it went unnoticed. Both calls below share one signal and the
 * first one almost always settles fast, so the tidier version disarmed the
 * deadline for the second, slower call: the one it exists to bound.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal))
	return new Promise<T>((resolve, reject) => {
		signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true })
		promise.then(resolve, (error: unknown) => {
			reject(error instanceof Error ? error : new Error(String(error)))
		})
	})
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Promotion deadline expired.")
}

/**
 * Timestamp of the most recent message that engages the bot — its own post or
 * an @mention of it — provided it falls inside the trailing message window.
 * Returns null when the thread has none.
 */
function latestEngagementSeconds(
	replies: readonly ThreadReplyMessage[],
	candidate: FollowUpCandidate,
): number | null {
	const mention = `<@${candidate.botUserId}>`
	// `conversations.replies` is oldest-first, so the trailing window is the tail.
	const recent = replies.slice(-ENGAGEMENT_RECENT_MESSAGE_WINDOW)
	let latest: number | null = null
	for (const message of recent) {
		const engages =
			message.user === candidate.botUserId ||
			(typeof message.text === "string" && message.text.includes(mention))
		if (!engages) continue
		// A message Slack did not timestamp cannot be aged, so it cannot be
		// trusted to still be recent — skip it rather than assume "now".
		const seconds = Number(message.ts)
		if (!Number.isFinite(seconds)) continue
		if (latest === null || seconds > latest) latest = seconds
	}
	return latest
}

function isEngagementRecent(engagedAtSeconds: number | null, candidate: FollowUpCandidate): boolean {
	if (engagedAtSeconds === null) return false
	return candidate.eventTsSeconds - engagedAtSeconds <= ENGAGEMENT_MAX_AGE_SECONDS
}

/**
 * `conversations.replies` returns oldest-first and this fetches ONE page, so
 * without bounds a thread past 100 replies would have its "trailing window"
 * computed over the OLDEST page: fresh engagements invisible, stale ones
 * passing the recency check. `oldest`/`latest` confine the page to the recency
 * horizon ending at the incoming reply, which is the only slice the engagement
 * logic can act on anyway. Slack rejects JSON for this method — form-encoded
 * only.
 *
 * This runs INSIDE the webhook verifier, before eve returns its 200, so it
 * spends Slack's ~3s delivery budget. The caller's deadline signal keeps a
 * slow Slack API from turning into a retry storm: on abort the event passes
 * through unpromoted.
 *
 * Exported only for tests (the request-shape assertions); production reaches
 * it through `defaultDeps`.
 */
export async function fetchThreadRepliesFromSlack(options: {
	readonly botToken: string
	readonly channelId: string
	readonly threadTs: string
	readonly oldest: string
	readonly latest: string
	readonly signal: AbortSignal
}): Promise<readonly ThreadReplyMessage[]> {
	const res = await fetch("https://slack.com/api/conversations.replies", {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.botToken}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			channel: options.channelId,
			ts: options.threadTs,
			oldest: options.oldest,
			latest: options.latest,
			// `latest` is the incoming reply's own ts; inclusive so it is not
			// silently dropped from the window.
			inclusive: "true",
			limit: "100",
		}),
		signal: options.signal,
	})
	if (!res.ok) {
		throw new Error(`Slack conversations.replies failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as {
		ok: boolean
		error?: string
		messages?: ReadonlyArray<Record<string, unknown>>
	}
	if (!payload.ok) {
		throw new Error(`Slack conversations.replies failed: ${payload.error ?? "unknown_error"}`)
	}
	return (payload.messages ?? []).map((message) => ({
		user: typeof message.user === "string" ? message.user : undefined,
		botId: typeof message.bot_id === "string" ? message.bot_id : undefined,
		text: typeof message.text === "string" ? message.text : undefined,
		ts: typeof message.ts === "string" ? message.ts : undefined,
	}))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
