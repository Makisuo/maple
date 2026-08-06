import type { SlackThreadMessage } from "eve/channels/slack"
import { resolveBotToken } from "./maple.js"
import type { FollowUpDisengagedReason } from "./thread-follow-up.js"
import { createTtlCache } from "./ttl-cache.js"

/**
 * Telling people the bot has left a thread.
 *
 * Thread follow-ups (`#lib/thread-follow-up.js`) let users keep talking to the
 * bot without re-@-mentioning it — until one of the disengagement bounds trips,
 * at which point the reply is dropped. That drop is *correct* and it is also
 * completely invisible: no reply, no `:eyes:`, no error. The user sees a bot
 * that answered them ten messages ago and is now ignoring them, and has no way
 * to know that one @mention would bring it straight back.
 *
 * So a disengagement that ends a conversation the bot was actually part of gets
 * a DM. The distinction matters: a thread the bot has never been in is ordinary
 * channel chatter, and DMing about it would be the bot introducing itself to
 * strangers, uninvited. `confirmThreadFollowUp` reports which case it is
 * (`workedInThread`), which it can only do now that the engagement check reads
 * the whole thread rather than a window that began after the bot's last post.
 *
 * Everyone who spoke in the thread is notified, not only the person whose reply
 * was dropped: in a thread the bot was working in, the whole group loses its
 * answer, and whoever asks next should not have to rediscover the same silence.
 *
 * Fired without awaiting and never throws — same contract as
 * `forwardUninstallEvent` / `acknowledgeIncomingMessage`. A notice that fails to
 * send must not cost anything else; the thread is already not getting a turn.
 *
 * Scopes: `im:write` (open the DM) and `chat:write` (post it), both already
 * granted — no reinstall.
 */

const SLACK_API = "https://slack.com/api"

/**
 * A stalled Slack API must not keep a fire-and-forget notice (and the bot token
 * it holds) alive indefinitely.
 */
const SLACK_API_TIMEOUT_MS = 10_000

/**
 * One notice per thread per disengagement episode.
 *
 * Without this, every subsequent reply in a thread the bot has left would DM
 * everyone again — turning a helpful nudge into exactly the kind of noise that
 * gets an app uninstalled.
 *
 * The TTL matches the dormancy bound in `#lib/thread-follow-up.js` on purpose:
 * a thread can only re-enter dormancy after another full day of silence, so one
 * day of suppression is precisely one episode. A thread that disengaged the
 * other way (the conversation ran past the bot) is even better served — it is
 * busy, so it would otherwise re-notify the most.
 */
const NOTICE_TTL_MS = 24 * 60 * 60_000
const NOTICE_CACHE_MAX_ENTRIES = 500
const NOTICE_CACHE_SWEEP_INTERVAL_MS = 60_000

interface NoticeEntry {
	readonly expiresAt: number
}

const noticedThreads = createTtlCache<NoticeEntry>({
	maxEntries: NOTICE_CACHE_MAX_ENTRIES,
	sweepIntervalMs: NOTICE_CACHE_SWEEP_INTERVAL_MS,
})

/** Test-only: forgets which threads have been notified. */
export function resetDisengageNoticeStateForTests(): void {
	noticedThreads.clear()
}

/**
 * Process-global cache across every tenant, and Slack channel ids are only
 * unique per workspace — the team has to be in the key.
 */
function noticeKey(teamId: string | undefined, channelId: string, threadTs: string): string {
	return `${teamId ?? "-"}:${channelId}:${threadTs}`
}

export interface ThreadDisengagement {
	readonly teamId: string | undefined
	readonly channelId: string
	readonly threadTs: string
	/** Slack ts of the reply that went unanswered — where the permalink points. */
	readonly messageTs: string
	readonly reason: FollowUpDisengagedReason
	/** The thread as the handler loaded it; the notice's recipient list. */
	readonly messages: readonly SlackThreadMessage[]
	/** Author of the dropped reply. Always notified, even if this is their first message. */
	readonly replierUserId: string | undefined
	/** This workspace's bot user id (`#lib/bot-identity.js`), so it can exclude itself. */
	readonly botUserId: string | undefined
}

/** Injectable dependencies so tests never touch the network. */
export interface DisengageNoticeDeps {
	resolveBotToken(context: { teamId?: string }): Promise<string>
	getPermalink(options: {
		readonly botToken: string
		readonly channelId: string
		readonly messageTs: string
	}): Promise<string | null>
	postDirectMessage(options: {
		readonly botToken: string
		/** Slack user id: `chat.postMessage` opens the DM itself when `channel` is one. */
		readonly userId: string
		readonly text: string
	}): Promise<void>
	/** In-thread, visible to one user only (`chat.postEphemeral` with a `thread_ts`). */
	postEphemeral(options: {
		readonly botToken: string
		readonly channelId: string
		readonly threadTs: string
		readonly userId: string
		readonly text: string
	}): Promise<void>
}

