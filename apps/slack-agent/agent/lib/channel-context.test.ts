import { afterEach, describe, expect, mock, test } from "bun:test"
import {
	CHANNEL_CONTEXT_MAX_MESSAGES,
	CHANNEL_CONTEXT_MESSAGE_COUNT,
	fetchChannelHistoryFromSlack,
	loadChannelContext,
	readChannelHistory,
	SlackHistoryError,
	type ChannelContextDeps,
	type FetchChannelHistoryOptions,
} from "./channel-context.js"
import { installFetchStub, type FetchStub } from "./fetch-stub.js"
import { clearAckedTriggeringMessages, registerAckedTriggeringMessage } from "./reaction.js"
import type { RenderableSlackMessage } from "./slack-context-format.js"

const BOT_USER_ID = "UBOT"

afterEach(() => {
	clearAckedTriggeringMessages()
})

/**
 * A Maple alert card as `conversations.history` returns it: no top-level text,
 * Block Kit inside one colored attachment. Mirrors
 * apps/api/src/services/alerts/AlertDeliveryDispatch.ts.
 */
const alertHistoryMessage = (ts: string): Record<string, unknown> => ({
	ts,
	user: BOT_USER_ID,
	bot_id: "B1",
	text: "",
	attachments: [
		{
			color: "#e11d48",
			fallback: "🚨 Kafka consumer lag > 1h (sustained) — Triggered",
			blocks: [
				{
					type: "header",
					text: { type: "plain_text", text: "🚨 Kafka consumer lag > 1h (sustained) — Triggered" },
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*builder_query* is *3685.79* — above the 3600 threshold.",
					},
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Open in Maple" },
							url: "https://app.maple.dev/alerts/incidents/inc_1",
						},
					],
				},
			],
		},
	],
})

const userHistoryMessage = (text: string, ts: string): Record<string, unknown> => ({ ts, user: "U1", text })

/** The mapping `fetchChannelHistoryFromSlack` applies, for the dep-injected tests. */
const mapped = (raw: Record<string, unknown>): RenderableSlackMessage => ({
	text: typeof raw.text === "string" ? raw.text : undefined,
	user: typeof raw.user === "string" ? raw.user : undefined,
	botId: typeof raw.bot_id === "string" ? raw.bot_id : undefined,
	ts: typeof raw.ts === "string" ? raw.ts : undefined,
	threadTs: typeof raw.thread_ts === "string" ? raw.thread_ts : undefined,
	raw,
})

const makeDeps = (
	messages: readonly Record<string, unknown>[],
	overrides: Partial<ChannelContextDeps> = {},
) => {
	const fetches: FetchChannelHistoryOptions[] = []
	const deps: ChannelContextDeps = {
		resolveBotToken: () => Promise.resolve("xoxb-test"),
		fetchChannelHistory: (options) => {
			fetches.push(options)
			// Oldest-first, as the real fetch returns after its reverse().
			return Promise.resolve(messages.map(mapped))
		},
		botUserIdForTeam: () => BOT_USER_ID,
		lookupAckedMessage: () => undefined,
		...overrides,
	}
	return { deps, fetches }
}

const mention = (overrides: Partial<Parameters<typeof loadChannelContext>[0]> = {}) => ({
	channelId: "C1",
	teamId: "T1",
	ts: "1700000000.000900",
	threadTs: "1700000000.000900",
	...overrides,
})

