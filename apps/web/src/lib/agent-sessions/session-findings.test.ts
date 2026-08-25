import { describe, expect, it } from "vitest"

import { buildSessionFindings } from "./session-findings"
import { buildSessionSummary } from "./session-summary"
import { buildSessionTurns } from "./session-turns"
import { agentSpan, llmSpan, toolSpan } from "./span-test-support"

const SECOND = 1000
const MINUTE = 60 * SECOND

function report(spans: Parameters<typeof buildSessionTurns>[0]) {
	const turns = buildSessionTurns(spans)
	return buildSessionFindings(turns, buildSessionSummary({ spans, turns }))
}

/** Two conversation-keyed turns so a failure can be terminal or recovered. */
function twoTurns(secondTurn: readonly Parameters<typeof buildSessionTurns>[0][number][]) {
	return [
		agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND, genAi: { conversationId: "t1" } }),
		llmSpan({
			spanId: "l1",
			parentSpanId: "a1",
			startMs: SECOND,
			durationMs: SECOND,
			model: "claude-opus-5",
			genAi: { conversationId: "t1", usageInputTokens: 1000, usageOutputTokens: 100 },
		}),
		...secondTurn,
	]
}

describe("buildSessionFindings", () => {
	it("calls a clean session clean, with no findings and every turn clean", () => {
		const clean = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(clean.verdict.status).toBe("clean")
		expect(clean.findings).toEqual([])
		expect(clean.turnHealth).toEqual(["clean", "clean"])
	})

	it("names the span the final turn died on, not the retry before it", () => {
		const failed = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: { conversationId: "t2", errorType: "context_length_exceeded" },
				}),
				llmSpan({
					spanId: "l-429",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "429 Too Many Requests",
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-ctx",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + 3 * SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: {
						conversationId: "t2",
						errorType: "context_length_exceeded",
						usageInputTokens: 190_000,
					},
				}),
			]),
		)

		expect(failed.verdict).toEqual({
			status: "failed",
			label: "context_length_exceeded",
			spanId: "l-ctx",
		})
		// The terminal failure leads the list; the rate limit is its own finding.
		expect(failed.findings[0]!.label).toBe("context_length_exceeded")
		expect(failed.findings[0]!.severity).toBe("failure")
		expect(failed.findings[0]!.turnText).toBe("Turn 2 (final)")
		expect(failed.findings.some((finding) => finding.label === "rate_limit")).toBe(true)
		expect(failed.turnHealth).toEqual(["clean", "failure"])
	})

	it("tells the context story as prompt growth across the session's calls", () => {
		const failed = report(
			twoTurns([
				llmSpan({
					spanId: "l-ctx",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "prompt is too long",
					genAi: {
						conversationId: "t2",
						errorType: "context_length_exceeded",
						usageInputTokens: 190_000,
					},
				}),
			]),
		)

		expect(failed.findings[0]!.detail).toBe(
			"prompt grew 1.0K → 190.0K tokens across the session",
		)
	})

	it("groups a tool's failures into one finding, counted, with the error text", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 20 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-1",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					toolName: "run_tests",
					statusCode: "Error",
					statusMessage: "exit 1",
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-2",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + 4 * SECOND,
					durationMs: SECOND,
					toolName: "run_tests",
					statusCode: "Error",
					statusMessage: "exit 1",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		// The last turn's root closed cleanly, so the session completed — with the
		// failures on record.
		expect(result.verdict.status).toBe("attention")
		const finding = result.findings.find((entry) => entry.label === "error · run_tests")!
		expect(finding.severity).toBe("failure")
		expect(finding.count).toBe(2)
		expect(finding.detail).toBe("exit 1")
		expect(finding.spanId).toBe("t-1")
	})

	// The shape Maple's own agent emits: a failed tool call is a VALUE on an Ok
	// span — `error.type: tool_error`, the message in `gen_ai.tool.call.result`,
	// and no status message at all.
	it("reads the error from the tool call's recorded result when status says nothing", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				toolSpan({
					spanId: "t-silent",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					toolName: "query_data",
					genAi: {
						conversationId: "t2",
						errorType: "tool_error",
						toolCallResult: "Query failed: unknown table trace_spans",
					},
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "tool_error · query_data")!
		expect(finding.detail).toBe("Query failed: unknown table trace_spans")
	})

	it("digs a wrapped error message out of a structured tool result", () => {
		const result = report(
			twoTurns([
				toolSpan({
					spanId: "t-wrapped",
					startMs: 5 * MINUTE,
					durationMs: SECOND,
					toolName: "query_data",
					genAi: {
						conversationId: "t2",
						errorType: "tool_error",
						toolCallResult: { isError: true, content: [{ type: "text", text: "shard 3 is locked" }] },
					},
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "tool_error · query_data")!
		expect(finding.detail).toBe("shard 3 is locked")
	})

	it("marks a recovered rate limit as an anomaly, not a failure", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				llmSpan({
					spanId: "l-429",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					statusCode: "Error",
					statusMessage: "429 Too Many Requests",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		expect(result.verdict.status).toBe("attention")
		const finding = result.findings.find((entry) => entry.label === "rate_limit")!
		expect(finding.severity).toBe("anomaly")
		expect(result.turnHealth).toEqual(["clean", "anomaly"])
	})

	it("flags a cut-off reply once, at the deepest span that said so", () => {
		const result = report(
			twoTurns([
				// The framework copies the model call's finish reason onto the agent
				// span wrapping it: one truncation, not two.
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 10 * SECOND,
					genAi: { conversationId: "t2", responseFinishReasons: ["length"] },
				}),
				llmSpan({
					spanId: "l-cut",
					parentSpanId: "a2",
					startMs: 5 * MINUTE + SECOND,
					durationMs: SECOND,
					genAi: { conversationId: "t2", responseFinishReasons: ["length"] },
				}),
			]),
		)

		const finding = result.findings.find((entry) => entry.label === "stop length")!
		expect(finding.count).toBe(1)
		expect(finding.spanId).toBe("l-cut")
		expect(finding.severity).toBe("anomaly")
	})

	it("flags the same tool called eight times within one turn, and not seven", () => {
		const callsOf = (count: number) =>
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 60 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				...Array.from({ length: count }, (_, index) =>
					toolSpan({
						spanId: `loop-${index}`,
						parentSpanId: "a2",
						startMs: 5 * MINUTE + index * SECOND,
						durationMs: 500,
						toolName: "search",
						genAi: { conversationId: "t2" },
					}),
				),
			])

		const flagged = report(callsOf(8)).findings.find((entry) => entry.label === "search")
		expect(flagged?.detail).toBe("called 8× within one turn")
		expect(flagged?.spanId).toBe("loop-0")

		expect(report(callsOf(7)).findings).toEqual([])
	})

	it("flags a stall inside a turn, never the pause between turns", () => {
		const result = report(
			twoTurns([
				agentSpan({
					spanId: "a2",
					startMs: 5 * MINUTE,
					durationMs: 2 * SECOND,
					genAi: { conversationId: "t2" },
				}),
				// 58s hole inside turn 2, after the anchor closed.
				toolSpan({
					spanId: "t-late",
					startMs: 6 * MINUTE,
					durationMs: SECOND,
					toolName: "read_file",
					genAi: { conversationId: "t2" },
				}),
			]),
		)

		const stall = result.findings.find((entry) => entry.label.startsWith("idle"))!
		expect(stall.label).toBe("idle 58s")
		expect(stall.turnText).toBe("Turn 2")
		// The five-minute pause between the turns is the user thinking: no finding.
		expect(result.findings.filter((entry) => entry.label.startsWith("idle"))).toHaveLength(1)
	})
})
