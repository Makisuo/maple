import { describe, expect, it } from "vitest"

import { buildTurnDigest } from "./session-overview"
import { buildSessionSummary } from "./session-summary"
import { buildSessionTurns } from "./session-turns"
import { agentSpan, llmSpan, toolSpan } from "./span-test-support"

const SECOND = 1000
const MINUTE = 60 * SECOND

function session(spans: Parameters<typeof buildSessionTurns>[0]) {
	const turns = buildSessionTurns(spans)
	return { turns, summary: buildSessionSummary({ spans, turns }) }
}

/** One turn that failed on a context-window error reported at two levels, with
 *  a rate-limited retry before it. */
const failed = session([
	agentSpan({
		spanId: "agent",
		startMs: 0,
		durationMs: 6 * SECOND,
		statusCode: "Error",
		statusMessage: "prompt is too long",
		genAi: { errorType: "context_length_exceeded" },
	}),
	llmSpan({
		spanId: "llm-429",
		parentSpanId: "agent",
		startMs: SECOND,
		durationMs: SECOND,
		model: "claude-opus-5",
		statusCode: "Error",
		statusMessage: "429 rate limited",
	}),
	llmSpan({
		spanId: "llm-ctx",
		parentSpanId: "agent",
		startMs: 3 * SECOND,
		durationMs: 2 * SECOND,
		model: "claude-opus-5",
		statusCode: "Error",
		statusMessage: "prompt is too long",
		genAi: { errorType: "context_length_exceeded" },
	}),
])

describe("buildTurnDigest", () => {
	const { turns } = session([
		agentSpan({ spanId: "a1", startMs: 0, durationMs: 20 * SECOND }),
		llmSpan({
			spanId: "l1",
			parentSpanId: "a1",
			startMs: 0,
			durationMs: 4 * SECOND,
			model: "claude-opus-5",
			genAi: { usageInputTokens: 1000, usageOutputTokens: 100, usageCost: 0.25 },
		}),
		llmSpan({
			spanId: "l2",
			parentSpanId: "a1",
			startMs: 5 * SECOND,
			durationMs: 4 * SECOND,
			model: "claude-opus-5",
			genAi: { usageInputTokens: 500, usageOutputTokens: 50, usageCost: 0.15 },
		}),
		toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 10 * SECOND, durationMs: SECOND }),
		toolSpan({ spanId: "t2", parentSpanId: "a1", startMs: 12 * SECOND, durationMs: SECOND }),
		toolSpan({
			spanId: "t3",
			parentSpanId: "a1",
			startMs: 14 * SECOND,
			durationMs: SECOND,
			toolName: "run_tests",
		}),
	])

	it("counts a turn's models and tools by how often it called each", () => {
		const [row] = buildTurnDigest(turns)

		expect(row!.models).toEqual([{ model: "claude-opus-5", calls: 2 }])
		expect(row!.tools).toEqual([
			{ name: "read_file", calls: 2 },
			{ name: "run_tests", calls: 1 },
		])
	})

	it("adds up the turn's own tokens and cost", () => {
		const [row] = buildTurnDigest(turns)

		expect(row!.tokens.total).toBe(1650)
		expect(row!.cost).toBeCloseTo(0.4)
	})

	// The row prints "—" rather than "$0.00" on this, which is the difference
	// between unpriced and free.
	it("reports no cost for a turn whose spans reported none", () => {
		const { turns: unpriced } = session([
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 2 * SECOND }),
			llmSpan({ spanId: "l1", parentSpanId: "a1", startMs: 0, durationMs: SECOND }),
		])

		expect(buildTurnDigest(unpriced)[0]!.cost).toBeUndefined()
	})

	// A span reporting for more than one turn belongs to none of them: crediting
	// turn 1 with the whole session is the one number that is certainly wrong.
	it("leaves a session-level reporter out of every turn", () => {
		const { turns: aggregate } = session([
			agentSpan({
				spanId: "root",
				startMs: 0,
				durationMs: 5 * MINUTE + 10 * SECOND,
				genAi: { usageInputTokens: 5000, usageOutputTokens: 500, usageCost: 3 },
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
		])

		expect(buildTurnDigest(aggregate).map((row) => row.cost)).toEqual([undefined, undefined])
		expect(buildTurnDigest(aggregate).map((row) => row.tokens.total)).toEqual([0, 0])
	})

	it("splits a turn's own wall clock the way the session bar splits the whole", () => {
		const [row] = buildTurnDigest(turns)
		const total = row!.occupancy.reduce((sum, segment) => sum + segment.ms, 0)

		expect(total).toBe(20 * SECOND)
		expect(row!.occupancy.map((segment) => segment.kind)).toContain("tool")
	})

	it("groups what went wrong inside the turn", () => {
		expect(buildTurnDigest(failed.turns)[0]!.failures).toEqual([
			{ kind: "contextExceeded", label: "context_length_exceeded", count: 1 },
			{ kind: "rateLimited", label: "rate_limit", count: 1 },
		])
	})
})
