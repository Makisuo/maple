// @vitest-environment jsdom
// TEST-SEAM: the virtualizer sizes its viewport from offsetWidth/offsetHeight,
// which jsdom reports as 0 — leaving it convinced no row is on screen, so the
// two layout globals below are stubbed for that reason alone. Nothing here
// navigates: span clicks raise `onSelectSpan` for the page to handle, and the
// trace links render through a mocked `Link` so no router needs mounting.
//
// The span inspection overlay portals to `document.body`, so it is read through
// `spanPopover()` below rather than the render's own container.

import { useState, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		search,
		children,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		search?: Record<string, unknown>
		children?: ReactNode
	} & Record<string, unknown>) => {
		void search
		let href = to
		for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value)
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		)
	},
}))

// The expansion's Details tab mounts the trace page's lazy spanDetail read;
// the warehouse is no part of these tests, so the atom stays Initial forever
// and the tab renders its identity rows over the loading skeletons.
vi.mock("@/lib/services/atoms/warehouse-query-atoms", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/services/atoms/warehouse-query-atoms")>()
	const { disabledResultAtom } = await import("@/lib/services/atoms/disabled-result-atom")
	return { ...actual, getSpanDetailResultAtom: () => disabledResultAtom() }
})

import type { AiSessionSpan } from "@maple/domain/http"
import { agentSpan, llmSpan, makeSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-test-support"
import { buildSessionSummary, type SessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns, type SessionTurn } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { SessionOverview } from "./session-overview"
import { SessionViews, type SessionView } from "./session-views"
import { SessionWaterfall } from "./session-waterfall"
import type { SpanDetailTab } from "./span-expansion"

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
const { turns: quietTurns, summary: quiet } = sessionOf([
	agentSpan({ spanId: "a", startMs: 0, durationMs: SECOND }),
])

const { turns: gatewayTurns, summary: gateway } = sessionOf([
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

/** The one span-inspection overlay, wherever it was opened from. */
function spanPopover(): HTMLElement {
	const popup = document.querySelector<HTMLElement>('[data-slot="span-popover"]')
	if (popup === null) throw new Error("no span popover is open")
	return popup
}

/** The dimmed page behind the overlay — the scrim that gives it its depth. */
function spanScrim(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]')
}

function spanPopoverCount(): number {
	return document.querySelectorAll('[data-slot="span-popover"]').length
}

/** The waterfall's expansion state lives in SessionViews, so the tests supply it. */
function Waterfall(props: {
	turns?: readonly SessionTurn[]
	summary?: SessionSummary
	query?: string
	agentSpansOnly?: boolean
	collapseIdle?: boolean
	collapsedTurns?: ReadonlySet<string>
	onToggleTurn?: (turnId: string) => void
	selectedSpanId?: string
	revealedSpanId?: string
	onSelectSpan?: (spanId: string | undefined) => void
	spanTab?: SpanDetailTab
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
			selectedSpanId={props.selectedSpanId}
			revealedSpanId={props.revealedSpanId}
			onSelectSpan={props.onSelectSpan ?? noop}
			spanTab={props.spanTab}
			onSpanTabChange={noop}
		/>
	)
}

function Flow(props: {
	turns?: readonly SessionTurn[]
	mergeRepeats?: boolean
	query?: string
	agentSpansOnly?: boolean
	selectedSpanId?: string
	onSelectSpan?: (spanId: string | undefined) => void
}) {
	return (
		<SessionFlow
			turns={props.turns ?? turns}
			mergeRepeats={props.mergeRepeats ?? false}
			query={props.query ?? ""}
			agentSpansOnly={props.agentSpansOnly ?? true}
			zoom={1}
			onZoomChange={noop}
			selectedSpanId={props.selectedSpanId}
			onSelectSpan={props.onSelectSpan ?? noop}
			spanTab={undefined}
			onSpanTabChange={noop}
			onOpenTraceView={noop}
		/>
	)
}

describe("SessionOverview", () => {
	// A turn whose root AI span errored, with the model call under it reporting
	// the same failure — the shape every framework that copies a child's error
	// onto its parent produces.
	const { turns: failedTurns, summary: failedSummary } = sessionOf([
		agentSpan({
			spanId: "f-agent",
			startMs: 0,
			durationMs: 4 * SECOND,
			statusCode: "Error",
			statusMessage: "prompt is too long: 214832 tokens > 200000 maximum",
			genAi: { errorType: "context_length_exceeded" },
		}),
		llmSpan({
			spanId: "f-llm",
			parentSpanId: "f-agent",
			startMs: SECOND,
			durationMs: 2 * SECOND,
			model: "claude-opus-5",
			statusCode: "Error",
			statusMessage: "prompt is too long: 214832 tokens > 200000 maximum",
			genAi: { errorType: "context_length_exceeded" },
		}),
	])

	/** `?span=` is a search param on the real page; here it is local state. */
	function Overview(props: {
		turns?: readonly SessionTurn[]
		summary?: SessionSummary
		/** What a pasted `?span=` link lands with. */
		initialSpanId?: string
		onSelectSpan?: (spanId: string | undefined) => void
		onOpenTraceView?: () => void
	}) {
		const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(props.initialSpanId)
		return (
			<SessionOverview
				turns={props.turns ?? turns}
				summary={props.summary ?? summary}
				selectedSpanId={selectedSpanId}
				onSelectSpan={(spanId) => {
					setSelectedSpanId(spanId)
					props.onSelectSpan?.(spanId)
				}}
				spanTab={undefined}
				onSpanTabChange={noop}
				onOpenTraceView={props.onOpenTraceView ?? noop}
			/>
		)
	}

	it("splits the wall clock into where the time actually went", () => {
		render(<Overview />)

		// 5m 12s wall clock, 4m 20s of it idle.
		expect(screen.getByText("Idle")).toBeTruthy()
		expect(screen.getByText(/4m 20s · 83%/)).toBeTruthy()
	})

	// The five-second answer: the verdict names what killed the final turn and
	// opens the span that is its evidence — the one link the v2 page lost.
	it("says a failed session failed, names the cause, and opens the failing span", () => {
		const onSelectSpan = vi.fn()
		render(<Overview turns={failedTurns} summary={failedSummary} onSelectSpan={onSelectSpan} />)

		expect(screen.getByText("Failed")).toBeTruthy()
		expect(screen.getAllByText("context_length_exceeded").length).toBeGreaterThan(0)

		fireEvent.click(screen.getByRole("button", { name: /Open failing span/ }))
		// The deepest span carrying the failure, not the wrapper that copied it.
		expect(onSelectSpan).toHaveBeenCalledWith("f-llm")
		// In place, against the button that named it — the Overview is still on
		// screen behind the panel.
		expect(within(spanPopover()).getByText("f-llm")).toBeTruthy()
	})

	// A mid-session failure the session recovered from is not a failed session —
	// but it is exactly what the findings list exists to surface.
	it("completes-with-findings when something failed mid-session, and opens it", () => {
		const onSelectSpan = vi.fn()
		render(<Overview onSelectSpan={onSelectSpan} />)

		expect(screen.getByText(/Completed, with 1 finding/)).toBeTruthy()
		fireEvent.click(screen.getByText("error · run_tests"))
		expect(onSelectSpan).toHaveBeenCalledWith("tool-3")
	})

	// The finding's evidence used to live one view away: clicking it swapped the
	// page out from under the reader. It opens over this page instead, and the
	// way across is inside the panel for the reader who wants the whole waterfall.
	it("inspects a finding's span in place, and still offers the way across", () => {
		const onOpenTraceView = vi.fn()
		render(<Overview onOpenTraceView={onOpenTraceView} />)

		fireEvent.click(screen.getByText("error · run_tests"))
		const popover = within(spanPopover())
		expect(popover.getByText("exit 1")).toBeTruthy()
		// A scrim behind it, so the page reads as underneath rather than beside.
		expect(spanScrim()).not.toBeNull()
		expect(onOpenTraceView).not.toHaveBeenCalled()

		fireEvent.click(popover.getByRole("button", { name: "Open in Traces view" }))
		expect(onOpenTraceView).toHaveBeenCalled()
	})

	// The panel is no longer anchored to the element that named the span, so a
	// selection this view never made — a pasted `?span=` link, or the reader
	// arriving from another view — opens it here too.
	it("opens a pasted span link without a click, and Escape clears it", () => {
		const onSelectSpan = vi.fn()
		render(
			<Overview
				turns={failedTurns}
				summary={failedSummary}
				initialSpanId="f-llm"
				onSelectSpan={onSelectSpan}
			/>,
		)

		expect(within(spanPopover()).getAllByText(/claude-opus-5/).length).toBeGreaterThan(0)

		fireEvent.keyDown(spanPopover(), { key: "Escape" })
		expect(onSelectSpan).toHaveBeenCalledWith(undefined)
	})

	it("says a clean session completed cleanly, and what that claim covers", () => {
		render(<Overview turns={quietTurns} summary={quiet} />)

		expect(screen.getByText("Completed cleanly")).toBeTruthy()
		expect(screen.getByText(/No errors, refusals, truncated replies/)).toBeTruthy()
		expect(screen.getByText("No findings.")).toBeTruthy()
	})

	// The shape strip replaces the turn digest: one cell per turn, colored by
	// what the findings attribute to it, each opening the turn's anchor span.
	it("draws one cell per turn and opens the turn's anchor from a click", () => {
		const onSelectSpan = vi.fn()
		render(<Overview onSelectSpan={onSelectSpan} />)

		const cellTwo = screen.getByRole("button", { name: "2" })
		fireEvent.click(cellTwo)
		expect(onSelectSpan).toHaveBeenCalledWith("agent-2")
	})

	it("says no cost was reported rather than pricing tokens itself", () => {
		render(<Overview />)

		expect(screen.getByText(/Maple does not price tokens itself/)).toBeTruthy()
		expect(screen.queryByText(/^\$/)).toBeNull()
	})

	it("says no usage was reported rather than pricing a session at zero", () => {
		render(<Overview turns={quietTurns} summary={quiet} />)

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
		render(<Overview turns={tiny.turns} summary={tiny.summary} />)

		expect(screen.getAllByText("<$0.01").length).toBeGreaterThan(0)
		expect(screen.queryByText("$0.00")).toBeNull()
	})

	// The turns below print no tokens in this shape, so the rail has to say why
	// rather than leave a reader to read the dashes as missing instrumentation.
	it("says a session-level total was reported once for the whole session", () => {
		render(<Overview turns={aggregateTurns} summary={aggregateSummary} />)

		expect(screen.getByText("5.5K")).toBeTruthy()
		expect(screen.getByText("Reported once for the whole session")).toBeTruthy()
	})

	it("shows the last path segment of a gateway model id, full id in the title", () => {
		render(<Overview turns={gatewayTurns} summary={gateway} />)

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

	it("opens a span's panel from a click, and closes it on the second", () => {
		const onSelectSpan = vi.fn()
		const view = render(<Waterfall onSelectSpan={onSelectSpan} />)

		fireEvent.click(screen.getByText("grep_repo"))
		expect(onSelectSpan).toHaveBeenCalledWith("tool-2")

		// Clicking the open row closes it. The panel repeats the tool's name in
		// its payload card, so the row is the first match.
		view.rerender(<Waterfall selectedSpanId="tool-2" onSelectSpan={onSelectSpan} />)
		fireEvent.click(screen.getAllByText("grep_repo")[0]!)
		expect(onSelectSpan).toHaveBeenLastCalledWith(undefined)
	})

	it("links a turn's trace to the trace page — there is no side panel", () => {
		render(<Waterfall />)

		const link = screen.getAllByText("Trace trace-1")[0]!.closest("a")!
		expect(link.getAttribute("href")).toBe("/traces/trace-1")
	})

	it("opens the selected span over the list, leaving its row marked underneath", () => {
		render(<Waterfall selectedSpanId="llm-1" />)

		const row = screen.getAllByText(/^chat$/)[0]!.closest("button")!
		expect(row.getAttribute("aria-current")).toBe("true")

		// The panel carries the captured messages at full width — the user's
		// prompt appears complete here, beyond the truncated turn label above it.
		const detail = within(spanPopover())
		expect(detail.getByText("fix the webhook retry backoff")).toBeTruthy()
		expect(detail.getByRole("button", { name: /Messages/ })).toBeTruthy()
		expect(detail.getByText("Open in Traces")).toBeTruthy()
	})

	it("leads the panel's tabs with Details; Attributes and Timing are folded into it", () => {
		render(<Waterfall selectedSpanId="llm-1" />)

		const detail = within(spanPopover())
		const labels = detail
			.getAllByRole("button")
			.filter((button) => button.hasAttribute("aria-pressed"))
			.map((button) => button.textContent ?? "")
		expect(labels[0]).toContain("Details")
		expect(labels.some((label) => label.includes("Attributes"))).toBe(false)
		expect(labels.some((label) => label.includes("Timing"))).toBe(false)
	})

	// A failed tool call must show its failure on Details — the tab a reader
	// opens first — even when the span carries no status message: the evidence
	// attributes and the captured result are what there is to show.
	it("shows a message-less tool failure on Details, captured result included", () => {
		const { turns: failTurns, summary: failSummary } = sessionOf([
			agentSpan({ spanId: "ft-agent", startMs: 0, durationMs: 4 * SECOND }),
			toolSpan({
				spanId: "ft-tool",
				parentSpanId: "ft-agent",
				startMs: SECOND,
				durationMs: SECOND,
				toolName: "run_sql",
				genAi: {
					errorType: "tool_error",
					toolCallId: "call_f",
					toolCallArguments: { sql: "select 1" },
					toolCallResult: { error: "relation missing" },
				},
			}),
		])
		render(<Waterfall turns={failTurns} summary={failSummary} selectedSpanId="ft-tool" />)

		const detail = spanPopover()
		// A failed span opens on Details by default.
		expect(within(detail).getByRole("button", { name: "Details" }).getAttribute("aria-pressed")).toBe(
			"true",
		)
		expect(within(detail).getByText("This call failed")).toBeTruthy()
		expect(within(detail).getByText(/tool_error/)).toBeTruthy()
		// The captured result — where the actual error text lives — is on the tab.
		expect(detail.textContent).toContain('"relation missing"')
	})

	it("opens an errored span on Details, where the error and the ids are", () => {
		render(<Waterfall selectedSpanId="tool-3" />)

		const detail = within(spanPopover())
		expect(detail.getByRole("button", { name: "Details" }).getAttribute("aria-pressed")).toBe("true")
		// The error banner and the identity rows render ahead of the lazily
		// loaded attribute maps (held at Initial by the atom mock above).
		expect(detail.getByText("exit 1")).toBeTruthy()
		expect(detail.getByText("Trace ID")).toBeTruthy()
	})

	it("opens one span at a time — the selection, not a set", () => {
		const view = render(<Waterfall selectedSpanId="tool-1" />)
		expect(spanPopoverCount()).toBe(1)

		view.rerender(<Waterfall selectedSpanId="tool-2" />)
		expect(spanPopoverCount()).toBe(1)
		// The one panel followed the selection rather than joining the first.
		expect(within(spanPopover()).getAllByText("grep_repo").length).toBeGreaterThan(0)
	})

	// A call and its result are one event: the panel draws both halves of one
	// card at once, joined by the direction gutter. The selector that used to
	// show one at a time made a result nobody captured read exactly like a half
	// nobody had clicked.
	it("draws a tool call and its result as both halves of one card", () => {
		const { turns: toolTurns, summary: toolSummary } = sessionOf([
			agentSpan({ spanId: "tc-agent", startMs: 0, durationMs: 4 * SECOND }),
			toolSpan({
				spanId: "tc-tool",
				parentSpanId: "tc-agent",
				startMs: SECOND,
				durationMs: SECOND,
				toolName: "run_sql",
				genAi: {
					toolCallId: "call_9",
					toolCallArguments: { sql: "select 1" },
					toolCallResult: { rows: [1] },
				},
			}),
		])
		render(<Waterfall turns={toolTurns} summary={toolSummary} selectedSpanId="tc-tool" spanTab="tools" />)

		// Both halves, pretty-printed and named by direction — and nothing to click
		// to see the other one.
		const detail = spanPopover()
		expect(detail.textContent).toContain('"sql"')
		expect(detail.textContent).toContain('"rows"')
		expect(detail.textContent).toContain("Sent")
		expect(detail.textContent).toContain("Returned")
		expect(within(detail).queryByRole("button", { name: "result" })).toBeNull()
		expect(within(detail).queryByRole("button", { name: "arguments" })).toBeNull()
	})

	// A failed tool span condemns the call it EXECUTED. Without that, the Tool
	// calls tab dressed a failed return in the success styling and dropped its
	// error label — the tab said the call came back fine.
	it("marks the executed call's return as the failure on the Tool calls tab", () => {
		const { turns: toolTurns, summary: toolSummary } = sessionOf([
			agentSpan({ spanId: "ft-agent", startMs: 0, durationMs: 4 * SECOND }),
			toolSpan({
				spanId: "ft-tool",
				parentSpanId: "ft-agent",
				startMs: SECOND,
				durationMs: SECOND,
				toolName: "run_tests",
				statusCode: "Error",
				statusMessage: "exit 1",
				genAi: {
					toolCallId: "call_11",
					toolCallArguments: { suite: "webhooks" },
					toolCallResult: "exit 1 · 2 failing",
				},
			}),
		])
		render(<Waterfall turns={toolTurns} summary={toolSummary} selectedSpanId="ft-tool" spanTab="tools" />)

		const detail = spanPopover()
		expect(detail.textContent).toContain("Returned · error")
		expect(detail.textContent).toContain("span status Error")
	})

	// A half nobody recorded keeps its place: dropping it would leave a card that
	// reads as a call which returned nothing.
	it("keeps the returned half when no result was captured", () => {
		const { turns: toolTurns, summary: toolSummary } = sessionOf([
			agentSpan({ spanId: "nr-agent", startMs: 0, durationMs: 4 * SECOND }),
			toolSpan({
				spanId: "nr-tool",
				parentSpanId: "nr-agent",
				startMs: SECOND,
				durationMs: SECOND,
				toolName: "write_file",
				genAi: { toolCallId: "call_10", toolCallArguments: { path: "a.ts" } },
			}),
		])
		render(<Waterfall turns={toolTurns} summary={toolSummary} selectedSpanId="nr-tool" spanTab="tools" />)

		const detail = spanPopover()
		expect(detail.textContent).toContain("Returned")
		expect(detail.textContent).toContain("whether the call succeeded is unknown")
	})

	// The panel is a dialog, so the page-level keys stand down while it is open:
	// the arrows walk the list up to the point one opens, and the panel's own
	// close (its button, or Escape inside it) is what puts the reader back.
	it("moves the span cursor with the arrows, opens on Enter, closes from the panel", () => {
		const onSelectSpan = vi.fn()
		const view = render(<Waterfall onSelectSpan={onSelectSpan} />)

		// First ↓ lands on the first span row — turn 1's root agent span; Enter
		// opens it.
		fireEvent.keyDown(document.body, { key: "ArrowDown" })
		fireEvent.keyDown(document.body, { key: "Enter" })
		expect(onSelectSpan).toHaveBeenCalledWith("agent-1")

		view.rerender(<Waterfall selectedSpanId="agent-1" onSelectSpan={onSelectSpan} />)
		fireEvent.click(within(spanPopover()).getByRole("button", { name: "Close span detail" }))
		expect(onSelectSpan).toHaveBeenLastCalledWith(undefined)
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

	/** Node cards are the xyflow step nodes; their layout position lives on the
	 *  wrapper's transform, which jsdom preserves verbatim. */
	const cardsOf = (container: HTMLElement) => [
		...container.querySelectorAll<HTMLElement>(".react-flow__node-step"),
	]
	const positionOf = (card: HTMLElement) => {
		const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card.style.transform)
		return { x: Number(match![1]), y: Number(match![2]) }
	}

	it("lays out one lane per turn", () => {
		render(<Flow />)

		expect(screen.getByText("Turn 1")).toBeTruthy()
		expect(screen.getByText("Turn 2")).toBeTruthy()
		expect(screen.getByText("read_file")).toBeTruthy()
		expect(screen.getByText("grep_repo")).toBeTruthy()
	})

	it("opens a span's panel from a node click", () => {
		const onSelectSpan = vi.fn()
		render(<Flow onSelectSpan={onSelectSpan} />)

		fireEvent.click(screen.getByText("grep_repo"))
		expect(onSelectSpan).toHaveBeenCalledWith("tool-2")
	})

	it("opens the selected span's panel, naming the node's turn", () => {
		render(<Flow selectedSpanId="tool-2" />)

		// The panel names the span and where it lives, and offers the way across.
		const panel = within(spanPopover())
		expect(panel.getAllByText(/grep_repo/).length).toBeGreaterThan(0)
		expect(panel.getByText(/Turn 1/)).toBeTruthy()
		expect(panel.getByText("Open in Traces view")).toBeTruthy()
	})

	it("opens the panel even for a span the flow drew no node for", () => {
		// The app's own HTTP span earns no node, but selection addresses spans the
		// same way in both views, so a span opened in Trace still opens here — the
		// panel is an overlay over the canvas, not a pointer at some node on it.
		render(<Flow selectedSpanId="http-1" agentSpansOnly={false} />)

		expect(within(spanPopover()).getByText("GET /repo/file")).toBeTruthy()
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
		expect(positionOf(cards[1]!).x).toBeGreaterThan(positionOf(cards[0]!).x)
		expect(positionOf(cards[1]!).y).toBe(positionOf(cards[0]!).y)
		expect(view.container.querySelectorAll(".react-flow__edge")).toHaveLength(1)
	})

	it("draws one connector per parent/child pair, not per adjacent column", () => {
		// Four children of one anchor across three columns in turn 1 plus one pair
		// in turn 2: five connectors, never the column-to-column cartesian product
		// (which would pair the two parallel tools with the tool after them).
		const view = render(<Flow />)

		expect(view.container.querySelectorAll(".react-flow__edge")).toHaveLength(5)
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
		expect(positionOf(cards[8]!).x).toBe(positionOf(cards[0]!).x)
		expect(positionOf(cards[8]!).y).toBeGreaterThan(positionOf(cards[0]!).y)
	})
})

describe("SessionViews", () => {
	/** `view` is a search param on the real page; here it is local state. */
	function Views(props: { turns?: readonly SessionTurn[]; summary?: SessionSummary; view?: SessionView }) {
		const [view, setView] = useState<SessionView>(props.view ?? "trace")
		const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined)
		return (
			<SessionViews
				view={view}
				onViewChange={setView}
				turns={props.turns ?? turns}
				summary={props.summary ?? summary}
				truncated={false}
				selectedSpanId={selectedSpanId}
				onSelectSpan={setSelectedSpanId}
			/>
		)
	}

	// Both debug views read the query and the span-kind toggle, so both controls
	// stay mounted in both.
	it("keeps the filter and the span-kind toggle reachable in both debug views", () => {
		render(<Views />)

		fireEvent.click(screen.getByRole("tab", { name: /Flow/ }))
		fireEvent.click(screen.getByRole("button", { name: "Display options" }))

		expect(screen.getByPlaceholderText("Filter spans")).toBeTruthy()
		expect(screen.getByRole("switch", { name: "Agent spans only" })).toBeTruthy()
		// The genuinely view-specific toggles still swap.
		expect(screen.getByRole("switch", { name: "Merge repeat tools" })).toBeTruthy()
		expect(screen.queryByRole("switch", { name: "Collapse idle" })).toBeNull()
	})

	// None of the span controls shape the Overview, and a row of controls that do
	// nothing is what made the shared toolbar unreadable.
	it("drops the span toolbar on the Overview", () => {
		render(<Views view="overview" />)

		expect(screen.queryByPlaceholderText("Filter spans")).toBeNull()
		expect(screen.queryByRole("button", { name: "Display options" })).toBeNull()
		expect(screen.getByRole("tab", { name: /Overview/ })).toBeTruthy()
	})

	// Collapsing idle distorts the axis, so the toggle that undoes it is part of
	// the design rather than a preference.
	it("puts the idle back on the axis when Collapse idle is switched off", () => {
		render(<Views />)

		expect(screen.getByText(/of idle removed across 1 gap/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Display options" }))
		fireEvent.click(screen.getByRole("switch", { name: "Collapse idle" }))

		expect(screen.queryByText(/of idle removed/)).toBeNull()
	})

	// The state lives in SessionViews rather than the views precisely so a look
	// at Flow doesn't cost the reader the place they found in a long session.
	it("survives a Trace → Flow → Trace round trip with the turn still collapsed", () => {
		render(<Views />)

		fireEvent.click(screen.getByRole("button", { name: /Turn 1/ }))
		expect(screen.getByText(/spans$/)).toBeTruthy()

		fireEvent.click(screen.getByRole("tab", { name: /Flow/ }))
		fireEvent.click(screen.getByRole("tab", { name: /Trace/ }))

		// Still collapsed: the collapsed turn shows its span count as a pill.
		expect(screen.getByText(/spans$/)).toBeTruthy()
		expect(screen.getByRole("button", { name: /Turn 1/ }).getAttribute("aria-expanded")).toBe("false")
	})

	// The panel's door exists to show the span in its waterfall, so the panel
	// closes on the way through: crossing views only to find the same overlay
	// still covering the rows was the one thing the door could not do.
	it("closes the panel and marks the row it sent the reader to", () => {
		render(<Views view="flow" />)

		fireEvent.click(screen.getByText("grep_repo"))
		fireEvent.click(within(spanPopover()).getByRole("button", { name: "Open in Traces view" }))

		// The waterfall's own column header: the Traces view is what is on screen.
		expect(screen.getByText("Model / target")).toBeTruthy()
		expect(spanPopoverCount()).toBe(0)

		// And the row the reader crossed for is the one carrying the mark.
		const marked = document.querySelectorAll("[data-revealed]")
		expect(marked.length).toBe(1)
		expect(marked[0]!.textContent).toContain("grep_repo")
	})

	// The mark says "this is the row you were sent to", so it comes off the
	// moment the reader goes somewhere else themselves.
	it("takes the mark off once the reader opens another span", () => {
		render(<Views view="flow" />)

		fireEvent.click(screen.getByText("grep_repo"))
		fireEvent.click(within(spanPopover()).getByRole("button", { name: "Open in Traces view" }))

		fireEvent.click(screen.getAllByText("read_file")[0]!)
		expect(document.querySelector("[data-revealed]")).toBeNull()
	})

	// The tab choice lives beside the other cross-view state in SessionViews:
	// moving the panel to another span must not reset the reader's tab.
	it("keeps the chosen detail tab open when the panel moves to another span", () => {
		render(<Views />)

		// The tool span opens on its own payload (Tool calls); choose Details.
		fireEvent.click(screen.getByText("grep_repo"))
		fireEvent.click(within(spanPopover()).getByRole("button", { name: "Details" }))

		// Move the panel to a different span — the choice holds.
		fireEvent.click(screen.getAllByText("read_file")[0]!)
		expect(
			within(spanPopover()).getByRole("button", { name: "Details" }).getAttribute("aria-pressed"),
		).toBe("true")
	})
})
