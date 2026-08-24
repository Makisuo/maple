import { describe, expect, it } from "vitest"

import { spanAttributeEntries, spanMessages, spanToolCalls } from "./span-detail"
import { llmSpan, toolSpan } from "./span-test-support"

describe("spanMessages", () => {
	it("reads the documented shape: system instructions, then input, then output", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				systemInstructions: [{ type: "text", content: "you are terse" }],
				inputMessages: [
					{ role: "user", parts: [{ type: "text", content: "fix the retry backoff" }] },
				],
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{ type: "text", content: "reading the handler first" },
							{
								type: "tool_call",
								id: "toolu_01",
								name: "read_file",
								arguments: { path: "src/retry.ts" },
							},
						],
					},
				],
			},
		})

		const messages = spanMessages(span)
		expect(messages.map((message) => [message.origin, message.role])).toEqual([
			["system", "system"],
			["input", "user"],
			["output", "assistant"],
		])
		expect(messages[1]!.parts).toEqual([{ kind: "text", text: "fix the retry backoff" }])
		expect(messages[2]!.parts[1]).toEqual({
			kind: "tool_call",
			id: "toolu_01",
			name: "read_file",
			argumentsText: '{"path":"src/retry.ts"}',
		})
	})

	it("keeps vendor variants readable: bare strings and content keys", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				systemInstructions: "one line of instructions",
				inputMessages: [
					{ role: "user", content: "a bare content string" },
					{ role: "assistant", content: [{ type: "text", text: "a text key" }] },
				],
			},
		})

		const messages = spanMessages(span)
		expect(messages[0]!.parts).toEqual([{ kind: "text", text: "one line of instructions" }])
		expect(messages[1]!.parts).toEqual([{ kind: "text", text: "a bare content string" }])
		expect(messages[2]!.parts).toEqual([{ kind: "text", text: "a text key" }])
	})

	// A payload the reader cannot see is worse than one that is ugly.
	it("keeps a shape it does not know as raw JSON rather than dropping it", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				inputMessages: [{ role: "user", parts: [{ type: "image", media: "…" }] }],
			},
		})

		expect(spanMessages(span)[0]!.parts).toEqual([{ kind: "text", text: '{"type":"image","media":"…"}' }])
	})

	it("captures nothing when nothing was captured — the ordinary case", () => {
		const span = llmSpan({ spanId: "l1", startMs: 0, durationMs: 1000 })
		expect(spanMessages(span)).toEqual([])
	})
})

describe("spanToolCalls", () => {
	it("reads a tool span's own gen_ai.tool.* attributes as one call", () => {
		const span = toolSpan({
			spanId: "t1",
			startMs: 0,
			durationMs: 1000,
			toolName: "read_file",
			genAi: {
				toolCallId: "toolu_01",
				toolCallArguments: { path: "src/retry.ts" },
				toolCallResult: "120 lines",
			},
		})

		expect(spanToolCalls(span)).toEqual([
			{
				name: "read_file",
				id: "toolu_01",
				description: undefined,
				argumentsText: '{"path":"src/retry.ts"}',
				resultText: "120 lines",
			},
		])
	})

	it("reads the tool_call parts of the output this call produced, not the history", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				// History: a tool call an earlier span already made and reported.
				inputMessages: [
					{
						role: "assistant",
						parts: [{ type: "tool_call", id: "toolu_00", name: "grep_repo", arguments: {} }],
					},
				],
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{
								type: "tool_call",
								id: "toolu_01",
								name: "read_file",
								arguments: { path: "a" },
							},
						],
					},
				],
			},
		})

		const calls = spanToolCalls(span)
		expect(calls).toHaveLength(1)
		expect(calls[0]!.id).toBe("toolu_01")
	})
})

describe("spanAttributeEntries", () => {
	it("lists the present fields under their semconv keys and nothing else", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			model: "claude-opus-5",
			genAi: { usageInputTokens: 1200, requestStream: true },
		})

		const entries = spanAttributeEntries(span)
		const byKey = new Map(entries.map((entry) => [entry.key, entry.value]))
		expect(byKey.get("gen_ai.operation.name")).toBe("chat")
		expect(byKey.get("gen_ai.response.model")).toBe("claude-opus-5")
		expect(byKey.get("gen_ai.usage.input_tokens")).toBe("1200")
		expect(byKey.get("gen_ai.request.stream")).toBe("true")
		expect(byKey.has("gen_ai.usage.output_tokens")).toBe(false)
	})
})
