import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderLineChart } from "../../charts/line/query-builder-line-chart"
import { PlotLegendSlotContext, type PlotLegendItem } from "../plot-frame"
import { legendPlacementFor } from "../timeseries"

// jsdom lays nothing out, so nothing here proves the legend ENDS UP beside the
// plot. What it proves is which arm rendered — see `plot-frame-legend-placement`
// for the same split at the frame level.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

afterEach(cleanup)

const rows = [
	{ bucket: "2026-08-18T10:00:00Z", api: 12, web: 7 },
	{ bucket: "2026-08-18T10:01:00Z", api: 15, web: 9 },
	{ bucket: "2026-08-18T10:02:00Z", api: 11, web: 8 },
]

/**
 * The dashboard shell's slot, recording what a chart published so the two arms
 * of the legend decision — hoist, or draw — can be asserted from one place.
 */
function withSlot(node: React.ReactNode) {
	const published: PlotLegendItem[][] = []
	const slot = { setItems: (items: readonly PlotLegendItem[]) => published.push([...items]) }
	const view = render(<PlotLegendSlotContext value={slot}>{node}</PlotLegendSlotContext>)
	return { ...view, published }
}

/** The strip the chart draws itself, as opposed to the one a host draws. */
function ownStrip(container: HTMLElement): HTMLElement | null {
	return container.querySelector("[data-chart-host] button")
}

describe("legendPlacementFor", () => {
	it("maps the right-hand mode to the frame's right placement", () => {
		// The bug this closes: every timeseries chart passed its legend and left
		// `legendPlacement` at "bottom", so `legend="right"` rendered a vertical
		// column — one series per row, height-capped to the container — and then
		// stacked it UNDER the plot, which is what "right" was added to prevent.
		expect(legendPlacementFor("right")).toBe("right")
	})

	it("leaves every other mode at the bottom", () => {
		expect(legendPlacementFor("visible")).toBe("bottom")
		expect(legendPlacementFor("hidden")).toBe("bottom")
		expect(legendPlacementFor(undefined)).toBe("bottom")
	})
})

describe("the line chart's legend", () => {
	it("places a right-hand legend beside the plot, not under it", () => {
		const { container } = render(<QueryBuilderLineChart data={rows} legend="right" />)
		expect(container.querySelector("[data-chart-legend-row]")).not.toBeNull()
	})

	it("keeps a visible legend under the plot", () => {
		const { container } = render(<QueryBuilderLineChart data={rows} legend="visible" />)
		expect(container.querySelector("[data-chart-legend-row]")).toBeNull()
	})

	it("hoists into an open slot instead of drawing its own strip", () => {
		// A dashboard tile: the card header prints the series, so a strip here
		// would print them a second time.
		const { container, published } = withSlot(<QueryBuilderLineChart data={rows} legend="hidden" />)
		expect(published.at(-1)?.map((item) => item.label)).toEqual(["api", "web"])
		expect(ownStrip(container)).toBeNull()
	})

	it("draws its own strip and publishes nothing when the mode is visible", () => {
		// The two arms are one decision now. Before, the model answered "publish?"
		// and the legend answered "draw?" independently, so a chart that failed to
		// thread the mode into the model did both and printed its series twice.
		const { container, published } = withSlot(<QueryBuilderLineChart data={rows} legend="visible" />)
		expect(published.every((items) => items.length === 0)).toBe(true)
		expect(ownStrip(container)).not.toBeNull()
	})
})
