import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { installFetchStub } from "./fetch-stub.js"
import {
	fetchThreadRepliesFromSlack,
	promoteThreadFollowUp,
	resetThreadEngagementCacheForTests,
	type ThreadFollowUpDeps,
	type ThreadReplyMessage,
} from "./thread-follow-up.js"

const BOT_USER_ID = "U0BOT"

// ── helpers ─────────────────────────────────────────────────────────────────

function envelope(overrides: {
	event?: Record<string, unknown>
	envelope?: Record<string, unknown>
}): string {
	return JSON.stringify({
		type: "event_callback",
		team_id: "T123",
		event_id: "Ev123",
		authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
		event: {
			type: "message",
			channel_type: "channel",
			channel: "C123",
			user: "U456",
			text: "can you investigate the root cause?",
			ts: "1700000002.000200",
			thread_ts: "1700000000.000100",
			...overrides.event,
		},
		...overrides.envelope,
	})
}

function makeDeps(replies: readonly ThreadReplyMessage[]): {
	deps: ThreadFollowUpDeps
	calls: () => number
} {
	let fetchCalls = 0
	return {
		deps: {
			resolveBotToken: async () => "xoxb-test",
			fetchThreadReplies: async () => {
				fetchCalls += 1
				return replies
			},
		},
		calls: () => fetchCalls,
	}
}

// The default envelope's reply is at ts 1700000002.000200, so both of these
// engagements are seconds old — comfortably inside the recency bound.
const ENGAGED_THREAD: readonly ThreadReplyMessage[] = [
	{
		user: "U456",
		text: `<@${BOT_USER_ID}> why is error rate up?`,
		ts: "1700000000.000100",
	},
	{
		user: BOT_USER_ID,
		text: "Here are the reasons why...",
		ts: "1700000001.000100",
	},
]

const UNRELATED_THREAD: readonly ThreadReplyMessage[] = [
	{ user: "U456", text: "lunch?", ts: "1700000000.000100" },
	{ user: "U789", text: "sure", ts: "1700000001.000100" },
]

beforeEach(() => {
	resetThreadEngagementCacheForTests()
})

afterEach(() => {
	setSystemTime() // restore the real clock
})

// ── promotion ───────────────────────────────────────────────────────────────

describe("promoteThreadFollowUp", () => {
	test("promotes a follow-up reply in an engaged thread to app_mention", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const promoted = await promoteThreadFollowUp(envelope({}), deps)
		expect(promoted).not.toBeNull()
		const parsed = JSON.parse(promoted!) as {
			event: Record<string, unknown>
			event_id: string
		}
		expect(parsed.event.type).toBe("app_mention")
		// Everything else is preserved so eve's parser sees a coherent event.
		expect(parsed.event.channel).toBe("C123")
		expect(parsed.event.thread_ts).toBe("1700000000.000100")
		expect(parsed.event.user).toBe("U456")
		expect(parsed.event_id).toBe("Ev123")
	})

	test("promotes when the bot was mentioned in the thread but has not replied yet", async () => {
		const { deps } = makeDeps([
			{
				user: "U456",
				text: `<@${BOT_USER_ID}> why is error rate up?`,
				ts: "1700000000.000100",
			},
		])
		expect(await promoteThreadFollowUp(envelope({}), deps)).not.toBeNull()
	})

	test("private-channel (group) replies qualify too", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { channel_type: "group" } })
		expect(await promoteThreadFollowUp(body, deps)).not.toBeNull()
	})

	test("group-DM (mpim) replies qualify too", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { channel_type: "mpim" } })
		expect(await promoteThreadFollowUp(body, deps)).not.toBeNull()
	})

	test("file_share subtype replies qualify (mirrors eve's DM filter)", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { subtype: "file_share" } })
		expect(await promoteThreadFollowUp(body, deps)).not.toBeNull()
	})
})

// ── engagement recency bounds ───────────────────────────────────────────────

// Engagement is not permanent: once anyone has mentioned the bot, an unbounded
// rule would dispatch a full agent turn for every later human reply in that
// thread forever — a cost amplifier and a standing prompt-injection intake.

