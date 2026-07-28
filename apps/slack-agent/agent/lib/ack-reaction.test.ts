import { describe, expect, mock, test } from "bun:test"
import { acknowledgeIncomingMessage, parseAckReactionTarget, type AckReactionDeps } from "./ack-reaction.js"

const mentionBody = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		team_id: "T1",
		type: "event_callback",
		event: {
			type: "app_mention",
			channel: "C1",
			ts: "1700000000.000100",
			user: "U1",
			text: "<@UBOT> hello",
			...overrides,
		},
	})

const dmBody = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		team_id: "T1",
		type: "event_callback",
		event: {
			type: "message",
			channel_type: "im",
			channel: "D1",
			ts: "1700000000.000200",
			user: "U1",
			text: "hello",
			...overrides,
		},
	})

describe("parseAckReactionTarget", () => {
	test("targets an app_mention", () => {
		expect(parseAckReactionTarget(mentionBody())).toEqual({
			teamId: "T1",
			channelId: "C1",
			messageTs: "1700000000.000100",
		})
	})

	test("targets a user-authored DM", () => {
		expect(parseAckReactionTarget(dmBody())).toEqual({
			teamId: "T1",
			channelId: "D1",
			messageTs: "1700000000.000200",
		})
	})

	test("targets a DM file_share (mirrors eve's DM filter)", () => {
		expect(parseAckReactionTarget(dmBody({ subtype: "file_share" }))).not.toBeNull()
	})

	test("ignores bot-authored DMs", () => {
		expect(parseAckReactionTarget(dmBody({ bot_id: "B1" }))).toBeNull()
	})

	test("ignores DM subtypes eve drops (message_changed)", () => {
		expect(parseAckReactionTarget(dmBody({ subtype: "message_changed" }))).toBeNull()
	})

	test("ignores plain channel messages (the un-promoted follow-up twin)", () => {
		expect(parseAckReactionTarget(dmBody({ channel_type: "channel" }))).toBeNull()
	})

	test("ignores non-dispatching event types", () => {
		const body = JSON.stringify({
			team_id: "T1",
			type: "event_callback",
			event: { type: "reaction_added", channel: "C1", ts: "1.2" },
		})
		expect(parseAckReactionTarget(body)).toBeNull()
	})

	test("ignores the url_verification handshake", () => {
		expect(parseAckReactionTarget(JSON.stringify({ type: "url_verification", challenge: "x" }))).toBeNull()
	})

	test("ignores malformed JSON", () => {
		expect(parseAckReactionTarget("{not json")).toBeNull()
	})

	test("ignores events missing channel or ts", () => {
		expect(parseAckReactionTarget(mentionBody({ channel: undefined }))).toBeNull()
		expect(parseAckReactionTarget(mentionBody({ ts: undefined }))).toBeNull()
	})
})

describe("acknowledgeIncomingMessage", () => {
	test("adds the eyes reaction with the workspace's bot token", async () => {
		const addReactionCalls: unknown[] = []
		const deps: AckReactionDeps = {
			resolveBotToken: mock((context: { teamId?: string }) => {
				expect(context.teamId).toBe("T1")
				return Promise.resolve("xoxb-1")
			}),
			addReaction: (options) => {
				addReactionCalls.push(options)
				return Promise.resolve()
			},
		}
		await acknowledgeIncomingMessage(mentionBody(), deps)
		expect(addReactionCalls).toEqual([
			{
				botToken: "xoxb-1",
				channelId: "C1",
				timestamp: "1700000000.000100",
				name: "eyes",
			},
		])
	})

	test("does nothing for a non-dispatching body", async () => {
		const addReactionCalls: unknown[] = []
		const deps: AckReactionDeps = {
			resolveBotToken: mock(() => Promise.resolve("xoxb-1")),
			addReaction: (options) => {
				addReactionCalls.push(options)
				return Promise.resolve()
			},
		}
		await acknowledgeIncomingMessage(JSON.stringify({ type: "url_verification" }), deps)
		expect(addReactionCalls).toEqual([])
	})

	test("never throws when the Slack call fails", async () => {
		const deps: AckReactionDeps = {
			resolveBotToken: mock(() => Promise.resolve("xoxb-1")),
			addReaction: mock(() => Promise.reject(new Error("boom"))),
		}
		await expect(acknowledgeIncomingMessage(mentionBody(), deps)).resolves.toBeUndefined()
	})

	test("never throws when token resolution fails", async () => {
		const deps: AckReactionDeps = {
			resolveBotToken: mock(() => Promise.reject(new Error("no workspace"))),
			addReaction: mock(() => Promise.resolve()),
		}
		await expect(acknowledgeIncomingMessage(mentionBody(), deps)).resolves.toBeUndefined()
	})
})