export const defaultDisengageNoticeDeps: DisengageNoticeDeps = {
	resolveBotToken,
	getPermalink: getPermalinkFromSlack,
	postDirectMessage: postDirectMessageViaSlack,
	postEphemeral: postEphemeralViaSlack,
}

/**
 * The distinct humans who spoke in the thread, oldest first, with the author of
 * the dropped reply guaranteed to be among them (their message is not part of
 * the loaded thread — it is the one that triggered this).
 *
 * Bots are excluded, this one included. `botId` is the right filter rather than
 * a user-id comparison alone: Maple's own alert cards are posted through this
 * bot user and are nobody's message, and a GitHub or CI app's posts are nobody
 * to DM either.
 *
 * Exported for the tests; `notifyThreadDisengagement` calls it itself.
 */
export function humanThreadParticipants(disengagement: ThreadDisengagement): readonly string[] {
	const participants: string[] = []
	const add = (user: string | undefined): void => {
		if (user === undefined || user.length === 0) return
		if (user === disengagement.botUserId) return
		if (!participants.includes(user)) participants.push(user)
	}
	for (const message of disengagement.messages) {
		if (message.botId !== undefined) continue
		add(message.user)
	}
	add(disengagement.replierUserId)
	return participants
}

/**
 * Who actually receives the DM, which is deliberately not the same as who was
 * in the thread. The two disengagement reasons describe opposite situations and
 * a single fan-out rule cannot serve both.
 *
 * `thread-dormant` — the conversation itself went quiet for a day and the bot
 * stepped out of it. Nobody is mid-discussion, everyone who took part has a
 * stake in knowing it is no longer listening, and the DM is the only thing that
 * will tell them. Everyone gets it.
 *
 * `engagement-buried` — the exact opposite: the thread is *lively*, it has
 * simply run past the bot's last involvement. Fanning out here would DM people
 * who moved on long ago, about a message they did not write, in a thread that
 * is still busy — the notification becomes the noise. Only the person whose
 * reply went unanswered actually needs to know.
 *
 * Falls back to the full list when the replier is unknown or is the bot itself:
 * telling the wrong set of people is recoverable, telling nobody is the failure
 * this whole path exists to prevent.
 *
 * Exported for the tests; `notifyThreadDisengagement` calls it itself.
 */
export function noticeRecipients(disengagement: ThreadDisengagement): readonly string[] {
	const participants = humanThreadParticipants(disengagement)
	if (disengagement.reason !== "engagement-buried") return participants

	const replier = disengagement.replierUserId
	if (replier === undefined || replier.length === 0 || replier === disengagement.botUserId) {
		return participants
	}
	return [replier]
}

/**
 * DMs that the bot did not pick up the latest reply, and how to bring it back.
 * Who receives it depends on why it disengaged — see `noticeRecipients`.
 * Intended to be fired without awaiting — it never throws.
 */
export async function notifyThreadDisengagement(
	disengagement: ThreadDisengagement,
	deps: DisengageNoticeDeps = defaultDisengageNoticeDeps,
): Promise<void> {
	try {
		const key = noticeKey(disengagement.teamId, disengagement.channelId, disengagement.threadTs)
		if (noticedThreads.get(key) !== undefined) return

		const recipients = noticeRecipients(disengagement)
		if (recipients.length === 0) return

		// Claimed before the sends, not after: a Slack outage mid-notice must not
		// leave the thread eligible to try the whole fan-out again on the next
		// reply. One missed notice beats a repeating one.
		noticedThreads.set(key, { expiresAt: Date.now() + NOTICE_TTL_MS })

		const botToken = await deps.resolveBotToken({ teamId: disengagement.teamId })
		// One permalink for the whole fan-out — it is the same message.
		const permalink = await deps
			.getPermalink({
				botToken,
				channelId: disengagement.channelId,
				messageTs: disengagement.messageTs,
			})
			.catch(() => null)
		const text = disengagementNoticeText(disengagement.reason, permalink)

		// One recipient's closed DM (or a deactivated account) must not cost the
		// others theirs.
		await Promise.all(
			recipients.map(async (userId) => {
				try {
					await notifyOne(deps, userId, { botToken, text, disengagement })
				} catch (error) {
					console.warn(
						`[slack-disengage-notice] Failed to notify ${userId} about a thread the bot stopped following.`,
						error,
					)
				}
			}),
		)
	} catch (error) {
		console.warn("[slack-disengage-notice] Disengagement notice failed — ignored.", error)
	}
}

