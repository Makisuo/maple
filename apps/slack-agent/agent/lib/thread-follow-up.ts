import { resolveBotToken } from "./maple.js";
import { createTtlCache } from "./ttl-cache.js";

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
  readonly user?: string;
  readonly botId?: string;
  readonly text?: string;
  /** Slack ts ("1700000000.000100"); required for the recency bound. */
  readonly ts?: string;
}

/** Injectable dependencies so tests never touch the network. */
export interface ThreadFollowUpDeps {
  resolveBotToken(context: { teamId?: string }): Promise<string>;
  fetchThreadReplies(options: {
    readonly botToken: string;
    readonly channelId: string;
    readonly threadTs: string;
  }): Promise<readonly ThreadReplyMessage[]>;
}

const defaultDeps: ThreadFollowUpDeps = {
  resolveBotToken,
  fetchThreadReplies: fetchThreadRepliesFromSlack,
};

// Engagement is sticky once established (the bot's reply stays in the thread
// forever), so positive entries can live long. Negative entries stay short so
// a thread the bot joins moments later is picked up quickly. What the cache
// stores is the *timestamp* of the engagement, not a boolean, so the recency
// bound below is re-applied on every hit instead of being frozen for the TTL.
const ENGAGED_TTL_MS = 5 * 60_000;
const NOT_ENGAGED_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_SWEEP_INTERVAL_MS = 60_000;

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
const ENGAGEMENT_MAX_AGE_SECONDS = 30 * 60;
const ENGAGEMENT_RECENT_MESSAGE_WINDOW = 15;

/** Slack's webhook budget is ~3s total; this call happens inside it. */
const THREAD_REPLIES_TIMEOUT_MS = 2_000;

interface EngagementCacheEntry {
  /** Slack ts (epoch seconds) of the engaging message, or null if none. */
  readonly engagedAtSeconds: number | null;
  readonly expiresAt: number;
}

const engagementCache = createTtlCache<EngagementCacheEntry>({
  maxEntries: CACHE_MAX_ENTRIES,
  sweepIntervalMs: CACHE_SWEEP_INTERVAL_MS,
});

/** Test-only: clears the engagement cache so each test starts cold. */
export function resetThreadEngagementCacheForTests(): void {
  engagementCache.clear();
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
  const candidate = parseFollowUpCandidate(rawBody);
  if (!candidate) return null;

  const engaged = await isBotEngagedInThread(candidate, deps);
  if (!engaged) return null;

  candidate.envelope.event.type = "app_mention";
  return JSON.stringify(candidate.envelope);
}

interface FollowUpCandidate {
  readonly envelope: { event: { type: string } } & Record<string, unknown>;
  readonly teamId?: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly botUserId: string;
  /** The incoming reply's own ts, in epoch seconds — the recency reference. */
  readonly eventTsSeconds: number;
}

function parseFollowUpCandidate(rawBody: string): FollowUpCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "event_callback") return null;

  const event = parsed.event;
  if (!isRecord(event) || event.type !== "message") return null;

  const channelType = event.channel_type;
  if (
    channelType !== "channel" &&
    channelType !== "group" &&
    channelType !== "mpim"
  ) {
    return null;
  }

  // User-authored plain messages only — mirrors eve's DM filter.
  const subtype = event.subtype;
  if (typeof subtype === "string" && subtype.length > 0 && subtype !== "file_share") {
    return null;
  }
  if (typeof event.bot_id === "string" && event.bot_id.length > 0) return null;
  if (typeof event.user !== "string" || event.user.length === 0) return null;

  // Thread replies only: a root message has no thread_ts (or thread_ts === ts).
  const ts = typeof event.ts === "string" ? event.ts : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : "";
  if (!ts || !threadTs || threadTs === ts) return null;

  const channelId = typeof event.channel === "string" ? event.channel : "";
  if (!channelId) return null;

  const botUserId = botUserIdFromEnvelope(parsed);
  if (!botUserId) return null;

  // A reply that @-mentions the bot arrives as a real app_mention event too —
  // promoting this twin would dispatch the same turn twice.
  const text = typeof event.text === "string" ? event.text : "";
  if (text.includes(`<@${botUserId}>`)) return null;

  // Use the event's own clock rather than Date.now(): Slack retries deliver
  // the same event minutes later, and the decision must not drift with them.
  const eventTsSeconds = Number(ts);
  if (!Number.isFinite(eventTsSeconds)) return null;

  return {
    envelope: parsed as FollowUpCandidate["envelope"],
    teamId: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
    channelId,
    threadTs,
    botUserId,
    eventTsSeconds,
  };
}

