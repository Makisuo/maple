// @vitest-environment jsdom
// TEST-SEAM: the virtualizer sizes its viewport from offsetWidth/offsetHeight,
// which jsdom reports as 0 — leaving it convinced no row is on screen, so the
// two layout globals below are stubbed for that reason alone. Router navigation
// is stubbed to a plain anchor — these are rendering tests, and mounting a
// router would only add a second thing that can fail.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { AiSessionSpan } from "@maple/domain/http"
import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-fixtures"
import { buildSessionSummary, type SessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns, type SessionTurn } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { SessionHeader } from "./session-header"
import { SessionViews } from "./session-views"
import { SessionWaterfall } from "./session-waterfall"

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		className,
		style,
		title,
	}: {
		children: React.ReactNode
		className?: string
		style?: React.CSSProperties
		title?: string
	}) => (
		<a className={className} style={style} title={title}>
			{children}
		</a>
	),
}))

beforeAll(() => {
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

const NOW = Date.UTC(2026, 7, 19, 18, 0, 0)
const turns = buildSessionTurns(spans)
const summary = buildSessionSummary(spans, turns, NOW)

// The other common shape: one agent span, no captured message, no usage
// reported, and no human to wait on.
const quietSpans = [agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND })]
const quiet = buildSessionSummary(quietSpans, buildSessionTurns(quietSpans), NOW)

const gatewaySpans = [
	agentSpan({ spanId: "g-agent", startMs: 0, durationMs: 4 * SECOND }),
	llmSpan({
		spanId: "g-llm",
		parentSpanId: "g-agent",
		startMs: SECOND,
		durationMs: 2 * SECOND,
		model: "openrouter/openai/gpt-4o-mini",
		tokens: [1000, 0, 0, 100, 0],
	}),
]

const EMPTY = new Set<string>()
const noop = () => {}

/** The waterfall's expansion state lives in SessionViews, so the tests supply it. */
function Waterfall(props: {
	turns?: readonly SessionTurn[]
	summary?: SessionSummary
	query?: string
	agentSpansOnly?: boolean
	collapseIdle?: boolean
	collapsedTurns?: ReadonlySet<string>
	onToggleTurn?: (turnId: string) => void
}) {
	return (
		<SessionWaterfall
			turns={props.turns ?? turns}
			summary={props.summary ?? summary}
			query={props.query ?? ""}
			agentSpansOnly={props.agentSpansOnly ?? true}
			collapseIdle={props.collapseIdle ?? true}
			collapsedTurns={props.collapsedTurns ?? EMPTY}
			onToggleTurn={props.onToggleTurn ?? noop}
			expandedGaps={EMPTY}
			onToggleGap={noop}
		/>
	)
}

function Flow(props: {
	turns?: readonly SessionTurn[]
	mergeRepeats?: boolean
	query?: string
	agentSpansOnly?: boolean
}) {
	return (
		<SessionFlow
			turns={props.turns ?? turns}
			mergeRepeats={props.mergeRepeats ?? false}
			query={props.query ?? ""}
			agentSpansOnly={props.agentSpansOnly ?? true}
			zoom={1}
			onZoomChange={noop}
		/>
	)
}

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
		render(<SessionHeader summary={quiet} sessionId="conv_1" fallbackTitle="billing-agent · Aug 19" />)

		expect(screen.getByRole("heading").textContent).toBe("billing-agent · Aug 19")
	})

	it("drops the wall-clock twin and its toggle when nothing waited on a human", () => {
		render(<SessionHeader summary={quiet} sessionId="conv_1" fallbackTitle="fallback" />)

		expect(screen.getByText("wall clock")).toBeTruthy()
		expect(screen.queryByText(/active ·/)).toBeNull()
		expect(screen.queryByText("Active only")).toBeNull()
	})

	it("says no usage was reported rather than pricing a session at zero", () => {
		render(<SessionHeader summary={quiet} sessionId="conv_1" fallbackTitle="fallback" />)

		// Both the token breakdown and the spend it derives from.
		expect(screen.getAllByText("no token usage reported")).toHaveLength(2)
		expect(screen.queryByText("$0.00")).toBeNull()
	})

	it("shows the last path segment of a gateway model id, full id in the title", () => {
		const gateway = buildSessionSummary(gatewaySpans, buildSessionTurns(gatewaySpans), NOW)
		render(<SessionHeader summary={gateway} sessionId="conv_1" fallbackTitle="fallback" />)

		const name = screen.getByText("gpt-4o-mini")
		expect(name.getAttribute("title")).toBe("openrouter/openai/gpt-4o-mini")
	})
})

