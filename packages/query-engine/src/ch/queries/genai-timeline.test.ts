import { describe, expect, it } from "@effect/vitest"
import { buildJourneyTimeline, parseGenAiMessages } from "./genai-timeline"
import type { JourneyTimelineOutput } from "./genai"

// ---------------------------------------------------------------------------
// Fixture helpers — a span row as the warehouse returns it.
// ---------------------------------------------------------------------------

const EMPTY: JourneyTimelineOutput = {
	journeyId: "conv_1",
	traceId: "trace_1",
	spanId: "span_1",
	parentSpanId: "",
	timestamp: "2026-08-05 10:00:00",
	durationMs: 1000,
	spanName: "chat gpt-4o",
	serviceName: "agent-service",
	statusCode: "Unset",
	statusMessage: "",
	operation: "chat",
	provider: "openai",
	requestModel: "gpt-4o",
	responseModel: "gpt-4o-2024-11-20",
	servedModel: "gpt-4o-2024-11-20",
	inputTokens: 100,
	outputTokens: 20,
	cachedInputTokens: 0,
	reasoningTokens: 0,
	cost: 0,
	costRaw: "",
	finishReason: "stop",
	agentName: "",
	agentId: "",
	workflowName: "",
	conversationId: "conv_1",
	sessionId: "",
	toolName: "",
	toolCallId: "",
	toolType: "",
	toolArguments: "",
	toolResult: "",
	inputMessages: "",
	outputMessages: "",
	systemInstructions: "",
	contentEventCount: 0,
}

const span = (over: Partial<JourneyTimelineOutput>): JourneyTimelineOutput => ({ ...EMPTY, ...over })

const text = (role: string, content: string) => JSON.stringify([{ role, parts: [{ type: "text", content }] }])

/** One inference span of a cumulative multi-turn conversation. */
const turn = (index: number, priorTurns: ReadonlyArray<[string, string]>, user: string, reply: string) =>
	span({
		spanId: `span_${index}`,
		traceId: `trace_${index}`,
		timestamp: `2026-08-05 10:0${index}:00`,
		// The whole prior conversation, as every chat-completion API requires.
		inputMessages: JSON.stringify([
			...priorTurns.flatMap(([u, a]) => [
				{ role: "user", parts: [{ type: "text", content: u }] },
				{ role: "assistant", parts: [{ type: "text", content: a }] },
			]),
			{ role: "user", parts: [{ type: "text", content: user }] },
		]),
		outputMessages: text("assistant", reply),
	})

describe("parseGenAiMessages", () => {
	it("reads the semconv parts shape, the OpenAI content shape, and a bare string", () => {
		expect(parseGenAiMessages(text("user", "hi"), "user")[0]!.text).toBe("hi")
		expect(parseGenAiMessages(JSON.stringify([{ role: "user", content: "hi" }]), "user")[0]!.text).toBe(
			"hi",
		)
		expect(
			parseGenAiMessages(
				JSON.stringify([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]),
				"assistant",
			)[0]!.text,
		).toBe("hi")
	})

	// Losing a transcript to a parse error is strictly worse than showing it:
	// the legacy `gen_ai.prompt` key is often a bare, unquoted string.
	it("keeps unparseable content as one message rather than dropping it", () => {
		const parsed = parseGenAiMessages("just a prompt", "user")
		expect(parsed).toHaveLength(1)
		expect(parsed[0]).toMatchObject({ role: "user", text: "just a prompt" })
	})

	it("normalizes provider role spellings", () => {
		expect(parseGenAiMessages(text("model", "hi"), "assistant")[0]!.role).toBe("assistant")
		expect(parseGenAiMessages(text("human", "hi"), "user")[0]!.role).toBe("user")
	})
})

