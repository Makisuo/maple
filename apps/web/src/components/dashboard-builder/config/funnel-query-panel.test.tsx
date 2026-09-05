// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defaultFunnelDraft, type FunnelWidgetDraft } from "@/lib/query-builder/widget-builder-shared"
import { FunnelQueryPanelView } from "./funnel-query-panel"

// The view takes its suggestions as a prop; the fetching wrapper is what the
// editor page mounts, and the suggestions are not what is under test.
const NO_SUGGESTIONS = { eventNames: [], pagePaths: [], facets: {} }

afterEach(cleanup)

const draft = (overrides: Partial<FunnelWidgetDraft> = {}): FunnelWidgetDraft => ({
	...defaultFunnelDraft(),
	source: "product_events",
	steps: [{ kind: "event", eventName: "signup_completed" }],
	...overrides,
})

/** Apply every updater the panel emitted to the draft it was rendered with. */
function renderPanel(initial: FunnelWidgetDraft, onSourceChange = vi.fn()) {
	let current = initial
	const onUpdate = vi.fn((updater: (funnel: FunnelWidgetDraft) => FunnelWidgetDraft) => {
		current = updater(current)
	})
	const utils = render(
		<FunnelQueryPanelView
			funnel={initial}
			onUpdate={onUpdate}
			onSourceChange={onSourceChange}
			suggestions={NO_SUGGESTIONS}
		/>,
	)
	return { ...utils, onUpdate, latest: () => current }
}

describe("FunnelQueryPanel", () => {
	it("wears the query-panel chrome: the A badge and a source select on Product events", () => {
		renderPanel(draft())
		expect(screen.getByText("A")).toBeTruthy()
		expect(screen.getByRole("combobox", { name: "Query source" }).textContent).toContain("Product events")
		expect(screen.getByLabelText("Step 1 event name")).toBeTruthy()
		expect(screen.getByLabelText("Funnel population filter")).toBeTruthy()
	})

	it("reveals Count by through the add-on bar and resets it to the default when toggled off", () => {
		const { latest } = renderPanel(
			draft({ keyBy: "session", addOns: { keyBy: true, window: false, breakdown: false } }),
		)
		expect(screen.getByRole("combobox", { name: "Count by" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Count by" }))
		expect(latest().addOns.keyBy).toBe(false)
		expect(latest().keyBy).toBe("person")
	})

	it("drops the breakdown when its add-on is toggled off", () => {
		const { latest } = renderPanel(
			draft({ breakdownBy: "referrerHost", addOns: { keyBy: false, window: false, breakdown: true } }),
		)
		fireEvent.click(screen.getByRole("button", { name: "Breakdown" }))
		expect(latest().breakdownBy).toBeUndefined()
	})

	it("names the problem with a population filter it cannot compile", () => {
		renderPanel(draft({ filterClause: 'plan = "pro"' }))
		expect(screen.getByText(/is not a filter key/)).toBeTruthy()
	})

	it("offers the query-builder sources beside Product events, so the widget can go back to its query set", () => {
		renderPanel(draft())
		fireEvent.click(screen.getByRole("combobox", { name: "Query source" }))
		for (const name of ["Traces", "Logs", "Metrics", "Product events"]) {
			expect(screen.getByRole("option", { name })).toBeTruthy()
		}
	})
})
