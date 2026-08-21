// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import type { SlackThreadMessage } from "eve/channels/slack"
import { installFetchStub } from "./fetch-stub.js"
import {
	confirmThreadFollowUp,
	pendingFollowUp,
	promoteThreadFollowUp,
	recordThreadEngagement,
	resetThreadFollowUpStateForTests,
	type PendingFollowUp,
} from "./thread-follow-up.js"

const BOT_USER_ID = "U0BOT"
const TEAM_ID = "T123"
const CHANNEL_ID = "C123"
const THREAD_TS = "1700000000.000100"

// ── helpers ─────────────────────────────────────────────────────────────────

function envelope(overrides: {
	event?: Record<string, unknown>
	envelope?: Record<string, unknown>
}): string {
	return JSON.stringify({
		type: "event_callback",
		team_id: TEAM_ID,
		event_id: "Ev123",
		authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
		event: {
			type: "message",
			channel_type: "channel",
			channel: CHANNEL_ID,
			user: "U456",
			text: "can you investigate the root cause?",
			ts: "1700000002.000200",
			thread_ts: THREAD_TS,
			...overrides.event,
		},
		...overrides.envelope,
	})
}

/**
 * Promotes a body and hands back the pending registration the handler would
 * later look up — the two halves are only ever used together.
 */
function promote(
	body: string = envelope({}),
	options: { readonly isSlackRetry?: boolean } = {},
): PendingFollowUp | null {
	const promoted = promoteThreadFollowUp(body, options)
	if (promoted === null) return null
	const parsed = JSON.parse(promoted) as {
		team_id?: string
		event: { channel: string; ts: string }
	}
	return pendingFollowUp({
		teamId: parsed.team_id,
		channelId: parsed.event.channel,
		messageTs: parsed.event.ts,
	})
}

