import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "./span-fixtures"
import { buildSessionTurns, classifySpan, firstUserMessageText, isLlmCall, spanTtftMs } from "./session-turns"

const SECOND = 1000

describe("buildSessionTurns", () => {
	it("groups by gen_ai.conversation.id, in first-start order", () => {
		const turns = buildSessionTurns([
			llmSpan({
				spanId: "b",
				startMs: 30 * SECOND,
				durationMs: SECOND,
				genAi: { conversationId: "t2" },
			}),
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, genAi: { conversationId: "t1" } }),
			llmSpan({
				spanId: "c",
				startMs: 40 * SECOND,
				durationMs: SECOND,
				genAi: { conversationId: "t2" },
			}),
		])

		expect(turns.map((turn) => turn.index)).toEqual([1, 2])
		expect(turns[0]!.anchorKind).toBe("conversation")
		expect(turns[0]!.spans.map((span) => span.spanId)).toEqual(["a"])
		expect(turns[1]!.spans.map((span) => span.spanId)).toEqual(["b", "c"])
	})

	it("puts a span with no conversation id in the turn that was open when it started", () => {
		const turns = buildSessionTurns([
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, genAi: { conversationId: "t1" } }),
			// No conversation id of its own — a tool the framework did not tag.
			toolSpan({ spanId: "untagged", startMs: 35 * SECOND, durationMs: SECOND }),
			llmSpan({
				spanId: "b",
				startMs: 30 * SECOND,
				durationMs: SECOND,
				genAi: { conversationId: "t2" },
			}),
		])

		expect(turns[1]!.spans.map((span) => span.spanId)).toEqual(["b", "untagged"])
	})

	it("keeps spans that start before the first anchor in turn 1", () => {
		const turns = buildSessionTurns([
			// The gateway span opens the trace before the agent is invoked.
			makeSpan({ spanId: "http", startMs: 0, durationMs: 5 * SECOND, isAiSpan: false }),
			agentSpan({ spanId: "agent", startMs: 2 * SECOND, durationMs: 20 * SECOND }),
		])

		expect(turns).toHaveLength(1)
		expect(turns[0]!.spans.map((span) => span.spanId)).toEqual(["http", "agent"])
	})

	it("ignores a conversation id that only names the session", () => {
		// Six vendors derive the session id FROM the conversation id, so every span
		// carries the same value and it partitions nothing.
		const turns = buildSessionTurns([
			agentSpan({
				spanId: "agent-1",
				startMs: 0,
				durationMs: 10 * SECOND,
				sessionId: "sess-1",
				genAi: { operationName: "invoke_agent", conversationId: "sess-1" },
			}),
			agentSpan({
				spanId: "agent-2",
				startMs: 60 * SECOND,
				durationMs: 10 * SECOND,
				sessionId: "sess-1",
				genAi: { operationName: "invoke_agent", conversationId: "sess-1" },
			}),
		])

		expect(turns.map((turn) => turn.anchorKind)).toEqual(["agent-root", "agent-root"])
	})

	it("does not partition on a conversation id the whole session shares", () => {
		const turns = buildSessionTurns([
			agentSpan({
				spanId: "agent-1",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { operationName: "invoke_agent", conversationId: "conv-1" },
			}),
			agentSpan({
				spanId: "agent-2",
				startMs: 60 * SECOND,
				durationMs: 10 * SECOND,
				genAi: { operationName: "invoke_agent", conversationId: "conv-1" },
			}),
		])

		expect(turns.map((turn) => turn.anchorKind)).toEqual(["agent-root", "agent-root"])
	})

	it("opens a turn at agent work under the app's own spans", () => {
		// What production actually looks like: the query returns the app's spans,
		// so the trace root is an HTTP handler and no agent span is ever parentless.
		const turns = buildSessionTurns([
			makeSpan({ spanId: "route-1", startMs: 0, durationMs: 30 * SECOND, isAiSpan: false }),
			agentSpan({
				spanId: "agent-1",
				parentSpanId: "route-1",
				startMs: SECOND,
				durationMs: 20 * SECOND,
			}),
			makeSpan({ spanId: "route-2", startMs: 60 * SECOND, durationMs: 30 * SECOND, isAiSpan: false }),
			agentSpan({
				spanId: "agent-2",
				parentSpanId: "route-2",
				startMs: 61 * SECOND,
				durationMs: 20 * SECOND,
			}),
		])

		expect(turns.map((turn) => turn.anchorKind)).toEqual(["agent-root", "agent-root"])
		// Assignment is by time, so the second route span — which opened before the
		// agent it invokes — closes turn 1 rather than opening turn 2.
		expect(turns[0]!.spans.map((span) => span.spanId)).toEqual(["route-1", "agent-1", "route-2"])
		expect(turns[1]!.spans.map((span) => span.spanId)).toEqual(["agent-2"])
	})

	it("never emits a turn with no spans in it", () => {
		// Two anchors in the same millisecond: the earlier one's bucket is empty,
		// and a turn measured over no spans starts at Infinity.
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent-1", traceId: "trace-1", startMs: 0, durationMs: 10 * SECOND }),
			agentSpan({ spanId: "agent-2", traceId: "trace-2", startMs: 0, durationMs: 10 * SECOND }),
		])

		expect(turns.every((turn) => turn.spans.length > 0)).toBe(true)
		expect(turns.map((turn) => turn.index)).toEqual([1])
		expect(Number.isFinite(turns[0]!.startMs)).toBe(true)
	})

	it("falls back to root agent invocations when no conversation id exists", () => {
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "llm-1", parentSpanId: "agent-1", startMs: SECOND, durationMs: 2 * SECOND }),
			agentSpan({ spanId: "agent-2", startMs: 60 * SECOND, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "llm-2", parentSpanId: "agent-2", startMs: 61 * SECOND, durationMs: SECOND }),
		])

		expect(turns.map((turn) => turn.anchorKind)).toEqual(["agent-root", "agent-root"])
		expect(turns[0]!.spans.map((span) => span.spanId)).toEqual(["agent-1", "llm-1"])
		expect(turns[1]!.spans.map((span) => span.spanId)).toEqual(["agent-2", "llm-2"])
	})

	it("does not treat a nested agent span as a turn boundary", () => {
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 30 * SECOND }),
			// A delegated subagent: its parent is inside the session, so it is work
			// within the turn, not a new one.
			agentSpan({
				spanId: "subagent",
				parentSpanId: "agent-1",
				startMs: 5 * SECOND,
				durationMs: 10 * SECOND,
				agentName: "test-runner",
			}),
		])

		expect(turns).toHaveLength(1)
		expect(turns[0]!.spans).toHaveLength(2)
	})

	it("falls back to one turn per trace when nothing marks a boundary", () => {
		const turns = buildSessionTurns([
			llmSpan({ spanId: "a", traceId: "trace-1", startMs: 0, durationMs: SECOND }),
			llmSpan({ spanId: "b", traceId: "trace-2", startMs: 60 * SECOND, durationMs: SECOND }),
		])

		expect(turns.map((turn) => turn.anchorKind)).toEqual(["trace", "trace"])
		expect(turns.map((turn) => turn.traceIds)).toEqual([["trace-1"], ["trace-2"]])
	})

	it("lets one turn span several traces", () => {
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent", traceId: "trace-1", startMs: 0, durationMs: 30 * SECOND }),
			// The tool worker is a separate service and starts its own trace.
			toolSpan({ spanId: "tool", traceId: "trace-2", startMs: 5 * SECOND, durationMs: SECOND }),
		])

		expect(turns).toHaveLength(1)
		expect(turns[0]!.traceIds).toEqual(["trace-1", "trace-2"])
	})

	it("measures a turn from its first span's start to its last span's end", () => {
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			// Outlives its parent — a background tool the agent did not await.
			toolSpan({ spanId: "tool", parentSpanId: "agent", startMs: 5 * SECOND, durationMs: 20 * SECOND }),
		])

		expect(turns[0]!.durationMs).toBe(25 * SECOND)
	})

	it("takes its label from the first captured user message", () => {
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { inputMessages: userMessages("fix the webhook retry backoff") },
			}),
		])

		expect(turns[0]!.label).toBe("fix the webhook retry backoff")
		expect(turns[0]!.agentName).toBe("billing-agent")
	})

	it("has no label when message content was not captured", () => {
		const turns = buildSessionTurns([agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND })])

		expect(turns[0]!.label).toBeUndefined()
	})

	it("fails a turn whose root span errored, but not one that only errored inside", () => {
		const [failedTurn] = buildSessionTurns([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND, statusCode: "Error" }),
		])
		const [retriedTurn] = buildSessionTurns([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			// A rate-limited attempt that the agent retried successfully.
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
			}),
		])

		expect(failedTurn!.failed).toBe(true)
		expect(retriedTurn!.failed).toBe(false)
	})

	it("returns nothing for a session with no spans", () => {
		expect(buildSessionTurns([])).toEqual([])
	})
})

