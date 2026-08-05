import { afterEach, describe, expect, test } from "bun:test"
import type { SlackThreadMessage } from "eve/channels/slack"
import { botUserIdForTeam, rememberBotUserId, resetBotUserIdCacheForTests } from "./bot-identity.js"
import { slackMessageContent } from "./slack-context-format.js"
import { formatThreadContext, loadThreadContext } from "./thread-context.js"

afterEach(() => {
	resetBotUserIdCacheForTests()
})

const BOT_USER_ID = "UBOT"

const message = (overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage => ({
	text: "",
	markdown: "",
	user: undefined,
	botId: undefined,
	ts: "1700000000.000100",
	threadTs: "1700000000.000100",
	isMe: false,
	raw: {},
	...overrides,
})

const userMessage = (text: string, ts: string): SlackThreadMessage =>
	message({ text, markdown: text, user: "U1", ts, threadTs: "1700000000.000100" })

/**
 * Shape of a Maple alert notification as it comes back from
 * `conversations.replies`: no top-level text, blocks inside one colored
 * attachment. Mirrors apps/api/src/services/alerts/AlertDeliveryDispatch.ts.
 */
const alertMessage = (): SlackThreadMessage =>
	message({
		user: BOT_USER_ID,
		botId: "B1",
		isMe: true,
		raw: {
			attachments: [
				{
					color: "#e11d48",
					fallback: "🚨 checkout p95 — Firing",
					blocks: [
						{
							type: "header",
							text: { type: "plain_text", text: "🚨 checkout p95 — Firing", emoji: true },
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*p95 latency* is *2.4s* — above 1s, measured over the last 5m.",
							},
							fields: [{ type: "mrkdwn", text: "*Severity*\n🔴 Critical" }],
						},
						{
							type: "actions",
							elements: [
								{
									type: "button",
									text: { type: "plain_text", text: "Open in Maple", emoji: true },
									url: "https://app.maple.dev/alerts/incidents/inc_1",
									style: "primary",
								},
							],
						},
						{
							type: "context",
							elements: [{ type: "mrkdwn", text: "🍁 Maple Alerts  ·  Incident `inc_1`" }],
						},
					],
				},
			],
		},
	})

describe("slackMessageContent", () => {
	test("renders a Maple alert card from its attachment blocks", () => {
		const { content, fromAttachment } = slackMessageContent(alertMessage())
		expect(fromAttachment).toBe(true)
		expect(content).toBe(
			[
				"🚨 checkout p95 — Firing",
				"*p95 latency* is *2.4s* — above 1s, measured over the last 5m.",
				"*Severity*\n🔴 Critical",
				"Open in Maple: https://app.maple.dev/alerts/incidents/inc_1",
				"🍁 Maple Alerts  ·  Incident `inc_1`",
			].join("\n"),
		)
	})

	test("prefers plain text over any block rendering of it", () => {
		const { content, fromAttachment } = slackMessageContent(
			message({
				text: "p95 is up",
				markdown: "p95 is up",
				raw: { blocks: [{ type: "section", text: { type: "mrkdwn", text: "p95 is up" } }] },
			}),
		)
		expect(content).toBe("p95 is up")
		expect(fromAttachment).toBe(false)
	})

	test("renders top-level rich_text blocks as paragraphs, not one word per line", () => {
		const { content } = slackMessageContent(
			message({
				raw: {
					blocks: [
						{
							type: "rich_text",
							elements: [
								{
									type: "rich_text_section",
									elements: [
										{ type: "text", text: "see " },
										{
											type: "link",
											url: "https://app.maple.dev/traces/t1",
											text: "this trace",
										},
										{ type: "text", text: " " },
										{ type: "user", user_id: "U2" },
									],
								},
							],
						},
					],
				},
			}),
		)
		expect(content).toBe("see this trace (https://app.maple.dev/traces/t1) <@U2>")
	})

	test("falls back to the attachment fallback line when it carries no blocks", () => {
		const { content, fromAttachment } = slackMessageContent(
			message({ raw: { attachments: [{ fallback: "🚨 checkout p95 — Firing" }] } }),
		)
		expect(content).toBe("🚨 checkout p95 — Firing")
		expect(fromAttachment).toBe(true)
	})

	test("sweeps text out of block types it has no case for", () => {
		const { content } = slackMessageContent(
			message({
				raw: { blocks: [{ type: "some_future_block", body: { type: "mrkdwn", text: "kept" } }] },
			}),
		)
		expect(content).toBe("kept")
	})

	test("is empty rather than throwing on a message with nothing readable", () => {
		expect(slackMessageContent(message({ raw: { blocks: "not-an-array" } })).content).toBe("")
	})
})