describe("cumulative input dedupe", () => {
	// THE trap. Each inference span's input.messages repeats the entire prior
	// conversation, so rendering every span verbatim gives N² duplication.
	it("emits each turn exactly once across a multi-turn journey", () => {
		const events = buildJourneyTimeline([
			turn(1, [], "what is otel?", "a tracing standard"),
			turn(2, [["what is otel?", "a tracing standard"]], "and spans?", "units of work"),
			turn(
				3,
				[
					["what is otel?", "a tracing standard"],
					["and spans?", "units of work"],
				],
				"thanks",
				"anytime",
			),
		])
		const messages = events.filter((e) => e.kind === "message")
		expect(messages.map((m) => [m.role, m.content])).toEqual([
			["user", "what is otel?"],
			["assistant", "a tracing standard"],
			["user", "and spans?"],
			["assistant", "units of work"],
			["user", "thanks"],
			["assistant", "anytime"],
		])
	})

	// A plain "have I seen this text" set would collapse two identical replies
	// into one; the prefix walk keeps both.
	it("keeps repeated identical turns", () => {
		const events = buildJourneyTimeline([turn(1, [], "yes", "ok"), turn(2, [["yes", "ok"]], "yes", "ok")])
		expect(events.filter((e) => e.kind === "message" && e.content === "yes")).toHaveLength(2)
	})

	// Context compaction rewrites history, so the next span's input shares no
	// prefix with what we already emitted. Re-emitting the conversation would
	// double the transcript; the set fallback catches it.
	it("does not replay the conversation when the emitter compacts history", () => {
		const events = buildJourneyTimeline([
			turn(1, [], "first", "one"),
			turn(2, [["first", "one"]], "second", "two"),
			span({
				spanId: "span_3",
				timestamp: "2026-08-05 10:03:00",
				// Summarized history: the original turns are gone, "second"/"two" remain.
				inputMessages: JSON.stringify([
					{ role: "system", parts: [{ type: "text", content: "summary of earlier turns" }] },
					{ role: "user", parts: [{ type: "text", content: "second" }] },
					{ role: "assistant", parts: [{ type: "text", content: "two" }] },
					{ role: "user", parts: [{ type: "text", content: "third" }] },
				]),
				outputMessages: text("assistant", "three"),
			}),
		])
		const contents = events.filter((e) => e.kind === "message").map((e) => e.content)
		expect(contents.filter((c) => c === "second")).toHaveLength(1)
		expect(contents).toContain("summary of earlier turns")
		expect(contents).toContain("third")
	})

	// Metrics belong to the span, not to each message reconstructed from its
	// cumulative input — otherwise summing a column multiplies the bill.
	it("attaches span metrics to one event per span", () => {
		const events = buildJourneyTimeline([turn(1, [], "hi", "hello")])
		const withTokens = events.filter((e) => e.outputTokens !== null)
		expect(withTokens).toHaveLength(1)
		expect(withTokens[0]!.role).toBe("assistant")
	})
})

// ---------------------------------------------------------------------------
// Cumulative history that carries TOOL traffic.
//
// This is what a real agentic loop looks like, and it is the case the plain
// text fingerprint cannot see: the repeated messages are an assistant turn
// whose only content is a tool_call (no text at all) and the tool result that
// answered it. Both fall through to the serialized-form fingerprint, which is
// where key ordering starts to matter.
// ---------------------------------------------------------------------------

const toolCallMessage = {
	role: "assistant",
	parts: [{ type: "tool_call", id: "call_a", name: "search_docs", arguments: { q: "otel" } }],
}
const toolResultMessage = {
	role: "tool",
	tool_call_id: "call_a",
	parts: [{ type: "text", content: "3 documents" }],
}