const threadMessage = (overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage => ({
	text: "",
	markdown: "",
	user: undefined,
	botId: undefined,
	ts: THREAD_TS,
	threadTs: THREAD_TS,
	isMe: false,
	raw: {},
	...overrides,
})

const humanMessage = (text: string, ts: string, user = "U456"): SlackThreadMessage =>
	threadMessage({ text, markdown: text, user, ts })

/** The bot's own reply as eve returns it: `user` is the bot AND `botId` is set. */
const botMessage = (ts: string, text = "Here are the reasons why..."): SlackThreadMessage =>
	threadMessage({ text, markdown: text, user: BOT_USER_ID, botId: "B0BOT", ts })

// The default envelope's reply is at ts 1700000002.000200, so this thread is
// alive and the bot is one message behind it.
const ENGAGED_THREAD: readonly SlackThreadMessage[] = [
	humanMessage(`<@${BOT_USER_ID}> why is error rate up?`, "1700000000.000100"),
	botMessage("1700000001.000100"),
]

const UNRELATED_THREAD: readonly SlackThreadMessage[] = [
	humanMessage("lunch?", "1700000000.000100"),
	humanMessage("sure", "1700000001.000100", "U789"),
]

beforeEach(() => {
	resetThreadFollowUpStateForTests()
})

afterEach(() => {
	setSystemTime() // restore the real clock
})

// ── promotion (webhook path) ────────────────────────────────────────────────

describe("promoteThreadFollowUp", () => {
	test("promotes a follow-up reply in a channel thread to app_mention", () => {
		const promoted = promoteThreadFollowUp(envelope({}))
		expect(promoted).not.toBeNull()
		const parsed = JSON.parse(promoted!) as {
			event: Record<string, unknown>
			event_id: string
		}
		expect(parsed.event.type).toBe("app_mention")
		// Everything else is preserved so eve's parser sees a coherent event.
		expect(parsed.event.channel).toBe(CHANNEL_ID)
		expect(parsed.event.thread_ts).toBe(THREAD_TS)
		expect(parsed.event.user).toBe("U456")
		expect(parsed.event_id).toBe("Ev123")
	})

	test("is synchronous and spends no network at all", () => {
		// Incident 1: promotion used to resolve the workspace and fetch the thread
		// INSIDE Slack's ~3s webhook budget, and a cold cache after a deploy blew
		// the 2s deadline — 2009ms, no turn, no log, no ack. There is no deadline
		// to miss any more because there is nothing here to wait for.
		const stub = installFetchStub(() => {
			throw new Error("promotion must not touch the network")
		})
		try {
			const promoted = promoteThreadFollowUp(envelope({}))
			// Not a promise: a `then` here would mean something can still be awaited.
			expect(typeof promoted).toBe("string")
			expect(stub.calls.length).toBe(0)
		} finally {
			stub.restore()
		}
	})

	test("registers the reply as pending, keyed by team + channel + message ts", () => {
		const pending = promote()
		expect(pending?.teamId).toBe(TEAM_ID)
		expect(pending?.channelId).toBe(CHANNEL_ID)
		expect(pending?.threadTs).toBe(THREAD_TS)
		expect(pending?.messageTs).toBe("1700000002.000200")
		// Carried from the envelope's `authorizations`, so the confirmation never
		// has to guess which user id is ours.
		expect(pending?.botUserId).toBe(BOT_USER_ID)
		expect(pending?.ackable).toBe(true)
	})

	test("a Slack redelivery is still promoted, but does not re-ack", () => {
		// The :eyes: is already on the message; `already_reacted` is tolerated
		// downstream, this just skips the pointless call.
		expect(promote(envelope({}), { isSlackRetry: true })?.ackable).toBe(false)
	})

	test("private-channel (group) replies qualify too", () => {
		expect(promoteThreadFollowUp(envelope({ event: { channel_type: "group" } }))).not.toBeNull()
	})

	test("group-DM (mpim) replies qualify too", () => {
		expect(promoteThreadFollowUp(envelope({ event: { channel_type: "mpim" } }))).not.toBeNull()
	})

	test("file_share subtype replies qualify (mirrors eve's DM filter)", () => {
		expect(promoteThreadFollowUp(envelope({ event: { subtype: "file_share" } }))).not.toBeNull()
	})
})

// ── pass-through cases ──────────────────────────────────────────────────────

describe("pass-through", () => {
	const passesThrough = (body: string): void => {
		expect(promoteThreadFollowUp(body)).toBeNull()
		// Nothing registered either: the handler must treat these as real events.
		expect(
			pendingFollowUp({ teamId: TEAM_ID, channelId: CHANNEL_ID, messageTs: "1700000002.000200" }),
		).toBeNull()
	}

	test("reply that already @-mentions the bot (arrives as a real app_mention)", () => {
		passesThrough(envelope({ event: { text: `<@${BOT_USER_ID}> and what about latency?` } }))
	})

	test("bot-authored replies (no self-triggering loop)", () => {
		passesThrough(envelope({ event: { bot_id: "B999" } }))
	})

	test("top-level channel messages (not a thread reply)", () => {
		passesThrough(envelope({ event: { thread_ts: undefined } }))
		expect(promoteThreadFollowUp(envelope({ event: { ts: THREAD_TS, thread_ts: THREAD_TS } }))).toBeNull()
	})

	test("DMs (eve dispatches those on its own)", () => {
		passesThrough(envelope({ event: { channel_type: "im" } }))
	})

	test("edits and other subtypes", () => {
		passesThrough(envelope({ event: { subtype: "message_changed" } }))
	})

	test("non-message events", () => {
		passesThrough(envelope({ event: { type: "reaction_added" } }))
	})

	test("envelope without authorizations (bot user unknown)", () => {
		passesThrough(envelope({ envelope: { authorizations: undefined } }))
	})

	test("interaction form posts / non-JSON bodies", () => {
		passesThrough("payload=%7B%7D")
	})

	test("url_verification and other envelope types", () => {
		passesThrough(JSON.stringify({ type: "url_verification", challenge: "x" }))
	})
})

describe("pendingFollowUp", () => {
	test("a real app_mention was never promoted, so it has no pending entry", () => {
		expect(
			pendingFollowUp({ teamId: TEAM_ID, channelId: CHANNEL_ID, messageTs: "1700000002.000200" }),
		).toBeNull()
	})

	test("the key includes the team: one workspace cannot answer for another", () => {
		// Slack channel ids are only unique per workspace, and this registry is
		// process-global across every tenant that installed the app.
		promote()
		expect(
			pendingFollowUp({ teamId: "T999", channelId: CHANNEL_ID, messageTs: "1700000002.000200" }),
		).toBeNull()
	})

	test("reading it does not consume it: the same message is judged the same way twice", () => {
		promote()
		const target = { teamId: TEAM_ID, channelId: CHANNEL_ID, messageTs: "1700000002.000200" }
		expect(pendingFollowUp(target)).not.toBeNull()
		expect(pendingFollowUp(target)).not.toBeNull()
	})
})

// ── confirmation (dispatch path) ────────────────────────────────────────────

describe("confirmThreadFollowUp", () => {
	test("promotes a reply in a thread the bot replied in", () => {
		expect(confirmThreadFollowUp(promote()!, ENGAGED_THREAD)).toEqual({
			engaged: true,
			reason: "recent-engagement",
		})
	})

	test("promotes when the bot was mentioned in the thread but has not replied yet", () => {
		const mentionOnly = [humanMessage(`<@${BOT_USER_ID}> why is error rate up?`, THREAD_TS)]
		expect(confirmThreadFollowUp(promote()!, mentionOnly).engaged).toBe(true)
	})

	test("spends no network: it reads the thread the handler already loaded", () => {
		const stub = installFetchStub(() => {
			throw new Error("confirmation must not fetch the thread a second time")
		})
		try {
			expect(confirmThreadFollowUp(promote()!, ENGAGED_THREAD).engaged).toBe(true)
			expect(stub.calls.length).toBe(0)
		} finally {
			stub.restore()
		}
	})

	test("a thread nobody has touched for over a day is dormant", () => {
		// 24h + 1 minute after the previous message in the thread.
		const pending = promote(envelope({ event: { ts: "1700086461.000200" } }))!
		expect(confirmThreadFollowUp(pending, ENGAGED_THREAD)).toEqual({
			engaged: false,
			workedInThread: true,
			reason: "thread-dormant",
		})
	})

	test("dormancy is measured from the thread's last message, not the bot's", () => {
		// THE REGRESSION. A user replied 61.3 minutes after the bot's last post in
		// a thread people were still using. The old rule expired engagement after
		// 30 minutes AND derived the `conversations.replies` window from that same
		// constant — so the fetch began 31 minutes after the bot had last spoken
		// and the check could not see the bot's own messages at all. It answered
		// "not engaged" in 406ms: no timeout, just confidently wrong.
		const botPostSeconds = 1700000001
		const replySeconds = botPostSeconds + Math.round(61.3 * 60)
		const thread = [
			humanMessage(`<@${BOT_USER_ID}> why is error rate up?`, "1700000000.000100"),
			botMessage(`${botPostSeconds}.000100`),
			// The thread kept moving while the bot stayed quiet — which is exactly
			// what a live incident thread looks like.
			humanMessage("checking the deploy log", `${botPostSeconds + 1800}.000100`, "U789"),
		]
		const pending = promote(envelope({ event: { ts: `${replySeconds}.000200` } }))!
		expect(confirmThreadFollowUp(pending, thread)).toEqual({
			engaged: true,
			reason: "recent-engagement",
		})
	})

	test("an engagement pushed out of the trailing message window does not promote", () => {
		// Bot spoke first, then 14 human messages buried it — the conversation has
		// demonstrably moved on, however recently it did so.
		const chatter = Array.from({ length: 14 }, (_, i) =>
			humanMessage(`chatter ${i}`, `1700000${String(10 + i).padStart(3, "0")}.000100`),
		)
		const pending = promote(envelope({ event: { ts: "1700000100.000200" } }))!
		expect(confirmThreadFollowUp(pending, [botMessage("1700000001.000100"), ...chatter])).toEqual({
			engaged: false,
			workedInThread: true,
			reason: "engagement-buried",
		})
	})

	test("an engagement still inside the trailing window promotes", () => {
		// One fewer message: the bot, 13 replies and this one make 15.
		const chatter = Array.from({ length: 13 }, (_, i) =>
			humanMessage(`chatter ${i}`, `1700000${String(10 + i).padStart(3, "0")}.000100`),
		)
		const pending = promote(envelope({ event: { ts: "1700000100.000200" } }))!
		expect(confirmThreadFollowUp(pending, [botMessage("1700000001.000100"), ...chatter]).engaged).toBe(
			true,
		)
	})

	test("a thread the bot has never been in is declined, and stays silent", () => {
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD)).toEqual({
			engaged: false,
			workedInThread: false,
			reason: "never-engaged",
		})
	})

	test("another bot's post is not our engagement", () => {
		// eve's `isMe` is `bot_id !== undefined`, i.e. ANY bot — so a GitHub or CI
		// app in the same channel would otherwise read as us.
		const github = threadMessage({
			text: "PR #338 merged",
			markdown: "PR #338 merged",
			user: "U0GITHUB",
			botId: "B0GITHUB",
			isMe: true,
			ts: "1700000001.000100",
		})
		expect(confirmThreadFollowUp(promote()!, [github]).engaged).toBe(false)
	})

	test("a Maple alert card counts: the bot posted it, and the thread hangs off it", () => {
		const alert = threadMessage({
			user: BOT_USER_ID,
			botId: "B0BOT",
			isMe: true,
			ts: "1700000001.000100",
			raw: { attachments: [{ fallback: "🚨 checkout p95 — Firing" }] },
		})
		expect(confirmThreadFollowUp(promote()!, [alert]).engaged).toBe(true)
	})

	test("mentions are matched on the raw text, which eve's markdown may have rewritten", () => {
		const mention = threadMessage({
			text: `<@${BOT_USER_ID}> take a look`,
			markdown: "@maple take a look",
			user: "U789",
			ts: "1700000001.000100",
		})
		expect(confirmThreadFollowUp(promote()!, [mention]).engaged).toBe(true)
	})
})

