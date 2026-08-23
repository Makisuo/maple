// @vitest-environment jsdom
// TEST-SEAM: the virtualizer sizes its viewport from offsetWidth/offsetHeight,
// which jsdom reports as 0 — leaving it convinced no row is on screen, so the
// two layout globals below are stubbed for that reason alone. Nothing here
// navigates: trace and span clicks raise `onOpenTrace` for the page to handle,
// so no router needs mounting.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { AiSessionSpan } from "@maple/domain/http"
import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-test-support"
import { buildSessionSummary, type SessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns, type SessionTurn } from "@/lib/agent-sessions/session-turns"
import type { TraceSelection } from "@/lib/agent-sessions/span-filters"
import { SessionFlow } from "./session-flow"
import { SessionHeader } from "./session-header"
import { SessionViews } from "./session-views"
import { SessionWaterfall } from "./session-waterfall"

beforeAll(() => {
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 })
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 900 })
})

afterAll(() => {
	Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth")
	Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
})

afterEach(cleanup)

const SECOND = 1000
const MINUTE = 60 * SECOND

function sessionOf(input: readonly AiSessionSpan[]) {
	const sessionTurns = buildSessionTurns(input)
	return { turns: sessionTurns, summary: buildSessionSummary({ spans: input, turns: sessionTurns }) }
}

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
		ttftSeconds: 1.4,
		genAi: {
			usageInputTokens: 40_000,
			usageOutputTokens: 600,
			inputMessages: userMessages("fix the webhook retry backoff"),
		},
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
		genAi: { usageInputTokens: 90_000, usageOutputTokens: 1200, usageReasoningOutputTokens: 300 },
	}),
]

const { turns, summary } = sessionOf(spans)

// The other common shape: one agent span, no captured message, no usage
// reported, and no human to wait on.
const { summary: quiet } = sessionOf([agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND })])

const { summary: gateway } = sessionOf([
	agentSpan({ spanId: "g-agent", startMs: 0, durationMs: 4 * SECOND }),
	llmSpan({
		spanId: "g-llm",
		parentSpanId: "g-agent",
		startMs: SECOND,
		durationMs: 2 * SECOND,
		model: "openrouter/openai/gpt-4o-mini",
		genAi: { usageInputTokens: 1000, usageOutputTokens: 100 },
	}),
])

/**
 * Aggregate-only usage: one long-lived span reports the whole session's tokens
 * across both turns, and the model calls beneath it report none.
 */
const { turns: aggregateTurns, summary: aggregateSummary } = sessionOf([
	agentSpan({
		spanId: "agg-root",
		startMs: 0,
		durationMs: 5 * MINUTE + 10 * SECOND,
		genAi: { usageInputTokens: 5000, usageOutputTokens: 500 },
	}),
	llmSpan({
		spanId: "agg-1",
		parentSpanId: "agg-root",
		startMs: SECOND,
		durationMs: SECOND,
		model: "claude-sonnet-4-5",
		genAi: { conversationId: "turn-1" },
	}),
	llmSpan({
		spanId: "agg-2",
		parentSpanId: "agg-root",
		startMs: 5 * MINUTE,
		durationMs: 2 * SECOND,
		model: "claude-sonnet-4-5",
		genAi: { conversationId: "turn-2" },
	}),
])

/** Two turns, one trace each. */
const { turns: crossTurns, summary: crossSummary } = sessionOf([
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
])

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