describe("SessionWaterfall", () => {
	it("groups spans under their turn and marks the idle between them", () => {
		render(<Waterfall />)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText(/“fix the webhook retry backoff”/)).toBeTruthy()
		expect(screen.getByText(/idle 4m 20s · awaiting user/)).toBeTruthy()
		expect(screen.getByText(/of idle removed across 1 gap/)).toBeTruthy()
	})

	it("steps the ruler in clock values rather than fifths of the total", () => {
		// 52s of active time: 15s steps, not the 10.4s an even division would give.
		render(<Waterfall />)

		expect(screen.getByText("15s")).toBeTruthy()
		expect(screen.getByText("45s")).toBeTruthy()
	})

	it("hides the app's own spans unless asked for them", () => {
		const view = render(<Waterfall />)
		expect(screen.queryByText("GET /repo/file")).toBeNull()

		view.rerender(<Waterfall agentSpansOnly={false} />)
		expect(screen.getByText("GET /repo/file")).toBeTruthy()
	})

	it("narrows to the spans that match the filter", () => {
		render(<Waterfall query="run_tests" />)

		expect(screen.getAllByText(/run_tests/).length).toBeGreaterThan(0)
		expect(screen.queryByText("Turn 2")).toBeNull()
	})

	it("renders the empty state, and no orphan idle rows, when nothing matches", () => {
		render(<Waterfall query="no-such-span" />)

		expect(screen.getByText("No spans match this filter.")).toBeTruthy()
		expect(screen.queryByText(/awaiting user/)).toBeNull()
	})

	it("draws a trace rule only where a trace bands more than one turn", () => {
		// Both turns share trace-1, so one rule opens the band.
		render(<Waterfall />)

		expect(screen.getByText("turns 1–2")).toBeTruthy()
		expect(screen.getByText("Trace trace-1")).toBeTruthy()
	})

	it("puts a one-turn trace in that turn's header instead of a rule row", () => {
		render(<Waterfall turns={crossTurns} summary={crossSummary} />)

		expect(screen.queryByText(/^turns? \d/)).toBeNull()
		expect(screen.getByText("Trace trace-1")).toBeTruthy()
		expect(screen.getByText("Trace trace-2")).toBeTruthy()
	})

	it("moves a trace link off a fully filtered-out turn instead of leaving it dangling", () => {
		render(<Waterfall turns={crossTurns} summary={crossSummary} query="run_tests" />)

		expect(screen.queryByText(/Trace trace-1/)).toBeNull()
		expect(screen.getByText(/Trace trace-2/)).toBeTruthy()
	})

	it("places an idle gap inside the turn it interrupts", () => {
		const view = render(<Waterfall turns={midTurnGapTurns} summary={midTurnGapSummary} />)

		const text = view.container.textContent ?? ""
		expect(text.indexOf("idle 1m 0s")).toBeGreaterThan(text.indexOf("read_file"))
		expect(text.indexOf("idle 1m 0s")).toBeLessThan(text.indexOf("run_tests"))
	})

	it("counts only the spans the filter shows on a collapsed turn", () => {
		const onToggleTurn = vi.fn()
		render(<Waterfall collapsedTurns={new Set([turns[0]!.id])} onToggleTurn={onToggleTurn} />)

		// Six spans in the turn, one an app HTTP span the agent-spans-only filter hides.
		expect(screen.getByText("5 spans")).toBeTruthy()

		fireEvent.click(screen.getByText("Turn 1"))
		expect(onToggleTurn).toHaveBeenCalledWith(turns[0]!.id)
	})

	it("never repeats in MODEL / TARGET what the span name already says", () => {
		render(<Waterfall turns={targetTurns} summary={targetSummary} />)

		// An agent span's target is the agent, which the row already names.
		const agentRow = screen.getByText("invoke_agent").closest("a")!
		expect(within(agentRow).getByText("billing-agent")).toBeTruthy()
		expect(within(agentRow).getAllByText("—")).toHaveLength(2)

		// A model already in the span name is not printed a second time.
		expect(within(screen.getByText("chat gpt-5").closest("a")!).queryByText("gpt-5")).toBeNull()

		// A gateway-prefixed model shows its last segment, full id in the title.
		const modelCell = within(screen.getByText("chat").closest("a")!).getByText("gpt-4o-mini")
		expect(modelCell.getAttribute("title")).toBe("openrouter/openai/gpt-4o-mini")

		// A tool row's target is what the tool acted on, never the tool's own name.
		const toolRow = screen.getByText("execute_tool").closest("a")!
		expect(within(toolRow).getByText("src/webhooks/retry.ts")).toBeTruthy()
		expect(within(toolRow).getAllByText("read_file")).toHaveLength(1)
	})

	it("marks a delegation as a subagent, and a framework step not at all", () => {
		render(<Waterfall turns={delegationTurns} summary={delegationSummary} />)

		expect(screen.getAllByText("Subagent")).toHaveLength(1)
		const delegated = screen.getByText("agent.delegate").closest("a")!
		expect(within(delegated).getByText("Subagent")).toBeTruthy()
	})

	it("marks the errored call that was sent again as a retry", () => {
		render(<Waterfall turns={retryTurns} summary={retrySummary} />)

		expect(screen.getAllByText("Retry")).toHaveLength(1)
		const failed = screen.getByText("429").closest("a")!
		expect(within(failed).getByText("Retry")).toBeTruthy()
	})
})