describe("cumulative dedupe with tool traffic", () => {
	// Turn 1 asks, the model calls a tool, the tool answers, the model replies.
	// Turn 2's input repeats all four of those before the new question.
	const loopSpans = [
		span({
			spanId: "span_1",
			traceId: "trace_1",
			inputMessages: JSON.stringify([
				{ role: "user", parts: [{ type: "text", content: "find docs" }] },
			]),
			outputMessages: JSON.stringify([toolCallMessage]),
		}),
		span({
			spanId: "span_2",
			parentSpanId: "span_1",
			timestamp: "2026-08-05 10:00:05",
			operation: "execute_tool",
			toolName: "search_docs",
			toolCallId: "call_a",
		}),
		span({
			spanId: "span_3",
			traceId: "trace_1",
			timestamp: "2026-08-05 10:00:10",
			inputMessages: JSON.stringify([
				{ role: "user", parts: [{ type: "text", content: "find docs" }] },
				toolCallMessage,
				toolResultMessage,
			]),
			outputMessages: text("assistant", "here they are"),
		}),
		span({
			spanId: "span_4",
			traceId: "trace_2",
			timestamp: "2026-08-05 10:01:00",
			inputMessages: JSON.stringify([
				{ role: "user", parts: [{ type: "text", content: "find docs" }] },
				toolCallMessage,
				toolResultMessage,
				{ role: "assistant", parts: [{ type: "text", content: "here they are" }] },
				{ role: "user", parts: [{ type: "text", content: "any more?" }] },
			]),
			outputMessages: text("assistant", "that is all"),
		}),
	]

	it("emits the tool-call and tool-result turns exactly once each", () => {
		const events = buildJourneyTimeline(loopSpans)
		const messages = events.filter((e) => e.kind === "message")
		expect(messages.map((m) => [m.role, m.content])).toEqual([
			["user", "find docs"],
			// The tool_call-only assistant turn: no text, so no content.
			["assistant", null],
			["tool", "3 documents"],
			["assistant", "here they are"],
			["user", "any more?"],
			["assistant", "that is all"],
		])
	})

	// The tool span must nest under the ORIGINAL assistant message, not a
	// duplicate re-emitted from a later span's cumulative input.
	it("keeps the tool call parented to the first emission of its message", () => {
		const events = buildJourneyTimeline(loopSpans)
		const toolEvent = events.find((e) => e.kind === "toolCall")!
		const owner = events.find((e) => e.id === toolEvent.parentEventId)!
		expect(owner.spanId).toBe("span_1")
	})

	// The fingerprint for a text-less message is its serialized form, and
	// `JSON.stringify` preserves key insertion order — so an emitter that
	// re-serializes history with the keys in a different order (a different SDK
	// version, a proxy, a language whose maps don't preserve order) would
	// otherwise re-emit the entire conversation and re-parent the tool calls.
	it("dedupes across a re-serialization that reorders keys", () => {
		const reordered = {
			parts: [{ arguments: { q: "otel" }, name: "search_docs", type: "tool_call", id: "call_a" }],
			role: "assistant",
		}
		const events = buildJourneyTimeline([
			loopSpans[0]!,
			loopSpans[1]!,
			span({
				spanId: "span_3",
				timestamp: "2026-08-05 10:00:10",
				inputMessages: JSON.stringify([
					{ role: "user", parts: [{ type: "text", content: "find docs" }] },
					reordered,
					{
						tool_call_id: "call_a",
						parts: [{ content: "3 documents", type: "text" }],
						role: "tool",
					},
				]),
				outputMessages: text("assistant", "here they are"),
			}),
		])
		const messages = events.filter((e) => e.kind === "message")
		// Six would mean the reordered copies were treated as new messages.
		expect(messages).toHaveLength(4)
		expect(events.find((e) => e.kind === "toolCall")!.parentEventId).toBe(
			messages.find((m) => m.spanId === "span_1" && m.role === "assistant")!.id,
		)
	})
})