/** No agent span and no conversation id: turns fall back to one per trace. */
const { turns: segmentTurns, summary: segmentSummary } = sessionOf([
	toolSpan({ spanId: "s1", startMs: 0, durationMs: SECOND, toolName: "read_file" }),
	toolSpan({
		spanId: "s2",
		traceId: "trace-2",
		startMs: 2 * SECOND,
		durationMs: SECOND,
		toolName: "run_tests",
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
	selection?: TraceSelection
	onOpenTrace?: (target: TraceSelection) => void
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
			selection={props.selection}
			onOpenTrace={props.onOpenTrace ?? noop}
		/>
	)
}

function Flow(props: {
	turns?: readonly SessionTurn[]
	mergeRepeats?: boolean
	query?: string
	agentSpansOnly?: boolean
	onOpenTrace?: (target: TraceSelection) => void
}) {
	return (
		<SessionFlow
			turns={props.turns ?? turns}
			mergeRepeats={props.mergeRepeats ?? false}
			query={props.query ?? ""}
			agentSpansOnly={props.agentSpansOnly ?? true}
			zoom={1}
			onZoomChange={noop}
			selection={undefined}
			onOpenTrace={props.onOpenTrace ?? noop}
		/>
	)
}

describe("SessionHeader", () => {
	it("states the session's duration and work", () => {
		render(<SessionHeader summary={summary} />)

		// 5m 12s wall clock, 4m 20s of it idle.
		expect(screen.getByText("5m 12s")).toBeTruthy()
		expect(screen.getByText("52s active · 83% idle")).toBeTruthy()
		expect(screen.getByText("Idle")).toBeTruthy()
		expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy()
	})

	it("says no cost was reported rather than pricing tokens itself", () => {
		render(<SessionHeader summary={summary} />)

		expect(screen.getByText("no cost reported")).toBeTruthy()
		expect(screen.queryByText(/^\$/)).toBeNull()
	})

	it("contrasts active against wall clock only when something waited", () => {
		render(<SessionHeader summary={quiet} />)

		expect(screen.getByText("wall clock")).toBeTruthy()
		expect(screen.queryByText(/active/)).toBeNull()
	})

	it("says no usage was reported rather than pricing a session at zero", () => {
		render(<SessionHeader summary={quiet} />)

		expect(screen.getByText("no token usage reported")).toBeTruthy()
		expect(screen.queryByText("$0.00")).toBeNull()
	})

	// Regression: `$0.00` beside a real token count read as "measured, and it was
	// free" rather than "too small to show".
	it("says a sub-cent session is under a cent rather than zero", () => {
		const tiny = sessionOf([
			agentSpan({ spanId: "tiny-agent", startMs: 0, durationMs: SECOND }),
			llmSpan({
				spanId: "tiny-llm",
				parentSpanId: "tiny-agent",
				startMs: 0,
				durationMs: SECOND,
				model: "claude-haiku-4-5",
				genAi: { usageInputTokens: 100, usageOutputTokens: 10, usageCost: 0.0004 },
			}),
		])
		render(<SessionHeader summary={tiny.summary} />)

		expect(screen.getByText("<$0.01")).toBeTruthy()
		expect(screen.queryByText("$0.00")).toBeNull()
	})

	// Regression: the column sliced to four models and said nothing about the
	// rest, so a nine-model session lost five of them with no trace.
	it("counts the models the column could not fit", () => {
		const many = sessionOf([
			agentSpan({ spanId: "m-agent", startMs: 0, durationMs: 10 * SECOND }),
			...Array.from({ length: 6 }, (_, index) =>
				llmSpan({
					spanId: `m-llm-${index}`,
					parentSpanId: "m-agent",
					startMs: index * SECOND,
					durationMs: SECOND,
					model: `model-${index}`,
					genAi: { usageInputTokens: 10, usageOutputTokens: 1 },
				}),
			),
		])
		render(<SessionHeader summary={many.summary} />)

		expect(screen.getByText(/^\+\d+ more$/)).toBeTruthy()
	})

	// The turns below print no tokens in this shape, so the column has to say why
	// rather than leave a reader to read the dashes as missing instrumentation.
	it("says a session-level total was reported once for the whole session", () => {
		render(<SessionHeader summary={aggregateSummary} />)

		expect(screen.getByText("5.5K")).toBeTruthy()
		expect(screen.getByText("Reported once for the whole session")).toBeTruthy()
	})

	it("says nothing about the reporting shape when the calls reported for themselves", () => {
		render(<SessionHeader summary={summary} />)

		expect(screen.queryByText(/Reported once/)).toBeNull()
	})

	it("shows the last path segment of a gateway model id, full id in the title", () => {
		render(<SessionHeader summary={gateway} />)

		const name = screen.getByText("gpt-4o-mini")
		expect(name.getAttribute("title")).toBe("openrouter/openai/gpt-4o-mini")
	})
})

describe("SessionWaterfall", () => {
	it("groups spans under their turn and marks the idle between them", () => {
		render(<Waterfall />)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText("fix the webhook retry backoff")).toBeTruthy()
		expect(screen.getByText("idle 4m 20s")).toBeTruthy()
		expect(screen.getByText(/of idle removed across 1 gap/)).toBeTruthy()
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
		expect(screen.queryByText(/^idle \d/)).toBeNull()
	})

	it("opens the trace pane, not the trace page, from a span click", () => {
		const onOpenTrace = vi.fn()
		render(<Waterfall onOpenTrace={onOpenTrace} />)

		fireEvent.click(screen.getByText("grep_repo"))
		expect(onOpenTrace).toHaveBeenCalledWith({ traceId: "trace-1", spanId: "tool-2" })
	})

	it("opens the trace pane on the whole trace from a turn's trace link", () => {
		const onOpenTrace = vi.fn()
		render(<Waterfall onOpenTrace={onOpenTrace} />)

		fireEvent.click(screen.getAllByText("Trace trace-1")[0]!)
		expect(onOpenTrace).toHaveBeenCalledWith({ traceId: "trace-1" })
	})

	it("marks the row of the span the pane is showing", () => {
		render(<Waterfall selection={{ traceId: "trace-1", spanId: "tool-2" }} />)

		const row = screen.getByText("grep_repo").closest("button")!
		expect(row.getAttribute("aria-current")).toBe("true")
	})

	it("names the trace on every turn header", () => {
		// Both turns share trace-1, and each says so on its own header.
		render(<Waterfall />)

		expect(screen.getAllByText("Trace trace-1")).toHaveLength(2)
	})

	it("names each turn's own trace when consecutive turns come from different ones", () => {
		render(<Waterfall turns={crossTurns} summary={crossSummary} />)

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

	it("names the model in MODEL even when the span name already says it", () => {
		render(<Waterfall turns={targetTurns} summary={targetSummary} />)

		const named = screen.getByText("chat gpt-5").closest("button")!
		expect(within(named).getByText("gpt-5")).toBeTruthy()
	})

	it("shortens a gateway model id in MODEL, with the full id in the title", () => {
		render(<Waterfall turns={targetTurns} summary={targetSummary} />)

		const modelCell = within(screen.getByText("chat").closest("button")!).getByText("gpt-4o-mini")
		expect(modelCell.getAttribute("title")).toBe("openrouter/openai/gpt-4o-mini")
	})

	it("names the agent on an agent row and leaves MODEL and TARGET empty", () => {
		render(<Waterfall turns={targetTurns} summary={targetSummary} />)

		const agentRow = screen.getByText("invoke_agent").closest("button")!
		expect(within(agentRow).getByText("billing-agent")).toBeTruthy()
		expect(within(agentRow).getAllByText("—")).toHaveLength(2)
	})

	it("makes a tool row's TARGET what the tool acted on, never the tool's own name", () => {
		render(<Waterfall turns={targetTurns} summary={targetSummary} />)

		const toolRow = screen.getByText("execute_tool").closest("button")!
		expect(within(toolRow).getByText("src/webhooks/retry.ts")).toBeTruthy()
		expect(within(toolRow).getAllByText("read_file")).toHaveLength(1)
	})

	it("splits a call's tokens into the same halves the header totals", () => {
		render(<Waterfall />)

		// 40,000 in and 600 out, cache buckets included in the prompt half exactly
		// as the session total counts them.
		expect(screen.getByText("40.0K → 600")).toBeTruthy()
	})

	// Regression: assignment is by start time, so a span reporting for the whole
	// session put every token on the turn it opened in and left the rest at zero.
	it("credits no turn with a total that was only reported for the session", () => {
		render(<Waterfall turns={aggregateTurns} summary={aggregateSummary} />)

		const turnOne = screen.getByText("Turn 1").closest("div")!
		expect(within(turnOne).getByText("—")).toBeTruthy()
		expect(screen.queryByText("5.5K")).toBeNull()
	})

	it("calls a turn a segment when it is only a trace, not a captured exchange", () => {
		render(<Waterfall turns={segmentTurns} summary={segmentSummary} />)

		expect(screen.getByText("Segment 1")).toBeTruthy()
		expect(screen.queryByText(/^Turn /)).toBeNull()
	})

	it("marks a delegation as a subagent, and a framework step not at all", () => {
		render(<Waterfall turns={delegationTurns} summary={delegationSummary} />)

		const delegated = screen.getByText("agent.delegate").closest("button")!
		expect(within(delegated).getByText("Subagent")).toBeTruthy()

		const step = screen.getByText("agent.step").closest("button")!
		expect(within(step).queryByText("Subagent")).toBeNull()
	})
})

describe("SessionFlow", () => {
	// The shape the Flow view exists to survive: a framework wrapping one model
	// call in an extra agent span, so the surviving leaf's `parentSpanId` names a
	// span that never gets a node.
	const nestedFramework = [
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

	/** Node cards are the positioned buttons; the zoom controls carry no style. */
	const cardsOf = (container: HTMLElement) => [
		...container.querySelectorAll<HTMLButtonElement>("button[style]"),
	]

	it("lays out one lane per turn", () => {
		render(<Flow />)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText("read_file")).toBeTruthy()
		expect(screen.getByText("grep_repo")).toBeTruthy()
	})

	it("opens the trace pane from a node click", () => {
		const onOpenTrace = vi.fn()
		render(<Flow onOpenTrace={onOpenTrace} />)

		fireEvent.click(screen.getByText("grep_repo"))
		expect(onOpenTrace).toHaveBeenCalledWith({ traceId: "trace-1", spanId: "tool-2" })
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
		const merged = screen.getByText("read_file").closest("button")
		expect(merged).not.toBeNull()
		expect(within(merged!).getByText("×3")).toBeTruthy()
	})

	it("reports a merged node as wall clock and says how many of it failed", () => {
		// Three parallel 400-600ms calls, one of them failed. The node has to report
		// the 600ms the run occupied rather than the 1.5s its durations add up to,
		// and the error text has to come from the member the red border is about.
		const parallel = [
			agentSpan({ spanId: "agent", startMs: 0, durationMs: 20 * SECOND }),
			toolSpan({ spanId: "p1", parentSpanId: "agent", startMs: SECOND, durationMs: 400 }),
			toolSpan({
				spanId: "p2",
				parentSpanId: "agent",
				startMs: SECOND,
				durationMs: 500,
				statusCode: "Error",
				statusMessage: "timeout",
			}),
			toolSpan({ spanId: "p3", parentSpanId: "agent", startMs: SECOND, durationMs: 600 }),
		]
		render(<Flow turns={buildSessionTurns(parallel)} mergeRepeats />)

		const merged = screen.getByText("read_file").closest("button")
		expect(within(merged!).getByText("×3")).toBeTruthy()
		expect(within(merged!).getByText("timeout · 600.0ms · 1 failed")).toBeTruthy()
		expect(screen.queryByText(/1\.50s/)).toBeNull()
	})

	it("skips the container that only wraps the call below it", () => {
		render(<Flow turns={buildSessionTurns(nestedFramework)} />)

		expect(screen.getByText("invoke_agent")).toBeTruthy()
		expect(screen.getByText("generate_content")).toBeTruthy()
		expect(screen.queryByText("call_llm")).toBeNull()
	})

	it("still reads as a flow once that container is gone", () => {
		// The leaf's parent was dropped, so its column and its connector both come
		// from the nearest ancestor that survived — the anchor. Without that the
		// two cards pile into one column with nothing drawn between them.
		const view = render(<Flow turns={buildSessionTurns(nestedFramework)} />)

		const cards = cardsOf(view.container)
		expect(cards).toHaveLength(2)
		expect(Number.parseFloat(cards[1]!.style.left)).toBeGreaterThan(
			Number.parseFloat(cards[0]!.style.left),
		)
		expect(cards[1]!.style.top).toBe(cards[0]!.style.top)
		expect(view.container.querySelectorAll('[data-slot="flow-edges"] path')).toHaveLength(1)
	})

	it("draws one connector per parent/child pair, not per adjacent column", () => {
		// Four children of one anchor across three columns: four connectors from the
		// anchor, never the column-to-column cartesian product (which would pair the
		// two parallel tools with the tool after them).
		const view = render(<Flow />)

		const lanes = view.container.querySelectorAll('[data-slot="flow-edges"]')
		expect(lanes).toHaveLength(2)
		expect(lanes[0]!.querySelectorAll("path")).toHaveLength(4)
		expect(lanes[1]!.querySelectorAll("path")).toHaveLength(1)
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

		const cards = cardsOf(view.container)
		expect(cards).toHaveLength(10)
		expect(cards[8]!.style.left).toBe(cards[0]!.style.left)
		expect(Number.parseFloat(cards[8]!.style.top)).toBeGreaterThan(Number.parseFloat(cards[0]!.style.top))
	})
})

describe("SessionViews", () => {
	it("counts what is on screen, and narrows every count as the filter narrows it", () => {
		render(
			<SessionViews
				turns={crossTurns}
				summary={crossSummary}
				selection={undefined}
				onOpenTrace={noop}
			/>,
		)

		expect(screen.getByText(/^4 spans · 2 turns · 2 traces$/)).toBeTruthy()

		fireEvent.change(screen.getByPlaceholderText("Filter spans"), {
			target: { value: "run_tests" },
		})
		// The filter leaves one span, and with it one turn in one trace: the turn
		// whose spans all went is dropped from the waterfall too.
		expect(screen.getByText(/^1 of 4 spans · 1 of 2 turns · 1 of 2 traces$/)).toBeTruthy()
	})

	it("counts what the default span-kind filter leaves, not every span in the session", () => {
		// Eight spans, one of them the app's own HTTP call, which "Agent spans only"
		// hides before the first paint.
		render(<SessionViews turns={turns} summary={summary} selection={undefined} onOpenTrace={noop} />)

		expect(screen.getByText(/^7 of 8 spans · 2 turns · 1 trace$/)).toBeTruthy()
	})

	// Both views read the query and the span-kind toggle, so both controls stay
	// mounted in both.
	it("keeps the filter and the span-kind toggle reachable in both views", () => {
		render(<SessionViews turns={turns} summary={summary} selection={undefined} onOpenTrace={noop} />)

		fireEvent.click(screen.getByRole("tab", { name: /Flow/ }))

		expect(screen.getByPlaceholderText("Filter spans")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Agent spans only" })).toBeTruthy()
		// The genuinely view-specific toggles still swap.
		expect(screen.getByRole("button", { name: "Merge repeat tools" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Collapse idle" })).toBeNull()
	})

	// Collapsing idle distorts the axis, so the toggle that undoes it is part of
	// the design rather than a preference.
	it("puts the idle back on the axis when Collapse idle is switched off", () => {
		render(<SessionViews turns={turns} summary={summary} selection={undefined} onOpenTrace={noop} />)

		expect(screen.getByText(/of idle removed across 1 gap/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Collapse idle" }))

		expect(screen.queryByText(/of idle removed/)).toBeNull()
	})

	// The state lives in SessionViews rather than the views precisely so a look
	// at Flow doesn't cost the reader the place they found in a long session.
	it("survives a Timeline → Flow → Timeline round trip with the turn still collapsed", () => {
		render(<SessionViews turns={turns} summary={summary} selection={undefined} onOpenTrace={noop} />)

		fireEvent.click(screen.getByRole("button", { name: /Turn 1/ }))
		expect(screen.getByText(/spans$/)).toBeTruthy()

		fireEvent.click(screen.getByRole("tab", { name: /Flow/ }))
		fireEvent.click(screen.getByRole("tab", { name: /Timeline/ }))

		// Still collapsed: the collapsed turn shows its span count as a pill.
		expect(screen.getByText(/spans$/)).toBeTruthy()
		expect(screen.getByRole("button", { name: /Turn 1/ }).getAttribute("aria-expanded")).toBe("false")
	})
})
