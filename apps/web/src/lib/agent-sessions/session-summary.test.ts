import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan } from "./span-test-support"
import { buildSessionTurns } from "./session-turns"
import { buildSessionSummary, countTurnTokens, findIdleGaps, type OccupancyKind } from "./session-summary"

const SECOND = 1000
const MINUTE = 60 * SECOND

const summarize = (spans: Parameters<typeof buildSessionTurns>[0]) =>
	buildSessionSummary({ spans, turns: buildSessionTurns(spans) })

const segment = (
	occupancy: readonly { readonly kind: OccupancyKind; readonly ms: number }[],
	kind: OccupancyKind,
) => occupancy.find((entry) => entry.kind === kind)?.ms

describe("findIdleGaps", () => {
	it("finds the stretches where nothing was running", () => {
		const gaps = findIdleGaps([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 70 * SECOND, durationMs: 5 * SECOND }),
		])

		expect(gaps).toHaveLength(1)
		expect(gaps[0]!.durationMs).toBe(60 * SECOND)
	})

	it("ignores a hole too short to be a human", () => {
		const gaps = findIdleGaps([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 12 * SECOND, durationMs: SECOND }),
		])

		expect(gaps).toEqual([])
	})

	it("sees no gap under a span that covers it", () => {
		const gaps = findIdleGaps([
			// The agent span stays open across the whole turn.
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 90 * SECOND }),
			llmSpan({ spanId: "a", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", parentSpanId: "agent", startMs: 70 * SECOND, durationMs: 5 * SECOND }),
		])

		expect(gaps).toEqual([])
	})
})

describe("buildSessionSummary — time", () => {
	it("reports the wall clock, and active time as the wall clock less idle", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "b", startMs: 70 * SECOND, durationMs: 10 * SECOND }),
		])

		expect(summary.wallClockMs).toBe(80 * SECOND)
		expect(summary.idleMs).toBe(60 * SECOND)
		expect(summary.activeMs).toBe(20 * SECOND)
	})

	it("measures occupancy, so parallel tools cannot exceed the wall clock", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			// Four tools, ten seconds each, all at once: 40s of duration inside a
			// 10s session.
			toolSpan({ spanId: "t1", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t2", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t3", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t4", parentSpanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
		])

		expect(segment(summary.occupancy, "tool")).toBe(10 * SECOND)
		expect(summary.occupancy.reduce((total, entry) => total + entry.ms, 0)).toBe(summary.wallClockMs)
	})

	it("charges overlapping inference and tool time once, to inference", () => {
		const summary = summarize([
			llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND }),
			// A tool that ran while the model was still streaming.
			toolSpan({ spanId: "tool", startMs: 5 * SECOND, durationMs: 10 * SECOND }),
		])

		expect(segment(summary.occupancy, "inference")).toBe(10 * SECOND)
		expect(segment(summary.occupancy, "tool")).toBe(5 * SECOND)
	})

	it("splits a streaming call into time to first token and the rest", () => {
		const summary = summarize([
			llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND, ttftSeconds: 4 }),
		])

		expect(segment(summary.occupancy, "ttft")).toBe(4 * SECOND)
		expect(segment(summary.occupancy, "inference")).toBe(6 * SECOND)
	})

	it("omits the time-to-first-token segment when no vendor reported one", () => {
		const summary = summarize([llmSpan({ spanId: "llm", startMs: 0, durationMs: 10 * SECOND })])

		expect(segment(summary.occupancy, "ttft")).toBeUndefined()
	})

	it("leaves the time no gen_ai span accounts for as the framework's own", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: 2 * SECOND, durationMs: 3 * SECOND }),
		])

		expect(segment(summary.occupancy, "inference")).toBe(3 * SECOND)
		expect(segment(summary.occupancy, "unaccounted")).toBe(7 * SECOND)
	})
})

describe("buildSessionSummary — failed", () => {
	it("is false when the last turn closed cleanly", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
		])

		expect(summary.failed).toBe(false)
	})

	it("is true when the last turn's root span errored", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND }),
			agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: SECOND, statusCode: "Error" }),
		])

		expect(summary.failed).toBe(true)
	})

	it("reads the last turn, not any turn — an earlier failure the agent recovered from does not count", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND, statusCode: "Error" }),
			agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: SECOND }),
		])

		expect(summary.failed).toBe(false)
	})
})

