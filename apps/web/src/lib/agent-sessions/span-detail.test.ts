import { describe, expect, it } from "vitest"

import { sessionToolResults, spanMessages, spanToolCalls } from "./span-detail"
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

	// A model span's output only makes its calls; the responses come back on
	// other spans. Resolving them by id is what lets the Tool calls tab show a
	// call and its result together instead of sending the reader to open each
	// tool span one by one.
	it("fills a call's result from the session index, matched by id", () => {
		const model = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{ type: "tool_call", id: "toolu_01", name: "read_file", arguments: { path: "a" } },
							{ type: "tool_call", id: "toolu_02", name: "run_tests", arguments: {} },
							{ type: "tool_call", id: "toolu_03", name: "grep_repo", arguments: {} },
						],
					},
				],
			},
		})
		const tool = toolSpan({
			spanId: "t1",
			startMs: 1000,
			durationMs: 500,
			toolName: "read_file",
			genAi: { toolCallId: "toolu_01", toolCallResult: "120 lines" },
		})
		// The second result was only echoed into the next call's input history.
		const next = llmSpan({
			spanId: "l2",
			startMs: 2000,
			durationMs: 1000,
			genAi: {
				inputMessages: [
					{
						role: "tool",
						parts: [{ type: "tool_call_response", id: "toolu_02", response: "exit 0" }],
					},
				],
			},
		})

		const results = sessionToolResults([model, tool, next])
		const calls = spanToolCalls(model, results)

		expect(calls.map((call) => [call.id, call.resultText])).toEqual([
			["toolu_01", "120 lines"],
			["toolu_02", "exit 0"],
			// Nothing in the session carries this one's response, so none is shown.
			["toolu_03", undefined],
		])
	})

	it("prefers the tool span's first-hand result over the echoed history", () => {
		const tool = toolSpan({
			spanId: "t1",
			startMs: 0,
			durationMs: 500,
			toolName: "read_file",
			genAi: { toolCallId: "toolu_01", toolCallResult: "first-hand" },
		})
		const next = llmSpan({
			spanId: "l2",
			startMs: 1000,
			durationMs: 1000,
			genAi: {
				inputMessages: [
					{
						role: "tool",
						parts: [{ type: "tool_call_response", id: "toolu_01", response: "echoed" }],
					},
				],
			},
		})

		expect(sessionToolResults([tool, next]).get("toolu_01")).toBe("first-hand")
	})
})
