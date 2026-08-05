// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { JourneyEventData } from "./journey-model"
import { buildJourneyModel } from "./journey-model"
import { JourneyTimeline, type JourneyTimelineHandle } from "./journey-timeline"

afterEach(cleanup)

/**
 * jsdom ships neither `IntersectionObserver` nor `scrollIntoView`, and both are
 * load-bearing here: the timeline reports what's on screen through the first and
 * the journey map scrolls through the second.
 */
class FakeIntersectionObserver {
	static instances: Array<FakeIntersectionObserver> = []
	readonly targets = new Set<Element>()
	constructor(private readonly callback: IntersectionObserverCallback) {
		FakeIntersectionObserver.instances.push(this)
	}
	observe(element: Element) {
		this.targets.add(element)
	}
	unobserve(element: Element) {
		this.targets.delete(element)
	}
	disconnect() {
		this.targets.clear()
	}
	takeRecords() {
		return []
	}
	trigger(entries: Array<{ target: Element; isIntersecting: boolean }>) {
		this.callback(
			entries as unknown as Array<IntersectionObserverEntry>,
			this as unknown as IntersectionObserver,
		)
	}
}

const BASE_TIME = Date.UTC(2026, 7, 5, 12, 0, 0)

function at(offsetMs: number): string {
	return new Date(BASE_TIME + offsetMs).toISOString().replace("T", " ").replace("Z", "")
}

function event(overrides: Partial<JourneyEventData> & { id: string }): JourneyEventData {
	return {
		kind: "message",
		timestamp: at(0),
		spanId: overrides.id,
		parentSpanId: "",
		traceId: "trace-1",
		operation: "chat",
		spanName: "chat",
		role: "assistant",
		content: null,
		contentSource: "attributes",
		durationMs: 1_000,
		model: null,
		requestedModel: null,
		provider: null,
		inputTokens: null,
		outputTokens: null,
		cachedInputTokens: null,
		reasoningTokens: null,
		cost: null,
		finishReason: null,
		agentName: null,
		workflowName: null,
		toolName: null,
		toolCallId: null,
		toolArguments: null,
		toolResult: null,
		parentEventId: null,
		status: "ok",
		statusMessage: null,
		...overrides,
	}
}

function renderTimeline(events: ReadonlyArray<JourneyEventData>, isLive = false) {
	const model = buildJourneyModel(events, null)
	return render(<JourneyTimeline model={model} isLive={isLive} truncated={false} />)
}

/** 60 unremarkable turns — past the threshold where the middle folds into a group. */
function longJourney(): ReadonlyArray<JourneyEventData> {
	return Array.from({ length: 60 }, (_, index) =>
		event({
			id: `m${index}`,
			content: `turn ${index}`,
			timestamp: at(index * 1_000),
			durationMs: 200,
		}),
	)
}

describe("JourneyTimeline", () => {
	it("renders an absent body as a deliberate redaction, not an empty message", () => {
		renderTimeline([
			event({ id: "m1", role: "user", content: null, contentSource: "absent", agentName: null }),
		])
		expect(screen.getByText("content not recorded")).toBeTruthy()
	})

	it("scales a redacted turn's timing bar against the longest turn in the journey", () => {
		// With the text gone the bar is the only readable thing about the turn, so
		// it has to be a measurement — a full-width bar on every row says nothing.
		const { container } = renderTimeline([
			event({ id: "m1", content: null, contentSource: "absent", durationMs: 1_000 }),
			event({
				id: "m2",
				content: null,
				contentSource: "absent",
				durationMs: 4_000,
				timestamp: at(5_000),
			}),
		])
		const bars = Array.from(container.querySelectorAll<HTMLElement>('[role="img"] > span'))
		expect(bars.map((bar) => bar.style.width)).toEqual(["25%", "100%"])
	})

	it("says where the content went when it lives in span events", () => {
		renderTimeline([event({ id: "m1", content: null, contentSource: "events" })])
		expect(screen.getByText(/recorded as span events/)).toBeTruthy()
	})

	it("badges a response truncated by the token cap", () => {
		renderTimeline([event({ id: "m1", content: "half an answer", finishReason: "length" })])
		expect(screen.getByText("CUT OFF AT max_tokens")).toBeTruthy()
	})

	it("makes a failed turn obvious without expanding anything", () => {
		renderTimeline([
			event({
				id: "m1",
				content: null,
				status: "error",
				statusMessage: "rate_limit_exceeded: HTTP 429",
				provider: "openrouter",
			}),
		])
		expect(screen.getByText("PROVIDER ERROR")).toBeTruthy()
		expect(screen.getByText("rate_limit_exceeded")).toBeTruthy()
	})

	it("shows a failed tool call as failed before it is expanded", () => {
		renderTimeline([
			event({ id: "m1", content: "working on it", agentName: "payouts-agent" }),
			event({
				id: "t1",
				kind: "toolCall",
				toolName: "payouts.fetch_receipts",
				parentEventId: "m1",
				timestamp: at(200),
				durationMs: 5_000,
				status: "error",
				statusMessage: "DeadlineExceeded",
			}),
		])
		expect(screen.getByText("1 failed")).toBeTruthy()
		expect(screen.getByText("DeadlineExceeded")).toBeTruthy()
	})

	it("expands a tool call's arguments on demand", () => {
		renderTimeline([
			event({ id: "m1", content: "working on it" }),
			event({
				id: "t1",
				kind: "toolCall",
				toolName: "ledger.query_batch",
				toolArguments: '{"batch_id":"pb_2026_03"}',
				parentEventId: "m1",
				timestamp: at(200),
				durationMs: 2_100,
			}),
		])
		expect(screen.queryByText("Arguments")).toBeNull()
		fireEvent.click(screen.getByText("ledger.query_batch"))
		expect(screen.getByText("Arguments")).toBeTruthy()
	})

	it("marks the still-open turn of a running journey as live", () => {
		renderTimeline(
			[event({ id: "m1", content: "Subject: March payout batch —", durationMs: null })],
			true,
		)
		expect(screen.getByText("STREAMING")).toBeTruthy()
		expect(screen.getByText("generating")).toBeTruthy()
	})

	it("renders a handoff as a structural bar naming both agents", () => {
		renderTimeline([
			event({
				id: "h1",
				kind: "agentHandoff",
				operation: "invoke_agent",
				agentName: "report-writer",
				statusMessage: "payouts-agent",
				durationMs: null,
			}),
		])
		expect(screen.getByText("HANDOFF")).toBeTruthy()
		expect(screen.getByText("payouts-agent")).toBeTruthy()
		expect(screen.getByText("report-writer")).toBeTruthy()
	})

	it("offers navigation chips only once the journey is long enough to need them", () => {
		const short = renderTimeline([event({ id: "m1", content: "a" })])
		expect(screen.queryByLabelText("Filter this journey")).toBeNull()
		short.unmount()

		renderTimeline(longJourney())
		expect(screen.getByLabelText("Filter this journey")).toBeTruthy()
	})
})

