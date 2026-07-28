import { afterEach, describe, expect, mock, test } from "bun:test"
import {
	ACK_REACTION_NAME,
	ALLOWED_REACTION_EMOJIS,
	clearAckedTriggeringMessages,
	lookupAckedTriggeringMessage,
	reactToTriggeringMessage,
	registerAckedTriggeringMessage,
	type ReactionDeps,
	type SlackReactionCall,
} from "./reaction.js"

afterEach(() => {
	clearAckedTriggeringMessages()
})

const session = (attributes: Record<string, unknown>) => ({ id: "session-1", attributes })

const makeDeps = (overrides: Partial<ReactionDeps> = {}) => {
	const added: SlackReactionCall[] = []
	const removed: SlackReactionCall[] = []
	const deps: ReactionDeps = {
		resolveBotToken: () => Promise.resolve("xoxb-test"),
		addReaction: (options) => {
			added.push(options)
			return Promise.resolve()
		},
		removeReaction: (options) => {
			removed.push(options)
			return Promise.resolve()
		},
		lookupAckedMessage: lookupAckedTriggeringMessage,
		...overrides,
	}
	return { deps, added, removed }
}

describe("the allowlist", () => {
	test("never contains the ack emoji", () => {
		expect(ALLOWED_REACTION_EMOJIS).not.toContain(ACK_REACTION_NAME)
	})
})

describe("triggering-message registry", () => {
	test("a top-level message is found under its own ts as the thread key", () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.1" })
		expect(lookupAckedTriggeringMessage({ teamId: "T1", channelId: "C1", threadTs: "100.1" })).toBe("100.1")
	})

	test("a thread follow-up is found under the thread root, resolving to its own ts", () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.2", threadTs: "100.1" })
		expect(lookupAckedTriggeringMessage({ teamId: "T1", channelId: "C1", threadTs: "100.1" })).toBe("100.2")
	})

	test("workspaces do not collide", () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.1" })
		expect(lookupAckedTriggeringMessage({ teamId: "T2", channelId: "C1", threadTs: "100.1" })).toBeUndefined()
	})

	test("lookup without a thread finds nothing", () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.1" })
		expect(lookupAckedTriggeringMessage({ teamId: "T1", channelId: "C1" })).toBeUndefined()
	})
})

describe("reactToTriggeringMessage", () => {
	test("reacts to the registered triggering message and removes the ack", async () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.2", threadTs: "100.1" })
		const { deps, added, removed } = makeDeps()

		const result = await reactToTriggeringMessage(
			"raised_hands",
			session({ team_id: "T1", channel_id: "C1", thread_ts: "100.1" }),
			deps,
		)

		expect(result.reacted).toBe(true)
		expect(added).toEqual([{ botToken: "xoxb-test", channelId: "C1", timestamp: "100.2", name: "raised_hands" }])
		expect(removed).toEqual([
			{ botToken: "xoxb-test", channelId: "C1", timestamp: "100.2", name: ACK_REACTION_NAME },
		])
	})

	test("degrades to the thread root on a registry miss", async () => {
		const { deps, added } = makeDeps()

		const result = await reactToTriggeringMessage(
			"fire",
			session({ team_id: "T1", channel_id: "C1", thread_ts: "100.1" }),
			deps,
		)

		expect(result.reacted).toBe(true)
		expect(added).toEqual([{ botToken: "xoxb-test", channelId: "C1", timestamp: "100.1", name: "fire" }])
	})

	test("skips without a channel", async () => {
		const { deps, added } = makeDeps()
		const result = await reactToTriggeringMessage("fire", session({ thread_ts: "100.1" }), deps)
		expect(result.reacted).toBe(false)
		expect(added).toEqual([])
	})

	test("skips when neither registry nor thread identify a message", async () => {
		const { deps, added } = makeDeps()
		const result = await reactToTriggeringMessage("fire", session({ channel_id: "C1" }), deps)
		expect(result.reacted).toBe(false)
		expect(added).toEqual([])
	})

	test("a failed add returns reacted:false and never throws", async () => {
		const { deps } = makeDeps({ addReaction: mock(() => Promise.reject(new Error("boom"))) })
		const result = await reactToTriggeringMessage(
			"fire",
			session({ team_id: "T1", channel_id: "C1", thread_ts: "100.1" }),
			deps,
		)
		expect(result.reacted).toBe(false)
	})

	test("a failed ack removal is tolerated — the new reaction already landed", async () => {
		registerAckedTriggeringMessage({ teamId: "T1", channelId: "C1", messageTs: "100.1" })
		const { deps, added } = makeDeps({ removeReaction: mock(() => Promise.reject(new Error("no_reaction"))) })
		const result = await reactToTriggeringMessage(
			"tada",
			session({ team_id: "T1", channel_id: "C1", thread_ts: "100.1" }),
			deps,
		)
		expect(result.reacted).toBe(true)
		expect(added).toHaveLength(1)
	})
})