describe("tool calls", () => {
	const assistantWithTools = span({
		spanId: "span_1",
		outputMessages: JSON.stringify([
			{
				role: "assistant",
				parts: [
					{ type: "tool_call", id: "call_a", name: "search_docs" },
					{ type: "tool_call", id: "call_b", name: "run_query" },
					{ type: "text", content: "looking that up" },
				],
			},
		]),
	})

	// Tool calls are sibling spans, not fields; the design nests them under the
	// message that fired them.
	it("nests tool spans under the assistant message by call id", () => {
		const events = buildJourneyTimeline([
			assistantWithTools,
			span({
				spanId: "span_2",
				parentSpanId: "span_1",
				operation: "execute_tool",
				toolName: "search_docs",
				toolCallId: "call_a",
			}),
			span({
				spanId: "span_3",
				parentSpanId: "span_1",
				operation: "execute_tool",
				toolName: "run_query",
				toolCallId: "call_b",
				statusCode: "Error",
			}),
		])
		const assistant = events.find((e) => e.kind === "message" && e.role === "assistant")!
		const tools = events.filter((e) => e.kind === "toolCall")
		expect(tools.map((t) => t.parentEventId)).toEqual([assistant.id, assistant.id])
		expect(tools.map((t) => t.status)).toEqual(["unset", "error"])
	})

	// Not every emitter sends a call id; span parentage is the fallback.
	it("falls back to span parentage when the call id is missing", () => {
		const events = buildJourneyTimeline([
			span({ spanId: "span_1", outputMessages: text("assistant", "on it") }),
			span({ spanId: "span_2", parentSpanId: "span_1", operation: "execute_tool", toolName: "grep" }),
		])
		const assistant = events.find((e) => e.kind === "message")!
		expect(events.find((e) => e.kind === "toolCall")!.parentEventId).toBe(assistant.id)
	})

	// Parallel calls can be ordered ahead of their triggering message by clock
	// skew between spans of the same turn.
	it("resolves a tool span that arrives before its assistant message", () => {
		const events = buildJourneyTimeline([
			span({
				spanId: "span_2",
				operation: "execute_tool",
				toolCallId: "call_a",
				toolName: "search_docs",
				timestamp: "2026-08-05 09:59:59",
			}),
			assistantWithTools,
		])
		const assistant = events.find((e) => e.kind === "message" && e.role === "assistant")!
		expect(events.find((e) => e.kind === "toolCall")!.parentEventId).toBe(assistant.id)
	})

	// The intersection of the two fallbacks: early arrival AND no call id. The
	// post-pass originally only re-resolved by call id, so this span stayed
	// orphaned and rendered outside the turn that fired it.
	it("resolves an early tool span that has no call id, via parentage", () => {
		const events = buildJourneyTimeline([
			span({
				spanId: "span_2",
				parentSpanId: "span_1",
				operation: "execute_tool",
				toolName: "grep",
				timestamp: "2026-08-05 09:59:59",
			}),
			span({ spanId: "span_1", outputMessages: text("assistant", "on it") }),
		])
		const assistant = events.find((e) => e.kind === "message")!
		expect(events.find((e) => e.kind === "toolCall")!.parentEventId).toBe(assistant.id)
	})

	// A tool span with neither a resolvable call id nor a known parent is a
	// legitimate state (a tool executed outside any turn we captured). It stays
	// unparented rather than being attached to an unrelated message.
	it("leaves a genuinely unattributable tool span unparented", () => {
		const events = buildJourneyTimeline([
			span({
				spanId: "span_9",
				parentSpanId: "not_in_journey",
				operation: "execute_tool",
				toolName: "ls",
			}),
		])
		expect(events.find((e) => e.kind === "toolCall")!.parentEventId).toBeNull()
	})
})

describe("content-redacted journeys", () => {
	// Privacy modes strip exactly the message bodies while keeping timing, model,
	// token and cost data. That is an expected state, not an error path.
	it("keeps the turn, its metrics, and says the content is absent", () => {
		const events = buildJourneyTimeline([
			span({ inputTokens: 800, outputTokens: 120, costRaw: "0.004", cost: 0.004 }),
		])
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			kind: "message",
			role: "assistant",
			content: null,
			contentSource: "absent",
			inputTokens: 800,
			cost: 0.004,
		})
	})

	// Older OpenLLMetry SDKs put prompts/completions in span events. We don't
	// read them yet — but the row must say so rather than look broken.
	it("distinguishes content that lives in span events", () => {
		const events = buildJourneyTimeline([span({ contentEventCount: 2 })])
		expect(events[0]!.contentSource).toBe("events")
	})

	// Cost has no stable convention: absence must read as unknown, never $0.00.
	it("reports an absent cost attribute as null", () => {
		const events = buildJourneyTimeline([span({ costRaw: "", cost: 0 })])
		expect(events[0]!.cost).toBeNull()
	})
})