describe("SessionFlow", () => {
	it("lays out one lane per turn", () => {
		render(<Flow />)

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
		const view = render(<Flow turns={buildSessionTurns(repeated)} />)
		expect(screen.getAllByText("read_file")).toHaveLength(3)

		view.rerender(<Flow turns={buildSessionTurns(repeated)} mergeRepeats />)
		const merged = screen.getByText("read_file").closest("a")
		expect(merged).not.toBeNull()
		expect(within(merged!).getByText("×3")).toBeTruthy()
	})

	it("skips the container that only wraps the call below it", () => {
		const nested = [
			agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
			agentSpan({
				spanId: "a2",
				parentSpanId: "a1",
				startMs: SECOND,
				durationMs: 5 * SECOND,
				spanName: "call_llm",
			}),
			llmSpan({
				spanId: "l1",
				parentSpanId: "a2",
				startMs: 2 * SECOND,
				durationMs: 2 * SECOND,
				spanName: "generate_content",
				model: "gpt-5",
			}),
		]
		render(<Flow turns={buildSessionTurns(nested)} />)

		expect(screen.getByText("invoke_agent")).toBeTruthy()
		expect(screen.getByText("generate_content")).toBeTruthy()
		expect(screen.queryByText("call_llm")).toBeNull()
	})

	it("wraps a long turn into a block instead of one endless ribbon", () => {
		const long = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 40 * SECOND }),
			...Array.from({ length: 9 }, (_, index) =>
				toolSpan({
					spanId: `t${index}`,
					parentSpanId: "agent",
					startMs: (index + 1) * 2 * SECOND,
					durationMs: SECOND,
					toolName: `tool_${index}`,
				}),
			),
		]
		const view = render(<Flow turns={buildSessionTurns(long)} />)

		const cards = [...view.container.querySelectorAll("a")]
		expect(cards).toHaveLength(10)
		expect(cards[8]!.style.left).toBe(cards[0]!.style.left)
		expect(Number.parseFloat(cards[8]!.style.top)).toBeGreaterThan(Number.parseFloat(cards[0]!.style.top))
	})
})