describe("classifySpan", () => {
	it("reads gen_ai.operation.name when it is there", () => {
		expect(classifySpan(llmSpan({ spanId: "a", startMs: 0, durationMs: 1 }))).toBe("inference")
		expect(classifySpan(toolSpan({ spanId: "b", startMs: 0, durationMs: 1 }))).toBe("tool")
		expect(classifySpan(agentSpan({ spanId: "c", startMs: 0, durationMs: 1 }))).toBe("agent")
	})

	it("accepts operation names outside the documented set", () => {
		const vercelStep = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "agent_step" },
		})

		expect(classifySpan(vercelStep)).toBe("agent")
	})

	it("falls back to the span name when the operation is not recorded", () => {
		const named = (spanName: string) =>
			classifySpan(makeSpan({ spanId: "a", startMs: 0, durationMs: 1, spanName }))

		expect(named("ai.toolCall")).toBe("tool")
		expect(named("workflow.run")).toBe("agent")
		expect(named("chat gpt-5")).toBe("inference")
	})

	it("classifies a span with no AI signal as other, whatever it is called", () => {
		const httpSpan = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			spanName: "POST /v1/agent/chat",
			isAiSpan: false,
		})

		expect(classifySpan(httpSpan)).toBe("other")
	})
})

describe("isLlmCall", () => {
	it("counts chat-shaped operations", () => {
		expect(isLlmCall(llmSpan({ spanId: "a", startMs: 0, durationMs: 1 }))).toBe(true)
	})

	it("agrees with classifySpan on an operation name outside the documented set", () => {
		const openSet = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "generate_text", responseModel: "gpt-5" },
		})

		expect(classifySpan(openSet)).toBe("inference")
		expect(isLlmCall(openSet)).toBe(true)
	})

	it("does not count embeddings, which are inference but not a model turn", () => {
		const embedding = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "embeddings" },
		})

		expect(classifySpan(embedding)).toBe("inference")
		expect(isLlmCall(embedding)).toBe(false)
	})
})