describe("buildSessionSummary — tokens and models", () => {
	it("reports the five usage buckets as the spans reported them", () => {
		const summary = summarize([
			llmSpan({
				spanId: "a",
				startMs: 0,
				durationMs: SECOND,
				genAi: {
					providerName: "anthropic",
					usageInputTokens: 100,
					usageCacheReadInputTokens: 2000,
					usageCacheCreationInputTokens: 300,
					usageOutputTokens: 40,
					usageReasoningOutputTokens: 5,
				},
			}),
			llmSpan({
				spanId: "b",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				genAi: {
					providerName: "anthropic",
					usageInputTokens: 10,
					usageCacheReadInputTokens: 20,
					usageCacheCreationInputTokens: 30,
					usageOutputTokens: 4,
					usageReasoningOutputTokens: 5,
				},
			}),
		])

		expect(summary.tokens).toEqual({
			input: 110,
			cacheRead: 2020,
			cacheWrite: 330,
			output: 44,
			reasoning: 10,
			total: 2514,
		})
	})

	it("counts usage at the deepest span that reports it", () => {
		const summary = summarize([
			// The framework reports a turn total on the agent span AND on each model
			// span underneath it. Its own figure is lower than theirs here, so a
			// total that read 250 would be the roll-up rather than the model calls.
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { usageInputTokens: 250, usageOutputTokens: 25 },
			}),
			llmSpan({
				spanId: "a",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 100, usageOutputTokens: 10 },
			}),
			llmSpan({
				spanId: "b",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				genAi: { usageInputTokens: 200, usageOutputTokens: 20 },
			}),
		])

		expect(summary.tokens.input).toBe(300)
		expect(summary.tokens.output).toBe(30)
	})

	it("keeps what a roll-up reported above the children that reported", () => {
		const summary = summarize([
			// Three model calls under one agent span, and the middle one carries no
			// usage at all — its tokens survive as the agent span's excess.
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { usageInputTokens: 300, usageOutputTokens: 30 },
			}),
			llmSpan({
				spanId: "a",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 100, usageOutputTokens: 10 },
			}),
			llmSpan({ spanId: "b", parentSpanId: "agent", startMs: 2 * SECOND, durationMs: SECOND }),
			llmSpan({
				spanId: "c",
				parentSpanId: "agent",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				genAi: { usageInputTokens: 100, usageOutputTokens: 10 },
			}),
		])

		expect(summary.tokens.input).toBe(300)
		expect(summary.tokens.output).toBe(30)
	})

	it("keeps usage reported only at the top of the tree", () => {
		const summary = summarize([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { usageInputTokens: 300, usageOutputTokens: 30 },
			}),
			llmSpan({ spanId: "a", parentSpanId: "agent", startMs: 0, durationMs: SECOND }),
		])

		expect(summary.tokens.input).toBe(300)
	})

	it("groups models by the one that answered, busiest first", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, model: "claude-haiku-4-5" }),
			llmSpan({ spanId: "b", startMs: 2 * SECOND, durationMs: SECOND, model: "claude-opus-4-1" }),
			llmSpan({ spanId: "c", startMs: 4 * SECOND, durationMs: SECOND, model: "claude-opus-4-1" }),
		])

		expect(summary.models.map((model) => [model.model, model.llmCalls])).toEqual([
			["claude-opus-4-1", 2],
			["claude-haiku-4-5", 1],
		])
	})

	it("gives no model row to usage that names no model, and still counts its tokens", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 5 * SECOND }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100 },
			}),
		])

		expect(summary.models).toEqual([])
		expect(summary.tokens.input).toBe(1000)
	})
})

