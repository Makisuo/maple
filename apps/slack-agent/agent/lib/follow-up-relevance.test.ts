import { describe, expect, test } from "bun:test"
import type { SlackThreadMessage } from "eve/channels/slack"
import {
	judgeFollowUpRelevance,
	parseRelevanceVerdict,
	relevancePrompt,
	relevanceSystemPrompt,
	type FollowUpRelevanceInput,
} from "./follow-up-relevance.js"

const BOT_USER_ID = "U0BOT"

const threadMessage = (overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage => ({
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

const input = (overrides: Partial<FollowUpRelevanceInput> = {}): FollowUpRelevanceInput => ({
	reply: {
		text: "can you check the api service too?",
		markdown: "can you check the api service too?",
		user: "U456",
		ts: "1700000002.000200",
		threadTs: "1700000000.000100",
		raw: {},
	},
	threadMessages: [
		threadMessage({ text: "why did this alert fire?", markdown: "why did this alert fire?", user: "U456" }),
		threadMessage({
			text: "The error rate on checkout spiked at 14:10.",
			markdown: "The error rate on checkout spiked at 14:10.",
			user: BOT_USER_ID,
			ts: "1700000001.000100",
		}),
	],
	botUserId: BOT_USER_ID,
	...overrides,
})

describe("parseRelevanceVerdict", () => {
	test("plain verdicts, any case", () => {
		expect(parseRelevanceVerdict("RESPOND")).toBe("respond")
		expect(parseRelevanceVerdict("pass")).toBe("pass")
		expect(parseRelevanceVerdict("  Pass.\n")).toBe("pass")
	})

	test("verdict wrapped in prose still parses", () => {
		expect(parseRelevanceVerdict("The user is talking to a teammate, so: PASS")).toBe("pass")
	})

	test("no verdict, or both words, is no answer", () => {
		expect(parseRelevanceVerdict("")).toBeNull()
		expect(parseRelevanceVerdict("maybe?")).toBeNull()
		expect(parseRelevanceVerdict("RESPOND or PASS, hard to say")).toBeNull()
	})

	test("substrings do not count as verdicts", () => {
		expect(parseRelevanceVerdict("the password expired")).toBeNull()
		expect(parseRelevanceVerdict("correspondence")).toBeNull()
	})
})

describe("relevancePrompt", () => {
	test("carries the thread tail and the reply", () => {
		const prompt = relevancePrompt(input())
		expect(prompt).toContain("why did this alert fire?")
		expect(prompt).toContain("can you check the api service too?")
		expect(prompt).toContain("Newest message:")
		// The bot's own post is attributed as the agent, other bots are not.
		expect(prompt).toContain("sender_type: agent")
	})

	test("says so when the thread was unreadable vs merely empty", () => {
		expect(relevancePrompt(input({ threadMessages: null }))).toContain("could not be loaded")
		expect(relevancePrompt(input({ threadMessages: [] }))).toContain("No earlier thread messages")
	})

	test("system prompt names the bot's user id", () => {
		expect(relevanceSystemPrompt(BOT_USER_ID)).toContain(`<@${BOT_USER_ID}>`)
	})

	test("system prompt classifies criticism of the bot's output as RESPOND", () => {
		// Regression: a jokey complaint about a chart the bot had posted was
		// dropped as banter; criticism must be called out on both sides of the
		// verdict, not left to the tiebreak.
		const system = relevanceSystemPrompt(BOT_USER_ID)
		expect(system).toContain("criticism of its output")
		expect(system).toContain("Do not file criticism")
	})
})

describe("judgeFollowUpRelevance", () => {
	test("model RESPOND answers the follow-up", async () => {
		const decision = await judgeFollowUpRelevance(input(), { complete: async () => "RESPOND" })
		expect(decision).toEqual({ respond: true, reason: "model-respond" })
	})

	test("model PASS drops it", async () => {
		const decision = await judgeFollowUpRelevance(input(), { complete: async () => "PASS" })
		expect(decision).toEqual({ respond: false, reason: "model-pass" })
	})

	test("a throwing classifier fails open", async () => {
		const decision = await judgeFollowUpRelevance(input(), {
			complete: async () => {
				throw new Error("openrouter down")
			},
		})
		expect(decision).toEqual({ respond: true, reason: "classifier-error" })
	})

	test("an unparseable verdict fails open", async () => {
		const decision = await judgeFollowUpRelevance(input(), { complete: async () => "hmm, unclear" })
		expect(decision).toEqual({ respond: true, reason: "unparseable-verdict" })
	})

	test("the classifier sees the reply it is judging", async () => {
		let seen: { system: string; prompt: string } | undefined
		await judgeFollowUpRelevance(input(), {
			complete: async ({ system, prompt }) => {
				seen = { system, prompt }
				return "PASS"
			},
		})
		expect(seen?.prompt).toContain("can you check the api service too?")
		expect(seen?.system).toContain("RESPOND or PASS")
	})
})