describe("formatThreadContext", () => {
	test("returns undefined for an empty thread", () => {
		expect(formatThreadContext([])).toBeUndefined()
	})

	test("attributes an alert card to a bot, not to the agent", () => {
		const rendered = formatThreadContext([alertMessage()], { botUserId: BOT_USER_ID })
		expect(rendered).toContain("sender_type: bot")
		expect(rendered).not.toContain("sender_type: agent")
		expect(rendered).toContain("🚨 checkout p95 — Firing")
	})

	test("keeps the alert and the discussion under it in thread order", () => {
		const rendered = formatThreadContext(
			[
				alertMessage(),
				userMessage("is this the deploy from 10 minutes ago?", "1700000000.000200"),
				message({
					text: "Checking the last release now.",
					markdown: "Checking the last release now.",
					user: BOT_USER_ID,
					botId: "B1",
					isMe: true,
					ts: "1700000000.000300",
					threadTs: "1700000000.000100",
				}),
			],
			{ botUserId: BOT_USER_ID },
		)
		expect(rendered?.startsWith("<slack_thread_context>")).toBe(true)
		expect(rendered?.endsWith("</slack_thread_context>")).toBe(true)
		expect(rendered?.match(/sender_type: (\w+)/gu)).toEqual([
			"sender_type: bot",
			"sender_type: user",
			"sender_type: agent",
		])
	})

	test("labels a third-party bot as a bot, not as the agent", () => {
		const github = message({
			text: "PR #338 merged",
			markdown: "PR #338 merged",
			user: "UGH",
			botId: "B9",
			isMe: true,
		})
		expect(formatThreadContext([github], { botUserId: BOT_USER_ID })).toContain("sender_type: bot")
		// Without a learned bot user id we can only fall back to eve's coarser
		// "any bot is me".
		expect(formatThreadContext([github])).toContain("sender_type: agent")
	})
})

describe("loadThreadContext", () => {
	const thread = (messages: readonly SlackThreadMessage[]) => {
		const recentMessages: SlackThreadMessage[] = []
		return {
			recentMessages,
			refresh: async () => {
				recentMessages.length = 0
				recentMessages.push(...messages)
			},
		}
	}

	test("includes the whole thread before the triggering message", async () => {
		const trigger = userMessage("<@UBOT> why did this fire?", "1700000000.000300")
		const context = await loadThreadContext(
			thread([alertMessage(), userMessage("hm", "1700000000.000200"), trigger]),
			{ threadTs: trigger.threadTs, ts: trigger.ts },
			{ botUserId: BOT_USER_ID },
		)
		expect(context).toHaveLength(1)
		// The alert survives — this is the bug: `since: "last-agent-reply"` used to
		// cut context off after it, leaving the model nothing to answer from.
		expect(context[0]).toContain("🚨 checkout p95 — Firing")
		expect(context[0]).toContain("hm")
		expect(context[0]).not.toContain("why did this fire?")
	})

	test("adds nothing for a thread root", async () => {
		const root = userMessage("<@UBOT> hello", "1700000000.000100")
		expect(await loadThreadContext(thread([root]), { threadTs: root.ts, ts: root.ts })).toEqual([])
	})

	test("degrades to no context when Slack fails, so the turn still dispatches", async () => {
		const failing = {
			recentMessages: [] as SlackThreadMessage[],
			refresh: async () => {
				throw new Error("slack down")
			},
		}
		expect(
			await loadThreadContext(failing, { threadTs: "1700000000.000100", ts: "1700000000.000300" }),
		).toEqual([])
	})
})

describe("bot identity", () => {
	test("learns the bot user id from a webhook envelope, per team", () => {
		rememberBotUserId(
			JSON.stringify({
				type: "event_callback",
				team_id: "T1",
				authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
				event: { type: "app_mention" },
			}),
		)
		expect(botUserIdForTeam("T1")).toBe(BOT_USER_ID)
		expect(botUserIdForTeam("T2")).toBeUndefined()
		expect(botUserIdForTeam(undefined)).toBeUndefined()
	})

	test("ignores bodies it cannot read", () => {
		rememberBotUserId("not json")
		rememberBotUserId(JSON.stringify({ type: "event_callback", team_id: "T1" }))
		expect(botUserIdForTeam("T1")).toBeUndefined()
	})
})