describe("SessionViews", () => {
	it("counts what is on screen, in the singular when there is one of it", () => {
		render(<SessionViews turns={crossTurns} summary={crossSummary} />)

		expect(screen.getByText(/^4 spans · 2 turns · 2 traces$/)).toBeTruthy()

		fireEvent.change(screen.getByPlaceholderText("Filter spans"), {
			target: { value: "run_tests" },
		})
		expect(screen.getByText(/^1 of 4 spans · 2 turns · 2 traces$/)).toBeTruthy()
	})
})

/* -------------------------------------------------------------------------- */
/* Fixtures used by a single test                                             */
/* -------------------------------------------------------------------------- */

function sessionOf(input: readonly AiSessionSpan[]) {
	const sessionTurns = buildSessionTurns(input)
	return { turns: sessionTurns, summary: buildSessionSummary(input, sessionTurns, NOW) }
}

/** Two turns, one trace each. */
const crossTrace = [
	agentSpan({ spanId: "t1-agent", startMs: 0, durationMs: 10 * SECOND }),
	toolSpan({
		spanId: "t1-tool",
		parentSpanId: "t1-agent",
		startMs: SECOND,
		durationMs: SECOND,
		toolName: "read_file",
	}),
	agentSpan({ spanId: "t2-agent", traceId: "trace-2", startMs: 20 * SECOND, durationMs: 30 * SECOND }),
	toolSpan({
		spanId: "t2-tool",
		traceId: "trace-2",
		parentSpanId: "t2-agent",
		startMs: 21 * SECOND,
		durationMs: 20 * SECOND,
		toolName: "run_tests",
	}),
]
const { turns: crossTurns, summary: crossSummary } = sessionOf(crossTrace)

/** One turn with a minute of nothing between its first and last span. */
const { turns: midTurnGapTurns, summary: midTurnGapSummary } = sessionOf([
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 2 * SECOND }),
	toolSpan({ spanId: "t1", parentSpanId: "a1", startMs: 500, durationMs: 500, toolName: "read_file" }),
	toolSpan({ spanId: "t2", startMs: 62 * SECOND, durationMs: SECOND, toolName: "run_tests" }),
])

const { turns: targetTurns, summary: targetSummary } = sessionOf([
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND }),
	llmSpan({
		spanId: "l1",
		parentSpanId: "a1",
		startMs: SECOND,
		durationMs: SECOND,
		spanName: "chat gpt-5",
		model: "gpt-5",
	}),
	llmSpan({
		spanId: "l2",
		parentSpanId: "a1",
		startMs: 3 * SECOND,
		durationMs: SECOND,
		model: "openrouter/openai/gpt-4o-mini",
	}),
	toolSpan({
		spanId: "t1",
		parentSpanId: "a1",
		startMs: 5 * SECOND,
		durationMs: SECOND,
		toolName: "read_file",
		genAi: { toolCallArguments: { path: "src/webhooks/retry.ts" } },
	}),
])

const { turns: delegationTurns, summary: delegationSummary } = sessionOf([
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 10 * SECOND, agentName: "billing-agent" }),
	agentSpan({
		spanId: "a2",
		parentSpanId: "a1",
		startMs: SECOND,
		durationMs: 5 * SECOND,
		spanName: "agent.step",
		agentName: "billing-agent",
	}),
	agentSpan({
		spanId: "a3",
		parentSpanId: "a1",
		startMs: 7 * SECOND,
		durationMs: 2 * SECOND,
		spanName: "agent.delegate",
		agentName: "test-runner",
	}),
])

const { turns: retryTurns, summary: retrySummary } = sessionOf([
	agentSpan({ spanId: "a1", startMs: 0, durationMs: 20 * SECOND }),
	llmSpan({
		spanId: "llm-429",
		parentSpanId: "a1",
		startMs: SECOND,
		durationMs: SECOND,
		model: "gpt-5",
		statusCode: "Error",
		statusMessage: "429 rate limit",
		genAi: { errorType: "429" },
	}),
	llmSpan({
		spanId: "llm-ok",
		parentSpanId: "a1",
		startMs: 5 * SECOND,
		durationMs: 2 * SECOND,
		model: "gpt-5",
		tokens: [100, 0, 0, 50, 0],
	}),
])