describe("spanTtftMs", () => {
	it("converts the seconds the convention records into milliseconds", () => {
		const span = llmSpan({ spanId: "a", startMs: 0, durationMs: 8000, ttftSeconds: 1.4 })

		expect(spanTtftMs(span)).toBe(1400)
	})

	it("ignores a value longer than the span it belongs to", () => {
		const span = llmSpan({ spanId: "a", startMs: 0, durationMs: 800, ttftSeconds: 1.4 })

		expect(spanTtftMs(span)).toBeUndefined()
	})

	it("is absent when the vendor did not report it", () => {
		expect(spanTtftMs(llmSpan({ spanId: "a", startMs: 0, durationMs: 800 }))).toBeUndefined()
	})
})

describe("firstUserMessageText", () => {
	it("reads the user's text out of an OTel messages array", () => {
		expect(firstUserMessageText(userMessages("hello"))).toBe("hello")
	})

	it("accepts content as a bare string", () => {
		expect(firstUserMessageText([{ role: "user", content: "just run the whole suite" }])).toBe(
			"just run the whole suite",
		)
	})

	it("collapses whitespace and elides a very long message", () => {
		expect(firstUserMessageText([{ role: "user", content: "  two   words  " }])).toBe("two words")

		const long = firstUserMessageText([{ role: "user", content: "x".repeat(500) }])
		expect(long).toHaveLength(80)
		expect(long?.endsWith("…")).toBe(true)
	})

	it("drops the pseudo-XML context frameworks inject, keeping the prose", () => {
		const withContext = [
			{
				role: "user",
				content:
					"<current_time>2026-08-19T10:33:25Z</current_time>\n" +
					"<slack_channel_context>\nchannel: #eng\nuser: U123\n</slack_channel_context>\n" +
					"fix the webhook retry backoff",
			},
		]

		expect(firstUserMessageText(withContext)).toBe("fix the webhook retry backoff")
	})

	it("has no label when the message is only injected context", () => {
		expect(
			firstUserMessageText([
				{ role: "user", content: "<current_time>2026-08-19T10:33:25Z</current_time>" },
			]),
		).toBeUndefined()
		// The block left open — its contents are metadata either way.
		expect(
			firstUserMessageText([{ role: "user", content: "<slack_channel_context>\nchannel: #eng" }]),
		).toBeUndefined()
	})

	it("gives up rather than guessing on a shape it does not recognize", () => {
		expect(firstUserMessageText(undefined)).toBeUndefined()
		expect(firstUserMessageText("a plain string")).toBeUndefined()
		expect(firstUserMessageText([{ role: "assistant", content: "hi" }])).toBeUndefined()
		expect(firstUserMessageText([{ role: "user", content: [{ type: "image" }] }])).toBeUndefined()
	})
})