describe("loadChannelContext", () => {
	test("renders the channel messages that preceded a threadless mention", async () => {
		const { deps, fetches } = makeDeps([
			alertHistoryMessage("1700000000.000700"),
			userHistoryMessage("who is on call?", "1700000000.000800"),
		])

		const context = await loadChannelContext(mention(), deps)

		expect(context).toHaveLength(1)
		expect(context[0]?.startsWith("<slack_channel_context>")).toBe(true)
		expect(context[0]?.endsWith("</slack_channel_context>")).toBe(true)
		// The alert card is the whole point: it has no `text` at all.
		expect(context[0]).toContain("🚨 Kafka consumer lag > 1h (sustained) — Triggered")
		expect(context[0]).toContain("Open in Maple: https://app.maple.dev/alerts/incidents/inc_1")
		expect(context[0]).toContain("who is on call?")
		// The card came through the bot user, but it is not something the agent said.
		expect(context[0]?.match(/sender_type: (\w+)/gu)).toEqual(["sender_type: bot", "sender_type: user"])
		expect(fetches).toEqual([
			{
				botToken: "xoxb-test",
				channelId: "C1",
				latest: "1700000000.000900",
				limit: CHANNEL_CONTEXT_MESSAGE_COUNT,
				signal: expect.any(AbortSignal),
			},
		])
	})

	test("adds nothing for a mention inside a thread — that is thread context's job", async () => {
		const { deps, fetches } = makeDeps([userHistoryMessage("noise", "1700000000.000800")])

		const context = await loadChannelContext(
			mention({ ts: "1700000000.000900", threadTs: "1700000000.000100" }),
			deps,
		)

		expect(context).toEqual([])
		expect(fetches).toEqual([])
	})

	test("adds nothing when the channel has no earlier messages", async () => {
		const { deps } = makeDeps([])
		expect(await loadChannelContext(mention(), deps)).toEqual([])
	})

	test("degrades to no context when Slack fails, so the turn still dispatches", async () => {
		const { deps } = makeDeps([], {
			fetchChannelHistory: mock(() => Promise.reject(new SlackHistoryError("not_in_channel"))),
		})
		expect(await loadChannelContext(mention(), deps)).toEqual([])
	})

	test("clips a single over-long message instead of paying for it every turn", async () => {
		const { deps } = makeDeps([userHistoryMessage("x".repeat(5_000), "1700000000.000800")])
		const context = await loadChannelContext(mention(), deps)
		expect(context[0]).toContain("[truncated]")
		expect(context[0]?.length).toBeLessThan(3_000)
	})
})

describe("readChannelHistory", () => {
	const session = (attributes: Record<string, unknown>) => ({ id: "session-1", attributes })

	test("reads back from the triggering message the ack registered", async () => {
		registerAckedTriggeringMessage({
			teamId: "T1",
			channelId: "C1",
			messageTs: "1700000000.000950",
			threadTs: "1700000000.000100",
		})
		const { deps, fetches } = makeDeps([alertHistoryMessage("1700000000.000700")], {
			lookupAckedMessage: (context) =>
				context.threadTs === "1700000000.000100" ? "1700000000.000950" : undefined,
		})

		const result = await readChannelHistory(
			3,
			session({ team_id: "T1", channel_id: "C1", thread_ts: "1700000000.000100" }),
			deps,
		)

		expect(result).toMatchObject({ read: true, messageCount: 1 })
		expect(fetches[0]?.latest).toBe("1700000000.000950")
		expect(fetches[0]?.limit).toBe(3)
	})

	test("falls back to the thread root when the registry has nothing", async () => {
		const { deps, fetches } = makeDeps([userHistoryMessage("deploy went out", "1700000000.000700")])

		const result = await readChannelHistory(
			CHANNEL_CONTEXT_MESSAGE_COUNT,
			session({ team_id: "T1", channel_id: "C1", thread_ts: "1700000000.000900" }),
			deps,
		)

		expect(result.read).toBe(true)
		expect(fetches[0]?.latest).toBe("1700000000.000900")
	})

	test("bounds the limit to what Slack will actually return", async () => {
		const { deps, fetches } = makeDeps([userHistoryMessage("hi", "1700000000.000700")])
		const attributes = { team_id: "T1", channel_id: "C1", thread_ts: "1700000000.000900" }

		await readChannelHistory(500, session(attributes), deps)
		await readChannelHistory(0, session(attributes), deps)

		expect(fetches.map((call) => call.limit)).toEqual([CHANNEL_CONTEXT_MAX_MESSAGES, 1])
	})

	test("explains a missing scope instead of leaving the model to retry", async () => {
		const { deps } = makeDeps([], {
			fetchChannelHistory: mock(() => Promise.reject(new SlackHistoryError("missing_scope"))),
		})

		const result = await readChannelHistory(
			CHANNEL_CONTEXT_MESSAGE_COUNT,
			session({ team_id: "T1", channel_id: "C1", thread_ts: "1700000000.000900" }),
			deps,
		)

		expect(result.read).toBe(false)
		const note = result.read ? "" : result.note
		expect(note).toContain("missing scope")
		expect(note).toContain("Do not retry")
	})

	test("says so plainly when the channel had nothing before this message", async () => {
		const { deps } = makeDeps([])
		const result = await readChannelHistory(
			CHANNEL_CONTEXT_MESSAGE_COUNT,
			session({ team_id: "T1", channel_id: "C1", thread_ts: "1700000000.000900" }),
			deps,
		)
		expect(result).toMatchObject({ read: false, note: expect.stringContaining("Nothing was posted") })
	})

	test("skips without a channel, and without a message to read back from", async () => {
		const { deps, fetches } = makeDeps([])
		expect(await readChannelHistory(5, session({ team_id: "T1" }), deps)).toMatchObject({ read: false })
		expect(await readChannelHistory(5, session({ team_id: "T1", channel_id: "C1" }), deps)).toMatchObject(
			{ read: false },
		)
		expect(fetches).toEqual([])
	})
})