/**
 * The event envelope's `authorizations` names the app's bot user — no
 * `auth.test` round-trip needed.
 */
function botUserIdFromEnvelope(envelope: Record<string, unknown>): string | null {
  const authorizations = envelope.authorizations;
  if (!Array.isArray(authorizations)) return null;
  for (const auth of authorizations) {
    if (isRecord(auth) && typeof auth.user_id === "string" && auth.user_id.length > 0) {
      return auth.user_id;
    }
  }
  return null;
}

async function isBotEngagedInThread(
  candidate: FollowUpCandidate,
  deps: ThreadFollowUpDeps,
): Promise<boolean> {
  // teamId is part of the key: the cache is process-global and this app serves
  // every workspace that installed the Slack app. Slack channel ids are only
  // unique per workspace, so a bare `channel:thread` key lets one tenant's
  // engagement decide another tenant's dispatch.
  const cacheKey = `${candidate.teamId ?? "-"}:${candidate.channelId}:${candidate.threadTs}`;
  const cached = engagementCache.get(cacheKey);
  if (cached) return isEngagementRecent(cached.engagedAtSeconds, candidate);

  const botToken = await deps.resolveBotToken({ teamId: candidate.teamId });
  const replies = await deps.fetchThreadReplies({
    botToken,
    channelId: candidate.channelId,
    threadTs: candidate.threadTs,
  });

  const engagedAtSeconds = latestEngagementSeconds(replies, candidate);

  engagementCache.set(cacheKey, {
    engagedAtSeconds,
    expiresAt:
      Date.now() +
      (engagedAtSeconds === null ? NOT_ENGAGED_TTL_MS : ENGAGED_TTL_MS),
  });
  return isEngagementRecent(engagedAtSeconds, candidate);
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
  const mention = `<@${candidate.botUserId}>`;
  // `conversations.replies` is oldest-first, so the trailing window is the tail.
  const recent = replies.slice(-ENGAGEMENT_RECENT_MESSAGE_WINDOW);
  let latest: number | null = null;
  for (const message of recent) {
    const engages =
      message.user === candidate.botUserId ||
      (typeof message.text === "string" && message.text.includes(mention));
    if (!engages) continue;
    // A message Slack did not timestamp cannot be aged, so it cannot be
    // trusted to still be recent — skip it rather than assume "now".
    const seconds = Number(message.ts);
    if (!Number.isFinite(seconds)) continue;
    if (latest === null || seconds > latest) latest = seconds;
  }
  return latest;
}

function isEngagementRecent(
  engagedAtSeconds: number | null,
  candidate: FollowUpCandidate,
): boolean {
  if (engagedAtSeconds === null) return false;
  return (
    candidate.eventTsSeconds - engagedAtSeconds <= ENGAGEMENT_MAX_AGE_SECONDS
  );
}

/**
 * `conversations.replies` returns oldest-first, so the mention that started
 * the conversation and the bot's first reply land within the first page.
 * Slack rejects JSON for this method — form-encoded only.
 *
 * This runs INSIDE the webhook verifier, before eve returns its 200, so it
 * spends Slack's ~3s delivery budget. The timeout keeps a slow Slack API from
 * turning into a retry storm: on abort the caller (channels/slack.ts) logs and
 * passes the event through unpromoted.
 */
async function fetchThreadRepliesFromSlack(options: {
  readonly botToken: string;
  readonly channelId: string;
  readonly threadTs: string;
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
      limit: "100",
    }),
    signal: AbortSignal.timeout(THREAD_REPLIES_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Slack conversations.replies failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: ReadonlyArray<Record<string, unknown>>;
  };
  if (!payload.ok) {
    throw new Error(
      `Slack conversations.replies failed: ${payload.error ?? "unknown_error"}`,
    );
  }
  return (payload.messages ?? []).map((message) => ({
    user: typeof message.user === "string" ? message.user : undefined,
    botId: typeof message.bot_id === "string" ? message.bot_id : undefined,
    text: typeof message.text === "string" ? message.text : undefined,
    ts: typeof message.ts === "string" ? message.ts : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
