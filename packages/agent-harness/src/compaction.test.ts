import { describe, expect, test } from "vitest"
import { applyCompaction, prepareCompaction } from "./compaction"
import { buildSessionContext, createEmptySnapshot, estimateTextTokens } from "./session-context"
import type { SessionEntry, SessionSnapshot } from "./types"

const messageEntry = (
	snapshot: SessionSnapshot,
	turnId: string,
	id: string,
	role: "user" | "assistant",
	text: string,
): SessionEntry => ({
	id,
	createdAt: 1,
	turnId,
	type: "message",
	message: {
		role,
		content: [{ type: "text", text }],
	},
	estimatedTokens: estimateTextTokens(text),
})

describe("agent harness compaction", () => {
	test("buildSessionContext prepends the latest compaction summary", () => {
		const snapshot = createEmptySnapshot("session-1")
		const withMessages: SessionSnapshot = {
			...snapshot,
			entries: [
				...snapshot.entries,
				messageEntry(snapshot, "turn-1", "user-1", "user", "Investigate latency regression"),
				messageEntry(snapshot, "turn-1", "assistant-1", "assistant", "Looking at service latency"),
				{
					id: "compaction-1",
					createdAt: 2,
					turnId: "turn-2",
					type: "compaction",
					summary: "The user is debugging latency in checkout.",
					firstKeptEntryId: "assistant-1",
					tokensBefore: 10_000,
					details: {},
				},
			],
		}

		const context = buildSessionContext(withMessages)
		expect(context[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: expect.stringContaining("Conversation summary") }],
		})
		expect(context.at(-1)).toMatchObject({
			role: "assistant",
		})
	})

	test("prepareCompaction keeps recent entries and split-turn context separate", () => {
		const snapshot = createEmptySnapshot("session-2")
		const entries: ReadonlyArray<SessionEntry> = [
			...snapshot.entries,
			messageEntry(snapshot, "turn-1", "user-1", "user", "older context ".repeat(1_000)),
			messageEntry(snapshot, "turn-1", "assistant-1", "assistant", "older answer ".repeat(1_000)),
			messageEntry(snapshot, "turn-2", "user-2", "user", "new question ".repeat(600)),
			messageEntry(snapshot, "turn-2", "assistant-2", "assistant", "new answer ".repeat(600)),
		]

		const prepared = prepareCompaction(
			{
				...snapshot,
				entries,
				compaction: {
					enabled: true,
					reserveTokens: 1_000,
					keepRecentTokens: 5_000,
				},
			},
			8_000,
		)

		expect(prepared).toBeDefined()
		expect(prepared?.droppedEntries.length).toBeGreaterThan(0)
		expect(prepared?.keptEntries.length).toBeGreaterThan(0)
	})

	test("applyCompaction carries forward dropped entry ids and split-turn details", () => {
		const snapshot = createEmptySnapshot("session-3")
		const prepared = prepareCompaction(
			{
				...snapshot,
				entries: [
					...snapshot.entries,
					messageEntry(snapshot, "turn-1", "user-1", "user", "older context ".repeat(1_200)),
					messageEntry(snapshot, "turn-2", "assistant-2", "assistant", "keep me ".repeat(1_000)),
				],
				compaction: {
					enabled: true,
					reserveTokens: 100,
					keepRecentTokens: 100,
				},
			},
			1_000,
		)

		expect(prepared).toBeDefined()
		const result = applyCompaction(snapshot, "turn-3", prepared!, {
			summary: "Compressed older context",
			turnContextSummary: "Split turn preserved",
		})

		expect(result.entry.details.droppedEntryIds).toContain("user-1")
		expect(result.entry.turnContextSummary).toBe("Split turn preserved")
	})
})