describe("fetchChannelHistoryFromSlack", () => {
	let stub: FetchStub | undefined

	afterEach(() => {
		stub?.restore()
		stub = undefined
	})

	const respondWith = (payload: unknown, status = 200) => {
		stub = installFetchStub(() => new Response(JSON.stringify(payload), { status }))
		return stub
	}

	test("asks Slack for the messages before the triggering one, form-encoded", async () => {
		const fetchStub = respondWith({ ok: true, messages: [] })

		await fetchChannelHistoryFromSlack({
			botToken: "xoxb-test",
			channelId: "C1",
			latest: "1700000000.000900",
			limit: 5,
		})

		const call = fetchStub.calls[0]
		expect(call?.url).toBe("https://slack.com/api/conversations.history")
		expect(call?.method).toBe("POST")
		expect(call?.headers.authorization).toBe("Bearer xoxb-test")
		const body = new URLSearchParams(String(call?.body))
		expect(body.get("channel")).toBe("C1")
		expect(body.get("latest")).toBe("1700000000.000900")
		// The message the agent is answering must not be read back to it.
		expect(body.get("inclusive")).toBe("false")
		expect(body.get("limit")).toBe("5")
	})

	test("returns Slack's newest-first page in the order it happened", async () => {
		respondWith({
			ok: true,
			messages: [
				userHistoryMessage("second", "1700000000.000800"),
				{ ...alertHistoryMessage("1700000000.000700"), thread_ts: "1700000000.000700" },
			],
		})

		const messages = await fetchChannelHistoryFromSlack({
			botToken: "xoxb-test",
			channelId: "C1",
			latest: "1700000000.000900",
			limit: 5,
		})

		expect(messages.map((message) => message.ts)).toEqual(["1700000000.000700", "1700000000.000800"])
		expect(messages[0]).toMatchObject({
			user: BOT_USER_ID,
			botId: "B1",
			// A thread_ts on a channel message means the discussion continued in a
			// thread the model cannot see from here.
			threadTs: "1700000000.000700",
		})
	})

	test("surfaces Slack's error code so the caller can explain it", async () => {
		respondWith({ ok: false, error: "missing_scope" })
		expect(
			fetchChannelHistoryFromSlack({ botToken: "t", channelId: "C1", latest: "1", limit: 5 }),
		).rejects.toMatchObject({ code: "missing_scope" })
	})

	test("surfaces a transport failure as a code too", async () => {
		respondWith({}, 503)
		expect(
			fetchChannelHistoryFromSlack({ botToken: "t", channelId: "C1", latest: "1", limit: 5 }),
		).rejects.toMatchObject({ code: "http_503" })
	})
})