describe("buildSessionSummary — cache accounting", () => {
	// One prompt, reported identically by every provider below: 1,000 prompt
	// tokens of which 900 were a cache hit and 100 were written to the cache, and
	// 100 tokens back. Billed as 2,100 tokens where the cache is charged beside
	// the prompt, and as 1,100 where it is charged inside it.
	const CACHED_USAGE = {
		usageInputTokens: 1000,
		usageCacheReadInputTokens: 900,
		usageCacheCreationInputTokens: 100,
		usageOutputTokens: 100,
	} as const

	it("adds the cache buckets for Anthropic, which bills them beside the prompt", () => {
		const summary = summarize([
			llmSpan({
				spanId: "a",
				startMs: 0,
				durationMs: SECOND,
				genAi: { providerName: "anthropic", ...CACHED_USAGE },
			}),
		])

		expect(summary.tokens.total).toBe(2100)
	})

	it("leaves the cache out of the total for OpenAI, whose prompt count contains it", () => {
		const summary = summarize([
			llmSpan({
				spanId: "a",
				startMs: 0,
				durationMs: SECOND,
				genAi: { providerName: "openai", ...CACHED_USAGE },
			}),
		])

		// The buckets stay for the legend; only the total refuses to double them.
		expect(summary.tokens.total).toBe(1100)
		expect(summary.tokens.cacheRead).toBe(900)
	})

	it("treats an unnamed provider as inclusive, the convention most of them follow", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, genAi: CACHED_USAGE }),
		])

		expect(summary.tokens.total).toBe(1100)
	})

	it("takes the Vercel AI SDK as inclusive even on an Anthropic call", () => {
		// The SDK reports `gen_ai.usage.input_tokens` as `inputTokens.total`, which
		// its Anthropic provider builds as noCache + cacheRead + cacheWrite — so the
		// vendor's normalisation, not the provider's API, is what got emitted.
		const summary = summarize([
			llmSpan({
				spanId: "a",
				startMs: 0,
				durationMs: SECOND,
				vendorId: "vercel_ai_sdk",
				genAi: { providerName: "anthropic", ...CACHED_USAGE },
			}),
		])

		expect(summary.tokens.total).toBe(1100)
	})

	it("prices a roll-up's residual under the span that reported it", () => {
		const summary = summarize([
			// The wrapper's own figures are Anthropic's, so the part of them no child
			// claimed is Anthropic's too — 200 + 60 + 20, not 200 + 20.
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: {
					providerName: "anthropic",
					usageInputTokens: 300,
					usageCacheReadInputTokens: 100,
					usageOutputTokens: 30,
				},
			}),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { usageInputTokens: 100, usageCacheReadInputTokens: 40, usageOutputTokens: 10 },
			}),
		])

		expect(summary.tokens.total).toBe(280 + 110)
		expect(summary.tokens.input).toBe(300)
		expect(summary.tokens.cacheRead).toBe(100)
	})
})

/** Two turns, each with its own model call reporting its own usage. */
const perCall = [
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
	llmSpan({
		spanId: "l1",
		parentSpanId: "a1",
		startMs: SECOND,
		durationMs: SECOND,
		genAi: { usageInputTokens: 100, usageOutputTokens: 10 },
	}),
	agentSpan({ spanId: "a2", startMs: 5 * MINUTE, durationMs: 10 * SECOND }),
	llmSpan({
		spanId: "l2",
		parentSpanId: "a2",
		startMs: 5 * MINUTE + SECOND,
		durationMs: SECOND,
		genAi: { usageInputTokens: 200, usageOutputTokens: 20 },
	}),
]

/**
 * Aggregate-only: one long-lived span reports the whole session's usage while
 * the model calls beneath it report none, and it outlives the turn it started
 * in. Turns come from the conversation ids on the calls.
 */
const aggregateOnly = [
	agentSpan({
		spanId: "root",
		startMs: 0,
		durationMs: 5 * MINUTE + 10 * SECOND,
		genAi: { usageInputTokens: 5000, usageOutputTokens: 500 },
	}),
	llmSpan({
		spanId: "l1",
		parentSpanId: "root",
		startMs: SECOND,
		durationMs: SECOND,
		genAi: { conversationId: "turn-1" },
	}),
	llmSpan({
		spanId: "l2",
		parentSpanId: "root",
		startMs: 5 * MINUTE,
		durationMs: 2 * SECOND,
		genAi: { conversationId: "turn-2" },
	}),
]

describe("buildSessionSummary — token reporting", () => {
	it("is none when nothing reported usage", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND }),
			llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: 0, durationMs: SECOND }),
		])

		expect(summary.tokenReporting).toBe("none")
	})

	it("is per-call when each model call reported its own", () => {
		expect(summarize(perCall).tokenReporting).toBe("per-call")
	})

	it("is roll-up when a wrapper restates what the calls beneath it reported", () => {
		const summary = summarize([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { usageInputTokens: 300, usageOutputTokens: 30 },
			}),
			llmSpan({
				spanId: "a",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 100, usageOutputTokens: 10 },
			}),
			llmSpan({
				spanId: "b",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				genAi: { usageInputTokens: 200, usageOutputTokens: 20 },
			}),
		])

		expect(summary.tokenReporting).toBe("roll-up")
	})

	it("is session-level when the only reporter covers more than one turn", () => {
		const summary = summarize(aggregateOnly)

		expect(summary.tokenReporting).toBe("session-level")
		// The session total is still right — it is the turns that cannot have it.
		expect(summary.tokens.total).toBe(5500)
	})
})

