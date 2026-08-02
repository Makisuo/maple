import { describe, expect, it } from "vitest"

import { buildTranscriptRows, isToolOnlyMessage, toolPartsOf } from "./transcript-rows"
import type { UIMessage } from "@/components/ai-elements/types"

const text = (id: string, role: "user" | "assistant", body: string): UIMessage =>
	({ id, role, parts: [{ type: "text", text: body }] }) as unknown as UIMessage

const tools = (id: string, count: number, output: unknown = { ok: true }): UIMessage =>
	({
		id,
		role: "assistant",
		parts: Array.from({ length: count }, (_, i) => ({
			type: "tool-list_services",
			toolCallId: `${id}-${i}`,
			state: "output-available",
			input: { service: "api" },
			output,
		})),
	}) as unknown as UIMessage

const report = {
	summary: "Checkout is degraded",
	suspectedCause: "db pool exhausted",
	severityAssessment: "high",
	affectedScope: "checkout",
	evidence: [],
	suggestedActions: ["Raise the pool size"],
	confidence: "high",
} as const

const kinds = (messages: readonly UIMessage[]) => buildTranscriptRows(messages).map((row) => row.kind)

describe("buildTranscriptRows", () => {
	it("merges a run of adjacent tool-only turns into one row", () => {
		const rows = buildTranscriptRows([tools("m1", 2), tools("m2", 2), tools("m3", 2)])

		expect(rows).toHaveLength(1)
		const row = rows[0]!
		if (row.kind !== "tool-run") throw new Error(`expected a tool-run row, got ${row.kind}`)
		// Addressed by the first message of the run.
		expect(row.id).toBe("m1")
		expect(toolPartsOf(row)).toHaveLength(6)
	})

	it("leaves a lone tool turn as an ordinary message row", () => {
		expect(kinds([tools("m1", 2)])).toEqual(["message"])
	})

	it("treats prose between two bursts as a boundary", () => {
		expect(
			kinds([tools("m1", 1), text("m2", "assistant", "here's what I found"), tools("m3", 1)]),
		).toEqual(["message", "message", "message"])
	})

	it("merges each run independently across a user turn", () => {
		const rows = buildTranscriptRows([
			tools("a1", 1),
			tools("a2", 1),
			text("u", "user", "and now?"),
			tools("b1", 1),
			tools("b2", 1),
		])

		expect(rows.map((row) => [row.kind, row.id])).toEqual([
			["tool-run", "a1"],
			["message", "u"],
			["tool-run", "b1"],
		])
	})

	it("never swallows a turn that carries a card of its own", () => {
		// A diagnosis report is content, not plumbing — it must not disappear into a
		// `Used N tools` header.
		const diagnosis = tools("m2", 1, { status: "diagnosis", report })
		expect(isToolOnlyMessage(diagnosis)).toBe(false)
		expect(kinds([tools("m1", 1), diagnosis, tools("m3", 1)])).toEqual(["message", "message", "message"])
	})

	it("does not merge a still-running burst differently from a settled one", () => {
		const running = {
			id: "m2",
			role: "assistant",
			parts: [{ type: "tool-search_logs", toolCallId: "m2-0", state: "input-available" }],
		} as unknown as UIMessage

		expect(kinds([tools("m1", 1), running])).toEqual(["tool-run"])
	})

	it("keeps user turns and empty assistant turns out of runs", () => {
		const empty = { id: "m2", role: "assistant", parts: [] } as unknown as UIMessage
		expect(isToolOnlyMessage(empty)).toBe(false)
		expect(isToolOnlyMessage(text("u", "user", "hi"))).toBe(false)
	})
})