// ── failing open ────────────────────────────────────────────────────────────

// A wrong drop costs a user their message with nothing on screen to explain it;
// a wrong dispatch costs one turn in a thread the bot was already part of. The
// two are not symmetric, so absent evidence promotes.

describe("failing open", () => {
	test("an unreadable thread promotes rather than losing the message", () => {
		expect(confirmThreadFollowUp(promote()!, null)).toEqual({
			engaged: true,
			reason: "thread-unreadable",
		})
	})

	test("a truncated page with no visible engagement promotes", () => {
		// eve's `thread.refresh()` fetches ONE oldest-first page of 50, so on a
		// longer thread the tail — where any recent engagement lives — is exactly
		// what is missing.
		const longThread = Array.from({ length: 49 }, (_, i) =>
			humanMessage(`chatter ${i}`, `1700000${String(100 + i).padStart(3, "0")}.000100`),
		)
		const pending = promote(envelope({ event: { ts: "1700000200.000200" } }))!
		expect(confirmThreadFollowUp(pending, longThread)).toEqual({
			engaged: true,
			reason: "page-truncated",
		})
	})

	test("a short page with no engagement is a real answer, not a missing one", () => {
		const shortThread = Array.from({ length: 48 }, (_, i) =>
			humanMessage(`chatter ${i}`, `1700000${String(100 + i).padStart(3, "0")}.000100`),
		)
		const pending = promote(envelope({ event: { ts: "1700000200.000200" } }))!
		expect(confirmThreadFollowUp(pending, shortThread).engaged).toBe(false)
	})
})

