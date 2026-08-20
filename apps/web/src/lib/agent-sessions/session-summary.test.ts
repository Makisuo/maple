import { describe, expect, it } from "vitest"

import { agentSpan, llmSpan, makeSpan, T0, toolSpan } from "./span-fixtures"
import { buildSessionTurns } from "./session-turns"
import {
	buildSessionSummary,
	findIdleGaps,
	SESSION_ACTIVE_WINDOW_MS,
	type OccupancyKind,
} from "./session-summary"

const SECOND = 1000
const MINUTE = 60 * SECOND

/** Long after the session, so `status` is not "active" unless a test asks for it. */
const LATER = T0 + 4 * 60 * MINUTE

const summarize = (spans: Parameters<typeof buildSessionTurns>[0], nowMs = LATER) =>
	buildSessionSummary(spans, buildSessionTurns(spans), nowMs)

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

describe("buildSessionSummary — status", () => {
	const spans = [
		agentSpan({ spanId: "agent", startMs: 0, durationMs: 10 * SECOND }),
		llmSpan({ spanId: "llm", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
	]

	it("is active while a span landed inside the last half hour", () => {
		const summary = summarize(spans, T0 + 10 * SECOND + SESSION_ACTIVE_WINDOW_MS - MINUTE)

		expect(summary.status).toBe("active")
	})

	it("is completed once the last turn closed cleanly and nothing followed", () => {
		expect(summarize(spans).status).toBe("completed")
	})

	it("is failed when the last turn's root span errored", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 10 * SECOND }),
			agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: SECOND, statusCode: "Error" }),
		])

		expect(summary.status).toBe("failed")
	})

	it("is abandoned when nothing in the data says the agent ever finished", () => {
		// No conversation id and no agent invocation: turns came from trace
		// boundaries, which are not evidence of completion.
		const summary = summarize([llmSpan({ spanId: "llm", startMs: 0, durationMs: SECOND })])

		expect(summary.status).toBe("abandoned")
	})
})

describe("buildSessionSummary — tokens and models", () => {
	it("sums the five usage buckets", () => {
		const summary = summarize([
			llmSpan({ spanId: "a", startMs: 0, durationMs: SECOND, tokens: [100, 2000, 300, 40, 5] }),
			llmSpan({ spanId: "b", startMs: 2 * SECOND, durationMs: SECOND, tokens: [10, 20, 30, 4, 5] }),
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
			// The framework reports the turn total on the agent span AND on each
			// model span underneath it.
			agentSpan({
				spanId: "agent",
				startMs: 0,
				durationMs: 10 * SECOND,
				genAi: { usageInputTokens: 300, usageOutputTokens: 30 },
			}),
			llmSpan({ spanId: "a", parentSpanId: "agent", startMs: 0, durationMs: SECOND, tokens: [100, 0, 0, 10, 0] }),
			llmSpan({
				spanId: "b",
				parentSpanId: "agent",
				startMs: 2 * SECOND,
				durationMs: SECOND,
				tokens: [200, 0, 0, 20, 0],
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

		expect(summary.work).toMatchObject({ turns: 1, llmCalls: 2, toolCalls: 2 })
	})

	it("counts a rate-limited model call that was tried again as a retry", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			llmSpan({
				spanId: "llm-1",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
			llmSpan({ spanId: "llm-2", parentSpanId: "agent", startMs: 10 * SECOND, durationMs: SECOND }),
		])

		expect(summary.work.retries).toBe(1)
		expect(summary.failures.rateLimited).toBe(1)
	})

	it("does not call the turn's last model call a retry, however it ended", () => {
		const summary = summarize([
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			llmSpan({
				spanId: "llm",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: SECOND,
				statusCode: "Error",
				genAi: { errorType: "429" },
			}),
		])

		expect(summary.work.retries).toBe(0)
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
			toolErrors: 1,
			rateLimited: 0,
			contextExceeded: 1,
			refusals: 1,
		})
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
			toolErrors: 0,
			rateLimited: 0,
			contextExceeded: 0,
			refusals: 0,
		})
	})
})

describe("buildSessionSummary — identity", () => {
	it("names services busiest first and vendors in first-seen order", () => {
		const summary = summarize([
			agentSpan({ spanId: "a", startMs: 0, durationMs: 30 * SECOND, serviceName: "gateway", vendorId: "eve" }),
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
})
