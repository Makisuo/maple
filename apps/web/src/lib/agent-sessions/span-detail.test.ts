import { describe, expect, it } from "vitest"

import { sessionToolResults, spanMessages, spanToolCalls, toolResultFor } from "./span-detail"
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

	// Reasoning read as assistant prose is the worst kind of wrong: it puts words
	// in the model's mouth that it never said to the user.
	it("reads reasoning parts as reasoning, in all three vendor spellings", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				outputMessages: [
					{
						role: "assistant",
						parts: [
							{ type: "reasoning", content: "semconv spelling" },
							{ type: "thinking", thinking: "anthropic spelling" },
							{ type: "reasoning", text: "the text key" },
							{ type: "redacted_thinking", data: "AAAA…" },
							{ type: "text", content: "the reply" },
						],
					},
				],
			},
		})

		expect(spanMessages(span)[0]!.parts).toEqual([
			{ kind: "reasoning", text: "semconv spelling", redacted: false },
			{ kind: "reasoning", text: "anthropic spelling", redacted: false },
			{ kind: "reasoning", text: "the text key", redacted: false },
			{ kind: "reasoning", text: undefined, redacted: true },
			{ kind: "text", text: "the reply" },
		])
	})

	it("keeps a reasoning part with no text as a labelled part, not raw JSON", () => {
		const span = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				outputMessages: [{ role: "assistant", parts: [{ type: "reasoning", signature: "sig" }] }],
			},
		})

		expect(spanMessages(span)[0]!.parts).toEqual([
			{ kind: "reasoning", text: undefined, redacted: false },
		])
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
				own: true,
			},
		])
	})

	// Only the call a span EXECUTED may be read against that span's status. A
	// model call that died on its own error never learned whether the tools it
	// asked for ran, so its output calls are not its own.
	it("marks the span's own executed call, and only that one", () => {
		const executed = toolSpan({
			spanId: "t2",
			startMs: 0,
			durationMs: 1000,
			toolName: "run_tests",
			genAi: { toolCallId: "toolu_02", toolCallArguments: { suite: "webhooks" } },
		})
		expect(spanToolCalls(executed).map((call) => call.own)).toEqual([true])

		const requested = llmSpan({
			spanId: "l2",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				outputMessages: [
					{
						role: "assistant",
						parts: [{ type: "tool_call", id: "toolu_03", name: "run_tests", arguments: {} }],
					},
				],
			},
		})
		expect(spanToolCalls(requested).map((call) => call.own)).toEqual([false])
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

	// Semconv says `response`; Maple's own emitter writes `result`. Reading only
	// the documented key loses every result this codebase produces.
	it("reads an echoed response under the `result` key too", () => {
		const next = llmSpan({
			spanId: "l1",
			startMs: 0,
			durationMs: 1000,
			genAi: {
				inputMessages: [
					{ role: "tool", parts: [{ type: "tool_call_response", id: "toolu_01", result: "42 rows" }] },
				],
			},
		})

		expect(sessionToolResults([next]).get("toolu_01")).toBe("42 rows")
	})
})

describe("spanMessages — reasoning payloads", () => {
	const reasoningPart = (part: Record<string, unknown>) =>
		spanMessages(
			llmSpan({
				spanId: "l1",
				startMs: 0,
				durationMs: 1000,
				genAi: { outputMessages: [{ role: "assistant", parts: [part] }] },
			}),
		)[0]!.parts[0]

	// A payload the reader cannot see is worse than one that is ugly — and that
	// holds for reasoning too, whatever shape the vendor wrapped it in.
	it("walks a block-array reasoning content down to its text", () => {
		expect(
			reasoningPart({
				type: "reasoning",
				content: [
					{ type: "text", content: "both lanes" },
					{ type: "text", content: "point at carts" },
				],
			}),
		).toStrictEqual({ kind: "reasoning", text: "both lanes\npoint at carts", redacted: false })
	})

	it("keeps an object reasoning payload as its own JSON rather than dropping it", () => {
		expect(reasoningPart({ type: "thinking", thinking: { summary: "carts" } })).toStrictEqual({
			kind: "reasoning",
			text: '{"summary":"carts"}',
			redacted: false,
		})
	})

	it("prefers `text` over `thinking` when a vendor writes both", () => {
		expect(reasoningPart({ type: "thinking", text: "the text key", thinking: "the other" })).toStrictEqual(
			{ kind: "reasoning", text: "the text key", redacted: false },
		)
	})

	it("reports no reasoning text for an empty string", () => {
		expect(reasoningPart({ type: "thinking", thinking: "" })).toStrictEqual({
			kind: "reasoning",
			text: undefined,
			redacted: false,
		})
	})
})

describe("sessionToolResults", () => {
	// An echo carrying neither `response` nor `result` is an echo of the CALL,
	// not of its answer. Registering it would claim the id and block the real one.
	it("does not let an empty echo claim a call id", () => {
		const spans = [
			llmSpan({
				spanId: "l1",
				startMs: 0,
				durationMs: 1000,
				genAi: {
					inputMessages: [
						{ role: "tool", parts: [{ type: "tool_call_response", id: "toolu_1" }] },
					],
				},
			}),
			llmSpan({
				spanId: "l2",
				startMs: 2000,
				durationMs: 1000,
				genAi: {
					inputMessages: [
						{ role: "tool", parts: [{ type: "tool_call_response", id: "toolu_1", result: "62 rows" }] },
					],
				},
			}),
		]
		expect(toolResultFor(sessionToolResults(spans), "trace-1", "toolu_1")).toBe("62 rows")
	})

	// Call ids are unique within a run, not within a session: two lanes both
	// issue `toolu_1`, and each one's own trace has the answer it got.
	it("prefers the calling span's own trace when two traces reuse a call id", () => {
		const spans = [
			toolSpan({
				spanId: "t-a",
				traceId: "trace-a",
				startMs: 0,
				durationMs: 500,
				toolName: "run_sql",
				genAi: { toolCallId: "toolu_1", toolCallResult: "the a answer" },
			}),
			toolSpan({
				spanId: "t-b",
				traceId: "trace-b",
				startMs: 1000,
				durationMs: 500,
				toolName: "run_sql",
				genAi: { toolCallId: "toolu_1", toolCallResult: "the b answer" },
			}),
		]
		const results = sessionToolResults(spans)
		expect(toolResultFor(results, "trace-a", "toolu_1")).toBe("the a answer")
		expect(toolResultFor(results, "trace-b", "toolu_1")).toBe("the b answer")
		// A caller from a third trace still gets the session-wide answer.
		expect(toolResultFor(results, "trace-z", "toolu_1")).toBe("the a answer")
	})
})
