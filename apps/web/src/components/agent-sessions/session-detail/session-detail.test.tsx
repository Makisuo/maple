// @vitest-environment jsdom
// TEST-SEAM: jsdom reports every element as zero-sized, so the virtualizer would
// render no rows at all; the layout globals below are stubbed for that reason
// alone. Router navigation is stubbed to a plain anchor — these are rendering
// tests, and mounting a router would only add a second thing that can fail.

import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-fixtures"
import { buildSessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { SessionHeader } from "./session-header"
import { SessionWaterfall } from "./session-waterfall"

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		className,
		style,
	}: {
		children: React.ReactNode
		className?: string
		style?: React.CSSProperties
	}) => (
		<a className={className} style={style}>
			{children}
		</a>
	),
}))

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	// The virtualizer sizes its viewport from offsetWidth/offsetHeight, which
	// jsdom reports as 0 — leaving it convinced no row is on screen.
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 })
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 900 })
})

afterEach(cleanup)

const SECOND = 1000
const MINUTE = 60 * SECOND

// Two turns split by four minutes of a human thinking, a parallel pair of tool
// calls, and a tool that failed — the shape the page exists to show.
const spans = [
	agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 40 * SECOND }),
	llmSpan({
		spanId: "llm-1",
		parentSpanId: "agent-1",
		startMs: SECOND,
		durationMs: 8 * SECOND,
		model: "claude-sonnet-4-5",
		tokens: [40_000, 0, 0, 600, 0],
		ttftSeconds: 1.4,
		genAi: { inputMessages: userMessages("fix the webhook retry backoff") },
	}),
	toolSpan({
		spanId: "tool-1",
		parentSpanId: "agent-1",
		startMs: 10 * SECOND,
		durationMs: SECOND,
		toolName: "read_file",
	}),
	toolSpan({
		spanId: "tool-2",
		parentSpanId: "agent-1",
		startMs: 10 * SECOND,
		durationMs: 2 * SECOND,
		toolName: "grep_repo",
	}),
	toolSpan({
		spanId: "tool-3",
		parentSpanId: "agent-1",
		startMs: 14 * SECOND,
		durationMs: 20 * SECOND,
		toolName: "run_tests",
		statusCode: "Error",
		statusMessage: "exit 1",
	}),
	makeSpan({
		spanId: "http-1",
		parentSpanId: "agent-1",
		startMs: 2 * SECOND,
		durationMs: 200,
		spanName: "GET /repo/file",
		isAiSpan: false,
	}),
	agentSpan({ spanId: "agent-2", startMs: 5 * MINUTE, durationMs: 12 * SECOND }),
	llmSpan({
		spanId: "llm-2",
		parentSpanId: "agent-2",
		startMs: 5 * MINUTE + SECOND,
		durationMs: 10 * SECOND,
		model: "claude-sonnet-4-5",
		tokens: [90_000, 0, 0, 1200, 300],
	}),
]

const turns = buildSessionTurns(spans)
const summary = buildSessionSummary(spans, turns, Date.UTC(2026, 7, 19, 18, 0, 0))

describe("SessionHeader", () => {
	it("states the session's duration, status and work", () => {
		render(<SessionHeader summary={summary} sessionId="conv_8f14e45f2a1c" fallbackTitle="fallback" />)

		// Title comes from the captured user message, not the fallback.
		expect(screen.getByRole("heading").textContent).toBe("fix the webhook retry backoff")
		expect(screen.getByText("COMPLETED")).toBeTruthy()
		expect(screen.getByText("conv_8f14e45f2a1c")).toBeTruthy()
		// 5m 12s wall clock, 4m 20s of it idle.
		expect(screen.getByText("5m 12s")).toBeTruthy()
		expect(screen.getByText("Idle · awaiting user")).toBeTruthy()
		expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy()
	})

	it("prices the session against the list-price table", () => {
		render(<SessionHeader summary={summary} sessionId="conv_1" fallbackTitle="fallback" />)

		// 130K input at $3/MTok + 2.1K output/reasoning at $15/MTok.
		expect(screen.getByText("$0.42")).toBeTruthy()
		expect(screen.queryByText(/unpriced/)).toBeNull()
	})

	it("falls back to the agent's name when no message was captured", () => {
		const quiet = buildSessionSummary(
			[agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND })],
			buildSessionTurns([agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND })]),
			Date.UTC(2026, 7, 19, 18, 0, 0),
		)
		render(<SessionHeader summary={quiet} sessionId="conv_1" fallbackTitle="billing-agent · Aug 19" />)

		expect(screen.getByRole("heading").textContent).toBe("billing-agent · Aug 19")
	})
})

describe("SessionWaterfall", () => {
	it("groups spans under their turn and marks the idle between them", () => {
		render(
			<SessionWaterfall
				turns={turns}
				summary={summary}
				query=""
				agentSpansOnly
				collapseIdle
			/>,
		)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText(/“fix the webhook retry backoff”/)).toBeTruthy()
		expect(screen.getByText(/idle 4m 20s · awaiting user/)).toBeTruthy()
		expect(screen.getByText(/of idle removed across 1 gap/)).toBeTruthy()
	})

	it("hides the app's own spans unless asked for them", () => {
		const view = render(
			<SessionWaterfall turns={turns} summary={summary} query="" agentSpansOnly collapseIdle />,
		)
		expect(screen.queryByText("GET /repo/file")).toBeNull()

		view.rerender(
			<SessionWaterfall
				turns={turns}
				summary={summary}
				query=""
				agentSpansOnly={false}
				collapseIdle
			/>,
		)
		expect(screen.getByText("GET /repo/file")).toBeTruthy()
	})

	it("narrows to the spans that match the filter", () => {
		render(
			<SessionWaterfall
				turns={turns}
				summary={summary}
				query="run_tests"
				agentSpansOnly
				collapseIdle
			/>,
		)

		expect(screen.getAllByText(/run_tests/).length).toBeGreaterThan(0)
		expect(screen.queryByText("Turn 2")).toBeNull()
	})
})

describe("SessionFlow", () => {
	it("lays out one lane per turn", () => {
		render(<SessionFlow turns={turns} mergeRepeats={false} />)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText("read_file")).toBeTruthy()
		expect(screen.getByText("grep_repo")).toBeTruthy()
	})

	it("merges a run of identical calls into one counted node", () => {
		const repeated = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			toolSpan({ spanId: "t1", parentSpanId: "agent", startMs: SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "t2", parentSpanId: "agent", startMs: 3 * SECOND, durationMs: SECOND }),
			toolSpan({ spanId: "t3", parentSpanId: "agent", startMs: 5 * SECOND, durationMs: SECOND }),
		]
		const view = render(
			<SessionFlow turns={buildSessionTurns(repeated)} mergeRepeats={false} />,
		)
		expect(screen.getAllByText("read_file")).toHaveLength(3)

		view.rerender(<SessionFlow turns={buildSessionTurns(repeated)} mergeRepeats />)
		const merged = screen.getByText("read_file").closest("a")
		expect(merged).not.toBeNull()
		expect(within(merged!).getByText("×3")).toBeTruthy()
	})
})