describe("countTurnTokens", () => {
	it("adds up to the session total when every call reported its own usage", () => {
		const turns = buildSessionTurns(perCall)

		expect(turns.map((turn) => countTurnTokens(turn, turns).total)).toEqual([110, 220])
		expect(summarize(perCall).tokens.total).toBe(330)
	})

	it("credits no turn with a reporter that spans several of them", () => {
		// Regression: time-partitioned assignment put the whole session's 5,500
		// tokens on turn 1 and left turn 2 reading zero.
		const turns = buildSessionTurns(aggregateOnly)

		expect(turns).toHaveLength(2)
		expect(turns.map((turn) => countTurnTokens(turn, turns).total)).toEqual([0, 0])
	})
})

describe("buildSessionSummary — cost", () => {
	it("is undefined when no span reported a cost, whatever the tokens say", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND }),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100 },
			}),
		])
		expect(summary.cost).toBeUndefined()
	})

	it("counts a wrapper's cost only above what its children already reported", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND, genAi: { usageCost: 0.5 } }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100, usageCost: 0.2 },
			}),
			llmSpan({
				spanId: "llm-2",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100, usageCost: 0.3 },
			}),
		])
		expect(summary.cost).toBe(0.5)
	})

	it("takes a roll-up on the agent span as the session's cost", () => {
		// The common shape for `operation.cost`: one figure at the top, tokens on
		// the model calls beneath it.
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: SECOND, genAi: { usageCost: 0.5 } }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100 },
			}),
			llmSpan({
				spanId: "llm-2",
				parentSpanId: "agent",
				startMs: 0,
				durationMs: SECOND,
				genAi: { usageInputTokens: 1000, usageOutputTokens: 100 },
			}),
		])
		expect(summary.cost).toBe(0.5)
	})
})

describe("buildSessionSummary — work and failures", () => {
	it("counts turns, model calls and tool calls separately", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			llmSpan({ spanId: "llm-1", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "tool-1", parentSpanId: "agent", startMs: 3 * SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "tool-2", parentSpanId: "agent", startMs: 5 * SECOND, durationMs: SECOND }),
			llmSpan({ spanId: "llm-2", parentSpanId: "agent", startMs: 7 * SECOND, durationMs: SECOND }),
		])

		expect(summary.work).toEqual({ turns: 1, llmCalls: 2, toolCalls: 2 })
	})

	it("counts a failure once when a wrapper span restates it", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			// The framework's own container span around the model call, carrying the
			// same error verbatim.
			llmSpan({
				spanId: "container",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 2 * SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
			llmSpan({
				spanId: "inner",
				parentSpanId: "container",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
		])

		expect(summary.failures.rateLimited).toBe(1)
	})

	it("counts a refusal once when the agent span repeats the finish reason", () => {
		const summary = summarize([
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 20 * SECOND,
				genAi: { operationName: "invoke_agent", responseFinishReasons: ["refusal"] },
			}),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["refusal"] },
			}),
		])

		expect(summary.failures.refusals).toBe(1)
	})

	it("groups failures by cause, and counts each errored span once", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND }),
			toolSpan({
				spanId: "tool",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "exit 1",
			}),
			llmSpan({
				spanId: "context",
				parentSpanId: "agent",
				startMs: 3 * SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "context_length_exceeded",
			}),
			llmSpan({
				spanId: "refused",
				parentSpanId: "agent",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["refusal"] },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 1,
			rateLimited: 0,
			contextExceeded: 1,
			refusals: 1,
		})
	})

	it("counts an errored model call the patterns do not name, rather than dropping it", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "Internal Server Error",
			}),
		])

		expect(summary.failures.errors).toBe(1)
	})

	it("does not read a max_tokens finish as a failure", () => {
		const summary = summarize([
			llmSpan({
				spanId: "llm",
				startMs: 0,
				durationMs: SECOND,
				genAi: { responseFinishReasons: ["length"] },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 0,
			rateLimited: 0,
			contextExceeded: 0,
			refusals: 0,
		})
	})
})