describe("engagement recency", () => {
	test("a stale engagement (>30 min before the reply) does not promote", async () => {
		const { deps } = makeDeps([
			{
				user: BOT_USER_ID,
				text: "Here are the reasons why...",
				ts: "1700000001.000100",
			},
		])
		// 31 minutes after the bot's last message in the thread.
		const body = envelope({ event: { ts: "1700001861.000200" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("an engagement just inside the 30-minute window still promotes", async () => {
		const { deps } = makeDeps([
			{
				user: BOT_USER_ID,
				text: "Here are the reasons why...",
				ts: "1700000001.000100",
			},
		])
		const body = envelope({ event: { ts: "1700001799.000200" } })
		expect(await promoteThreadFollowUp(body, deps)).not.toBeNull()
	})

	test("an engagement pushed out of the trailing message window does not promote", async () => {
		// Bot spoke first, then 20 human messages buried it — recent in time, but
		// the conversation has demonstrably moved on.
		const chatter: ThreadReplyMessage[] = Array.from({ length: 20 }, (_, i) => ({
			user: "U456",
			text: `chatter ${i}`,
			ts: `17000000${String(10 + i).padStart(2, "0")}.000100`,
		}))
		const { deps } = makeDeps([{ user: BOT_USER_ID, text: "on it", ts: "1700000001.000100" }, ...chatter])
		const body = envelope({ event: { ts: "1700000031.000200" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("a message with no ts cannot be aged, so it does not count as engagement", async () => {
		const { deps } = makeDeps([{ user: BOT_USER_ID, text: "on it" }])
		expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull()
	})
})

// ── pass-through cases ──────────────────────────────────────────────────────

describe("pass-through", () => {
	test("thread the bot is not part of", async () => {
		const { deps } = makeDeps(UNRELATED_THREAD)
		expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull()
	})

	test("reply that already @-mentions the bot (arrives as a real app_mention)", async () => {
		const { deps, calls } = makeDeps(ENGAGED_THREAD)
		const body = envelope({
			event: { text: `<@${BOT_USER_ID}> and what about latency?` },
		})
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
		// Rejected before any Slack API call.
		expect(calls()).toBe(0)
	})

	test("bot-authored replies (no self-triggering loop)", async () => {
		const { deps, calls } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { bot_id: "B999" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
		expect(calls()).toBe(0)
	})

	test("top-level channel messages (not a thread reply)", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const noThread = envelope({ event: { thread_ts: undefined } })
		expect(await promoteThreadFollowUp(noThread, deps)).toBeNull()
		const rootOfThread = envelope({
			event: { ts: "1700000000.000100", thread_ts: "1700000000.000100" },
		})
		expect(await promoteThreadFollowUp(rootOfThread, deps)).toBeNull()
	})

	test("DMs (eve dispatches those on its own)", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { channel_type: "im" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("edits and other subtypes", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { subtype: "message_changed" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("non-message events", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ event: { type: "reaction_added" } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("envelope without authorizations (bot user unknown)", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = envelope({ envelope: { authorizations: undefined } })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})

	test("interaction form posts / non-JSON bodies", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		expect(await promoteThreadFollowUp("payload=%7B%7D", deps)).toBeNull()
	})

	test("url_verification and other envelope types", async () => {
		const { deps } = makeDeps(ENGAGED_THREAD)
		const body = JSON.stringify({ type: "url_verification", challenge: "x" })
		expect(await promoteThreadFollowUp(body, deps)).toBeNull()
	})
})

// ── fetch bounds ────────────────────────────────────────────────────────────

// `conversations.replies` returns the OLDEST page first. Without oldest/latest
// bounds, a thread past 100 replies has its "trailing window" computed over the
// oldest page: fresh engagements invisible, stale ones passing recency.

describe("thread fetch bounds", () => {
	test("the fetch is bounded to the recency horizon ending at the reply", async () => {
		let received: Parameters<ThreadFollowUpDeps["fetchThreadReplies"]>[0] | undefined
		const deps: ThreadFollowUpDeps = {
			resolveBotToken: async () => "xoxb-test",
			fetchThreadReplies: async (options) => {
				received = options
				return ENGAGED_THREAD
			},
		}
		expect(await promoteThreadFollowUp(envelope({}), deps)).not.toBeNull()
		// 30 minutes (ENGAGEMENT_MAX_AGE_SECONDS) before the incoming reply's ts.
		expect(received?.oldest).toBe(String(Number("1700000002.000200") - 30 * 60))
		expect(received?.latest).toBe("1700000002.000200")
		expect(received?.signal).toBeInstanceOf(AbortSignal)
	})

	test("the Slack request itself carries oldest/latest/inclusive", async () => {
		const stub = installFetchStub(() => Response.json({ ok: true, messages: [] }))
		try {
			await fetchThreadRepliesFromSlack({
				botToken: "xoxb-test",
				channelId: "C123",
				threadTs: "1700000000.000100",
				oldest: "1699998202.0002",
				latest: "1700000002.000200",
				signal: AbortSignal.timeout(1_000),
			})
			expect(stub.calls.length).toBe(1)
			const params = new URLSearchParams(String(stub.calls[0]?.body))
			expect(params.get("channel")).toBe("C123")
			expect(params.get("ts")).toBe("1700000000.000100")
			expect(params.get("oldest")).toBe("1699998202.0002")
			expect(params.get("latest")).toBe("1700000002.000200")
			expect(params.get("inclusive")).toBe("true")
		} finally {
			stub.restore()
		}
	})
})

// ── promotion deadline ──────────────────────────────────────────────────────

// The whole promotion side-trip (workspace resolve + thread fetch) shares one
// deadline inside Slack's ~3s webhook budget; expiry falls through unpromoted.

describe("promotion deadline", () => {
	test("a slow workspace resolve falls through unpromoted at the deadline", async () => {
		let fetchCalls = 0
		const deps: ThreadFollowUpDeps = {
			resolveBotToken: () =>
				new Promise((resolve) => setTimeout(() => resolve("xoxb-test"), 200)),
			fetchThreadReplies: async () => {
				fetchCalls += 1
				return ENGAGED_THREAD
			},
			promotionDeadlineMs: 20,
		}
		expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull()
		expect(fetchCalls).toBe(0)

		// Expiry cached nothing: the thread's next reply retries and promotes.
		const { deps: freshDeps } = makeDeps(ENGAGED_THREAD)
		expect(await promoteThreadFollowUp(envelope({}), freshDeps)).not.toBeNull()
	})

	test("a slow thread fetch falls through unpromoted at the deadline", async () => {
		const deps: ThreadFollowUpDeps = {
			resolveBotToken: async () => "xoxb-test",
			fetchThreadReplies: () =>
				new Promise((resolve) => setTimeout(() => resolve(ENGAGED_THREAD), 200)),
			promotionDeadlineMs: 20,
		}
		expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull()
	})
})

// ── caching ─────────────────────────────────────────────────────────────────

describe("engagement cache", () => {
	test("second follow-up in the same thread skips the Slack API call", async () => {
		const { deps, calls } = makeDeps(ENGAGED_THREAD)
		await promoteThreadFollowUp(envelope({}), deps)
		const second = envelope({ event: { ts: "1700000003.000300" } })
		expect(await promoteThreadFollowUp(second, deps)).not.toBeNull()
		expect(calls()).toBe(1)
	})

	test("threads are cached independently", async () => {
		const { deps, calls } = makeDeps(ENGAGED_THREAD)
		await promoteThreadFollowUp(envelope({}), deps)
		const otherThread = envelope({
			event: { thread_ts: "1700000010.000100", ts: "1700000011.000200" },
		})
		await promoteThreadFollowUp(otherThread, deps)
		expect(calls()).toBe(2)
	})

	test("a second NON-engaged reply is served from the negative cache", async () => {
		const { deps, calls } = makeDeps(UNRELATED_THREAD)
		setSystemTime(new Date("2026-07-21T12:00:00Z"))

		expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull()
		expect(calls()).toBe(1)

		// Still inside the 20s negative TTL: no second round-trip to Slack, which
		// is what keeps a busy channel the bot was never in from costing an API
		// call per message.
		setSystemTime(new Date("2026-07-21T12:00:19Z"))
		const second = envelope({ event: { ts: "1700000003.000300" } })
		expect(await promoteThreadFollowUp(second, deps)).toBeNull()
		expect(calls()).toBe(1)
	})

	test("the negative cache expires so a thread the bot just joined is picked up", async () => {
		const { deps, calls } = makeDeps(UNRELATED_THREAD)
		setSystemTime(new Date("2026-07-21T12:00:00Z"))
		await promoteThreadFollowUp(envelope({}), deps)

		setSystemTime(new Date("2026-07-21T12:00:21Z"))
		await promoteThreadFollowUp(envelope({ event: { ts: "1700000004.000400" } }), deps)
		expect(calls()).toBe(2)
	})

	test("the cache key includes the team: one workspace cannot answer for another", async () => {
		// Slack channel ids are only unique per workspace, and this cache is
		// process-global across every tenant that installed the app.
		let call = 0
		const deps = {
			resolveBotToken: async () => "xoxb-test",
			fetchThreadReplies: async () => {
				call += 1
				return call === 1 ? ENGAGED_THREAD : UNRELATED_THREAD
			},
		}

		expect(await promoteThreadFollowUp(envelope({}), deps)).not.toBeNull()
		// Same channel + thread ids, different workspace: must be resolved on its
		// own, and must not inherit the first team's engagement.
		const otherTeam = envelope({ envelope: { team_id: "T999" } })
		expect(await promoteThreadFollowUp(otherTeam, deps)).toBeNull()
		expect(call).toBe(2)
	})
})