// ── caching ─────────────────────────────────────────────────────────────────

describe("engagement cache", () => {
	test("a warm entry short-circuits the whole check", () => {
		recordThreadEngagement(botPost())
		// The page says otherwise and loses: the cache is proof of something the
		// bot did here within the last five minutes, which the page (one oldest-
		// first slice of a possibly much longer thread) cannot contradict.
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD)).toEqual({
			engaged: true,
			reason: "cached-engagement",
		})
	})

	test("a confirmation from the page warms the cache for the next follow-up", () => {
		expect(confirmThreadFollowUp(promote()!, ENGAGED_THREAD).reason).toBe("recent-engagement")
		const second = promote(envelope({ event: { ts: "1700000003.000300" } }))!
		expect(confirmThreadFollowUp(second, UNRELATED_THREAD).reason).toBe("cached-engagement")
	})

	test("a declined confirmation caches nothing", () => {
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(false)
		// No negative entry to go stale: the bot joining the thread a second later
		// is picked up by the very next reply.
		const second = promote(envelope({ event: { ts: "1700000003.000300" } }))!
		expect(confirmThreadFollowUp(second, ENGAGED_THREAD).engaged).toBe(true)
	})

	test("the entry expires, so a thread that went quiet is re-judged from the page", () => {
		setSystemTime(new Date("2026-07-21T12:00:00Z"))
		recordThreadEngagement(botPost())
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(true)

		// Past ENGAGED_TTL_MS: the cache no longer proves anything and the thread
		// page has the only say.
		setSystemTime(new Date("2026-07-21T12:05:01Z"))
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("threads are cached independently", () => {
		recordThreadEngagement(botPost())
		const otherThread = promote(
			envelope({ event: { thread_ts: "1700000010.000100", ts: "1700000011.000200" } }),
		)!
		expect(confirmThreadFollowUp(otherThread, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("the cache key includes the team: one workspace cannot answer for another", () => {
		recordThreadEngagement(botPost())
		const otherTeam = promote(envelope({ envelope: { team_id: "T999" } }))!
		expect(confirmThreadFollowUp(otherTeam, UNRELATED_THREAD).engaged).toBe(false)
	})
})

// ── engagement learned from the event stream ────────────────────────────────

// Everything the bot does in a thread already comes back through the events
// stream, so the cheap path should carry most threads — and, unlike the thread
// page, it still works past eve's 50-message limit.

/** The bot's own post echoing back: `bot_id` set AND `user` = the bot. */
function botPost(overrides: Record<string, unknown> = {}): string {
	return envelope({
		event: {
			bot_id: "B0BOT",
			user: BOT_USER_ID,
			text: "Here are the reasons why...",
			ts: "1700000001.000100",
			...overrides,
		},
	})
}

describe("recordThreadEngagement", () => {
	test("the bot's own post warms the thread", () => {
		recordThreadEngagement(botPost())
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(true)
	})

	test("an @mention of the bot warms the thread too", () => {
		recordThreadEngagement(
			envelope({
				event: { text: `<@${BOT_USER_ID}> why is error rate up?`, ts: "1700000001.000100" },
			}),
		)
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(true)
	})

	test("a root-level mention is keyed by its own ts — the ts that becomes the thread", () => {
		// No thread_ts yet: the thread does not exist until the bot replies.
		recordThreadEngagement(
			envelope({
				event: {
					type: "app_mention",
					channel_type: undefined,
					thread_ts: undefined,
					text: `<@${BOT_USER_ID}> take a look`,
					ts: THREAD_TS,
				},
			}),
		)
		// The default envelope replies in thread 1700000000.000100 — the mention's
		// own ts. Its very first follow-up is already warm.
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(true)
	})

	test("the regression: a follow-up 3 minutes after the bot's last post, on a cold cache", () => {
		// Incident 1, from the other side. A deploy wipes this cache, so the very
		// next follow-up used to pay the full workspace-resolve + thread-fetch
		// round-trip inside Slack's webhook budget, miss the 2s deadline and be
		// dropped in silence. Nothing is warm here and nothing needs to be: the
		// decision reads the thread the handler loaded anyway, off the budget.
		setSystemTime(new Date("2026-08-05T19:27:44Z"))
		const botPostTs = "1785958064.000100"
		const followUpTs = "1785958238.000200" // 2m54s later

		setSystemTime(new Date("2026-08-05T19:30:38Z"))
		const stub = installFetchStub(() => {
			throw new Error("a cold cache must not cost a network call any more")
		})
		try {
			const pending = promote(envelope({ event: { ts: followUpTs } }))!
			const decision = confirmThreadFollowUp(pending, [
				humanMessage(`<@${BOT_USER_ID}> why is error rate up?`, THREAD_TS),
				botMessage(botPostTs),
			])
			expect(decision).toEqual({ engaged: true, reason: "recent-engagement" })
			expect(stub.calls.length).toBe(0)
		} finally {
			stub.restore()
		}
	})

	test("a stranger's message teaches nothing", () => {
		recordThreadEngagement(envelope({ event: { text: "lunch?" } }))
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("another bot's post teaches nothing (it is not our engagement)", () => {
		recordThreadEngagement(botPost({ user: "U0OTHERBOT", bot_id: "B0GITHUB" }))
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("teams stay isolated", () => {
		recordThreadEngagement(botPost())
		const otherTeam = promote(envelope({ envelope: { team_id: "T999" } }))!
		expect(confirmThreadFollowUp(otherTeam, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("edits, DMs, non-events and unreadable bodies are all no-ops", () => {
		recordThreadEngagement(botPost({ subtype: "message_changed" }))
		recordThreadEngagement(botPost({ channel_type: "im" }))
		recordThreadEngagement(botPost({ type: "reaction_added" }))
		recordThreadEngagement(botPost({ ts: undefined }))
		recordThreadEngagement("not json")
		recordThreadEngagement(JSON.stringify({ type: "url_verification", challenge: "x" }))
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(false)
	})

	test("a file_share post (the bot uploading a chart) counts", () => {
		recordThreadEngagement(botPost({ subtype: "file_share" }))
		expect(confirmThreadFollowUp(promote()!, UNRELATED_THREAD).engaged).toBe(true)
	})
})
