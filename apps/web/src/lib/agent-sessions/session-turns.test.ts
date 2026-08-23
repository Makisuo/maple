import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "./span-test-support"
import { buildSessionTurns, classifyAiSpan, isLlmCall, spanTtftMs } from "./session-turns"

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

	it("takes its label from a captured user message", () => {
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

	it("labels each turn with its own prompt, not the history's first one", () => {
		// A chat-shaped span carries the WHOLE conversation, so turn 2's messages
		// open with turn 1's prompt.
		const turns = buildSessionTurns([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent-1",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { inputMessages: userMessages("fix the webhook retry backoff") },
			}),
			agentSpan({ spanId: "agent-2", startMs: 60 * SECOND, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "llm-2",
				parentSpanId: "agent-2",
				startMs: 61 * SECOND,
				durationMs: SECOND,
				genAi: {
					inputMessages: userMessages("fix the webhook retry backoff", "now add a test for it"),
				},
			}),
		])

		expect(turns.map((turn) => turn.label)).toEqual([
			"fix the webhook retry backoff",
			"now add a test for it",
		])
	})

	it("prefers the anchor's own messages over a descendant's history", () => {
		const turns = buildSessionTurns([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { operationName: "invoke_agent", inputMessages: userMessages("deploy the worker") },
			}),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { inputMessages: userMessages("something the model was handed later") },
			}),
		])

		expect(turns[0]!.label).toBe("deploy the worker")
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

	it("does not fail a turn on the app's own errored span", () => {
		// The query returns the app's HTTP/DB spans too; a 5xx on the gateway that
		// carried the request is not the agent failing.
		const [turn] = buildSessionTurns([
			agentSpan({ spanId: "agent", startMs: SECOND, durationMs: 10 * SECOND }),
			makeSpan({
				spanId: "route",
				startMs: 0,
				durationMs: 12 * SECOND,
				isAiSpan: false,
				statusCode: "Error",
			}),
		])

		expect(turn!.failed).toBe(false)
	})

	it("returns nothing for a session with no spans", () => {
		expect(buildSessionTurns([])).toEqual([])
	})
})

describe("classifyAiSpan", () => {
	it("reads gen_ai.operation.name when it is there", () => {
		expect(classifyAiSpan(llmSpan({ spanId: "a", startMs: 0, durationMs: 1 }))).toBe("inference")
		expect(classifyAiSpan(toolSpan({ spanId: "b", startMs: 0, durationMs: 1 }))).toBe("tool")
		expect(classifyAiSpan(agentSpan({ spanId: "c", startMs: 0, durationMs: 1 }))).toBe("agent")
	})

	it("accepts operation names outside the documented set", () => {
		const vercelStep = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "agent_step" },
		})

		expect(classifyAiSpan(vercelStep)).toBe("agent")
	})

	it("falls back to the span name when the operation is not recorded", () => {
		// A name-only AI span is one the ingest gateway stamped from its scope: a
		// vendor id, no decoded gen_ai attributes.
		const named = (spanName: string) =>
			classifyAiSpan(
				makeSpan({ spanId: "a", startMs: 0, durationMs: 1, spanName, vendorId: "vercel_ai_sdk" }),
			)

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

		expect(classifyAiSpan(httpSpan)).toBe("other")
	})
})

describe("isLlmCall", () => {
	it("counts chat-shaped operations", () => {
		expect(isLlmCall(llmSpan({ spanId: "a", startMs: 0, durationMs: 1 }))).toBe(true)
	})

	it("agrees with classifyAiSpan on an operation name outside the documented set", () => {
		const openSet = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "generate_text", responseModel: "gpt-5" },
		})

		expect(classifyAiSpan(openSet)).toBe("inference")
		expect(isLlmCall(openSet)).toBe(true)
	})

	it("does not count embeddings, which are inference but not a model turn", () => {
		const embedding = makeSpan({
			spanId: "a",
			startMs: 0,
			durationMs: 1,
			genAi: { operationName: "embeddings" },
		})

		expect(classifyAiSpan(embedding)).toBe("inference")
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

describe("turn labels", () => {
	const labelFor = (inputMessages: unknown) =>
		buildSessionTurns([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { operationName: "invoke_agent", inputMessages },
			}),
		])[0]!.label

	it("reads the user's text out of an OTel messages array", () => {
		expect(labelFor(userMessages("hello"))).toBe("hello")
	})

	it("accepts content as a bare string", () => {
		expect(labelFor([{ role: "user", content: "just run the whole suite" }])).toBe(
			"just run the whole suite",
		)
	})

	it("keeps the first line, collapses whitespace and elides a very long message", () => {
		expect(labelFor([{ role: "user", content: "  two   words  " }])).toBe("two words")
		expect(labelFor([{ role: "user", content: "first line\nsecond line" }])).toBe("first line")

		const long = labelFor([{ role: "user", content: "x".repeat(500) }])
		expect(long).toHaveLength(80)
		expect(long?.endsWith("…")).toBe(true)
	})

	it("gives up rather than guessing on a shape it does not recognize", () => {
		expect(labelFor(undefined)).toBeUndefined()
		expect(labelFor("a plain string")).toBeUndefined()
		expect(labelFor([{ role: "assistant", content: "hi" }])).toBeUndefined()
		expect(labelFor([{ role: "user", content: [{ type: "image" }] }])).toBeUndefined()
	})
})