describe("non-message operations and handoffs", () => {
	// `retrieval`, `plan`, memory ops and `invoke_agent` are first-class span
	// types in the standard — the timeline admits them from the start.
	it("emits an operation event for a non-inference span", () => {
		const events = buildJourneyTimeline([
			span({ operation: "retrieval", spanName: "retrieval docs", durationMs: 42 }),
		])
		expect(events[0]).toMatchObject({ kind: "operation", operation: "retrieval", durationMs: 42 })
	})

	it("marks an agent handoff when the agent changes mid-journey", () => {
		const events = buildJourneyTimeline([
			span({ spanId: "s1", agentName: "planner", outputMessages: text("assistant", "delegating") }),
			span({
				spanId: "s2",
				timestamp: "2026-08-05 10:01:00",
				agentName: "researcher",
				operation: "invoke_agent",
			}),
		])
		const handoffs = events.filter((e) => e.kind === "agentHandoff")
		expect(handoffs).toHaveLength(2)
		// The first names no predecessor; the second records who handed off.
		expect(handoffs.map((h) => [h.content, h.agentName])).toEqual([
			[null, "planner"],
			["planner", "researcher"],
		])
	})

	// A 4000-word system prompt repeated on 40 spans is one row, not 40.
	it("emits the system prompt once and again only when it changes", () => {
		const events = buildJourneyTimeline([
			span({ spanId: "s1", systemInstructions: "you are helpful" }),
			span({ spanId: "s2", systemInstructions: "you are helpful" }),
			span({ spanId: "s3", systemInstructions: "you are terse" }),
		])
		expect(events.filter((e) => e.kind === "systemPrompt").map((e) => e.content)).toEqual([
			"you are helpful",
			"you are terse",
		])
	})
})

// ---------------------------------------------------------------------------
// `withoutContent` — the shape of a journey without any of its text.
//
// Five sites strip content (system prompt, tool result, tool arguments,
// operation output, message body). A miss in any one leaks message text to a
// caller that explicitly asked for structure only, so all five are asserted
// together rather than one representative.
// ---------------------------------------------------------------------------

describe("withoutContent", () => {
	const rows = [
		span({
			spanId: "s1",
			systemInstructions: "secret system prompt",
			inputMessages: text("user", "secret question"),
			outputMessages: JSON.stringify([
				{ role: "assistant", parts: [{ type: "tool_call", id: "call_a", name: "search" }] },
			]),
		}),
		span({
			spanId: "s2",
			parentSpanId: "s1",
			timestamp: "2026-08-05 10:00:05",
			operation: "execute_tool",
			toolName: "search",
			toolCallId: "call_a",
			toolArguments: '{"q":"secret"}',
			toolResult: "secret result",
		}),
		span({
			spanId: "s3",
			timestamp: "2026-08-05 10:00:10",
			operation: "retrieval",
			outputMessages: "secret documents",
		}),
	]

	it("keeps every event and every metric", () => {
		const bare = buildJourneyTimeline(rows, { withoutContent: true })
		expect(bare.map((e) => e.kind)).toEqual(buildJourneyTimeline(rows).map((e) => e.kind))
		expect(bare.find((e) => e.kind === "toolCall")).toMatchObject({
			toolName: "search",
			toolCallId: "call_a",
			status: "unset",
		})
	})

	it("leaks no text through any of the five content fields", () => {
		const serialized = JSON.stringify(buildJourneyTimeline(rows, { withoutContent: true }))
		expect(serialized).not.toContain("secret")
		for (const event of buildJourneyTimeline(rows, { withoutContent: true })) {
			expect(event.content).toBeNull()
			expect(event.toolArguments).toBeNull()
			expect(event.toolResult).toBeNull()
		}
	})
})