describe("JourneyTimeline — revealing a row the map asked for", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn()
	})

	function renderWithHandle(events: ReadonlyArray<JourneyEventData>) {
		const ref = createRef<JourneyTimelineHandle>()
		const model = buildJourneyModel(events, null)
		const view = render(<JourneyTimeline ref={ref} model={model} isLive={false} truncated={false} />)
		return { ref, ...view }
	}

	it("expands the collapsed group a folded row lives in, then scrolls to it", () => {
		const { ref, container } = renderWithHandle(longJourney())
		// A middle turn is folded into a turn group — no node to scroll to yet.
		expect(container.querySelector('[data-journey-row="m20"]')).toBeNull()

		act(() => ref.current?.revealRow("m20"))

		expect(container.querySelector('[data-journey-row="m20"]')).not.toBeNull()
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
	})

	it("drops an active filter when asked for a row that filter excludes", () => {
		const { ref, container } = renderWithHandle(longJourney())
		fireEvent.change(screen.getByLabelText("Filter this journey"), {
			target: { value: "turn 41" },
		})
		expect(container.querySelector('[data-journey-row="m20"]')).toBeNull()

		act(() => ref.current?.revealRow("m20"))

		expect(container.querySelector('[data-journey-row="m20"]')).not.toBeNull()
	})

	it("scrolls straight to a row that is already on the page", () => {
		const { ref } = renderWithHandle([event({ id: "m1", content: "only turn" })])
		act(() => ref.current?.revealRow("m1"))
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
	})
})

describe("JourneyTimeline — reporting what is on screen", () => {
	const realObserver = globalThis.IntersectionObserver

	beforeEach(() => {
		FakeIntersectionObserver.instances = []
		globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
	})

	afterEach(() => {
		globalThis.IntersectionObserver = realObserver
	})

	function observer() {
		const instance = FakeIntersectionObserver.instances[0]
		if (instance == null) throw new Error("no IntersectionObserver was created")
		return instance
	}

	function rowNode(container: HTMLElement, id: string): Element {
		const node = container.querySelector(`[data-journey-row="${id}"]`)
		if (node == null) throw new Error(`row ${id} is not on the page`)
		return node
	}

	it("stays quiet when a threshold crossing doesn't change which rows are on screen", () => {
		const onVisibleRowsChange = vi.fn()
		const model = buildJourneyModel(
			[event({ id: "m1", content: "one" }), event({ id: "m2", content: "two", timestamp: at(1_000) })],
			null,
		)
		const { container } = render(
			<JourneyTimeline
				model={model}
				isLive={false}
				truncated={false}
				onVisibleRowsChange={onVisibleRowsChange}
			/>,
		)

		const first = { target: rowNode(container, "m1"), isIntersecting: true }
		act(() => observer().trigger([first]))
		expect(onVisibleRowsChange).toHaveBeenCalledTimes(1)
		expect(onVisibleRowsChange.mock.calls[0]![0]).toEqual(new Set(["m1"]))

		// Same set, reported again — the timeline must not hand the page a new Set.
		act(() => observer().trigger([first]))
		expect(onVisibleRowsChange).toHaveBeenCalledTimes(1)

		act(() => observer().trigger([{ target: rowNode(container, "m2"), isIntersecting: true }]))
		expect(onVisibleRowsChange).toHaveBeenCalledTimes(2)
		expect(onVisibleRowsChange.mock.calls[1]![0]).toEqual(new Set(["m1", "m2"]))
	})

	it("reports a collapsed group's member rows, so the map can shade the viewport", () => {
		const onVisibleRowsChange = vi.fn()
		const model = buildJourneyModel(longJourney(), null)
		const { container } = render(
			<JourneyTimeline
				model={model}
				isLive={false}
				truncated={false}
				onVisibleRowsChange={onVisibleRowsChange}
			/>,
		)

		const group = container.querySelector('[data-journey-row^="group-"]')
		expect(group).not.toBeNull()

		act(() => observer().trigger([{ target: group!, isIntersecting: true }]))

		const reported = onVisibleRowsChange.mock.calls.at(-1)![0] as ReadonlySet<string>
		// The map's bars key on model rows, never on the group standing in for them.
		expect(reported.has("m20")).toBe(true)
		expect(model.mapBars.some((bar) => reported.has(bar.rowId))).toBe(true)
	})
})