describe("buildSessionSummary — identity", () => {
	it("names services busiest first and vendors in first-seen order", () => {
		const summary = summarize([
			agentSpan({
				spanId: "a",
				startMs: 0,
				durationMs: 30 * SECOND,
				serviceName: "gateway",
				vendorId: "eve",
			}),
			llmSpan({ spanId: "b", startMs: SECOND, durationMs: SECOND, serviceName: "agent-runner" }),
			llmSpan({ spanId: "c", startMs: 3 * SECOND, durationMs: SECOND, serviceName: "agent-runner" }),
			makeSpan({
				spanId: "d",
				startMs: 5 * SECOND,
				durationMs: SECOND,
				serviceName: "tool-worker",
				vendorId: "mastra",
			}),
		])

		expect(summary.serviceNames).toEqual(["agent-runner", "gateway", "tool-worker"])
		expect(summary.vendorIds).toEqual(["eve", "mastra"])
		expect(summary.traceCount).toBe(1)
		expect(summary.spanCount).toBe(4)
	})

	it("names vendors in session order, whatever order the rows arrived in", () => {
		const early = agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND, vendorId: "eve" })
		const late = agentSpan({ spanId: "b", startMs: 10 * SECOND, durationMs: SECOND, vendorId: "mastra" })

		expect(buildSessionSummary({ spans: [late, early], turns: [] }).vendorIds).toEqual(["eve", "mastra"])
	})
})

describe("per-model cost, tools and failure groups", () => {
	// The rail prices each model row separately, and a model whose calls carried
	// no cost has to read as unpriced rather than free while another model's
	// figure sits above it.
	it("prices a model only from its own calls, and says nothing about the rest", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "priced",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: SECOND,
				model: "claude-opus-5",
				genAi: { usageCost: 0.5 },
			}),
			llmSpan({
				spanId: "unpriced",
				parentSpanId: "a1",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				model: "claude-haiku-4-5",
			}),
		])

		expect(summary.cost).toBeCloseTo(0.5)
		expect(summary.models.find((model) => model.model === "claude-opus-5")?.cost).toBeCloseTo(0.5)
		expect(summary.models.find((model) => model.model === "claude-haiku-4-5")?.cost).toBeUndefined()
	})

	// Same deepest-reporter rule the tokens follow: a wrapper that sums its
	// children's cost onto itself must not double the session's spend.
	it("does not count a rolled-up cost twice", () => {
		const summary = summarize([
			agentSpan({
				spanId: "root",
				startMs: 0,
				durationMs: 4 * SECOND,
				genAi: { usageCost: 0.3 },
			}),
			llmSpan({
				spanId: "child",
				parentSpanId: "root",
				startMs: 0,
				durationMs: SECOND,
				model: "gpt-5",
				genAi: { usageCost: 0.3 },
			}),
		])

		expect(summary.cost).toBeCloseTo(0.3)
	})

	it("counts tools by name, busiest first", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 0, durationMs: 100 }),
			toolSpan({ spanId: "t2", parentSpanId: "a1", startMs: 200, durationMs: 100 }),
			toolSpan({
				spanId: "t3",
				parentSpanId: "a1",
				startMs: 400,
				durationMs: 100,
				toolName: "run_tests",
			}),
		])

		expect(summary.tools).toEqual([
			{ name: "read_file", calls: 2 },
			{ name: "run_tests", calls: 1 },
		])
	})

	// The counts and the breakdown are two readings of one list, so a failure
	// classified as a rate limit must not also appear as a generic error.
	it("groups failures under the same classification the counts use", () => {
		const summary = summarize([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			llmSpan({
				spanId: "l1",
				parentSpanId: "a1",
				startMs: 0,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "429 too many requests",
			}),
			llmSpan({
				spanId: "l2",
				parentSpanId: "a1",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				statusMessage: "429 too many requests",
			}),
			toolSpan({
				spanId: "t1",
				parentSpanId: "a1",
				startMs: 4 * SECOND,
				durationMs: SECOND,
				toolName: "run_tests",
				statusCode: "Error",
				genAi: { errorType: "tool_error" },
			}),
		])

		expect(summary.failures).toEqual({
			errors: 1,
			rateLimited: 2,
			contextExceeded: 0,
			refusals: 0,
		})
		expect(summary.failureGroups).toEqual([
			{ kind: "rateLimited", label: "rate_limit", count: 2 },
			{ kind: "error", label: "tool_error · run_tests", count: 1 },
		])
	})
})