/**
 * Delivers the notice to one person, by whichever channel will actually reach
 * them.
 *
 * The author of the unanswered reply just posted in the thread, so they are the
 * one person we know is looking at it. An ephemeral reply lands in context —
 * under the message it is about, in the conversation they are already reading —
 * without pulling them into a DM for something that belongs in the thread.
 *
 * Everyone else is not looking at the thread at all; that is the whole reason
 * they need telling. `chat.postEphemeral` renders nothing for a user who does
 * not have the channel open and Slack never stores it, so for them a DM is the
 * only thing that arrives.
 *
 * The same non-persistence is why an ephemeral failure falls back to a DM
 * rather than being swallowed: Slack drops it outright if the user has left the
 * channel, and a notice that evaporates is the silence this exists to prevent.
 */
async function notifyOne(
	deps: DisengageNoticeDeps,
	userId: string,
	context: {
		readonly botToken: string
		readonly text: string
		readonly disengagement: ThreadDisengagement
	},
): Promise<void> {
	const { botToken, text, disengagement } = context
	if (userId !== disengagement.replierUserId) {
		await deps.postDirectMessage({ botToken, userId, text })
		return
	}
	try {
		await deps.postEphemeral({
			botToken,
			channelId: disengagement.channelId,
			threadTs: disengagement.threadTs,
			userId,
			text,
		})
	} catch (error) {
		console.warn(
			`[slack-disengage-notice] Ephemeral notice to ${userId} failed; falling back to a DM.`,
			error,
		)
		await deps.postDirectMessage({ botToken, userId, text })
	}
}

/**
 * The notice itself. Two things have to land: why the bot went quiet (so it does not
 * read as a bug), and the one action that undoes it. The thread link comes
 * second because the sentence has to make sense in a notification preview,
 * where the link is just text.
 *
 * Exported for the tests.
 */
export function disengagementNoticeText(reason: FollowUpDisengagedReason, permalink: string | null): string {
	const why =
		reason === "thread-dormant"
			? "the thread had been quiet for over a day, so I'd stepped out of it"
			: "the conversation had moved well past the last message I was part of, so I'd stepped out of it"
	const where = permalink === null ? "a Slack thread" : `<${permalink}|a Slack thread>`
	return [
		`:zzz: There's a new reply in ${where} I'd been working in, and I didn't pick it up — ${why}.`,
		"",
		"@-mention me in that thread and I'll jump straight back in.",
	].join("\n")
}

/**
 * `chat.getPermalink`. Returns null rather than throwing when Slack cannot
 * produce one: the notice is still worth sending without a link.
 *
 * Exported for the request-shape tests; production reaches it through
 * `defaultDisengageNoticeDeps`.
 */
export async function getPermalinkFromSlack(options: {
	readonly botToken: string
	readonly channelId: string
	readonly messageTs: string
}): Promise<string | null> {
	// The one read method here, and Slack prefers GET for it.
	const query = new URLSearchParams({
		channel: options.channelId,
		message_ts: options.messageTs,
	})
	const res = await fetch(`${SLACK_API}/chat.getPermalink?${query.toString()}`, {
		headers: { authorization: `Bearer ${options.botToken}` },
		signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
	})
	if (!res.ok) return null
	const payload = (await res.json()) as { ok: boolean; permalink?: string }
	if (!payload.ok || typeof payload.permalink !== "string") return null
	return payload.permalink
}

/**
 * `chat.postMessage` addressed to a user id: Slack opens (or reuses) the DM
 * conversation itself, so there is no `conversations.open` hop to make.
 *
 * Exported for the request-shape tests; production reaches it through
 * `defaultDisengageNoticeDeps`.
 */
export async function postDirectMessageViaSlack(options: {
	readonly botToken: string
	readonly userId: string
	readonly text: string
}): Promise<void> {
	const res = await fetch(`${SLACK_API}/chat.postMessage`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.botToken}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({ channel: options.userId, text: options.text }),
		signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Slack chat.postMessage failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as { ok: boolean; error?: string }
	if (!payload.ok) {
		throw new Error(`Slack chat.postMessage failed: ${payload.error ?? "unknown_error"}`)
	}
}

/**
 * `chat.postEphemeral` with a `thread_ts`: renders inside the thread, visible
 * to `user` alone. Slack does not persist it — it is gone on the next client
 * reload and never appears in thread history — so this is only ever used for
 * someone we know is reading the thread right now, with a DM behind it.
 *
 * Exported for the request-shape tests; production reaches it through
 * `defaultDisengageNoticeDeps`.
 */
export async function postEphemeralViaSlack(options: {
	readonly botToken: string
	readonly channelId: string
	readonly threadTs: string
	readonly userId: string
	readonly text: string
}): Promise<void> {
	const res = await fetch(`${SLACK_API}/chat.postEphemeral`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.botToken}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({
			channel: options.channelId,
			thread_ts: options.threadTs,
			user: options.userId,
			text: options.text,
		}),
		signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Slack chat.postEphemeral failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as { ok: boolean; error?: string }
	if (!payload.ok) {
		throw new Error(`Slack chat.postEphemeral failed: ${payload.error ?? "unknown_error"}`)
	}
}
