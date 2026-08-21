import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderHistogramChart } from "../query-builder-histogram-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the bins
// inspectable as real rects.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

/** The plot rect, off the anchor `PlotFrame` positions from `onRender`. */
function plotRect(container: HTMLElement): { top: number; bottom: number } {
	const node = container.querySelector<HTMLElement>("[data-chart-plot]")
	if (!node) throw new Error("no plot anchor")
	const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform)
	const top = Number(match?.[2] ?? 0)
	return { top, bottom: top + Number.parseFloat(node.style.height) }
}

function binRects(container: HTMLElement): SVGRectElement[] {
	return [...container.querySelectorAll("rect")].filter((rect) => {
		const fill = rect.getAttribute("fill")
		return fill != null && fill !== "none" && fill !== "transparent"
	})
}

/**
 * A max count that is NOT a multiple of its own tick step — the trigger. 137
 * over five ticks rounds the step to 28, which walks to 112 and stops, so an
 * unrounded ceiling loses the top quarter of the axis.
 */
const awkwardBins = [
	{ name: "0-10", value: 137 },
	{ name: "10-20", value: 40 },
	{ name: "20-30", value: 9 },
]

describe("histogram: the count axis is niced", () => {
	it("keeps every tick inside the plot", () => {
		const { container } = render(<QueryBuilderHistogramChart data={awkwardBins} />)
		const rect = plotRect(container)
		const tickYs = [...container.querySelectorAll("text")].map((node) => Number(node.getAttribute("y")))
		expect(tickYs.length).toBeGreaterThan(0)
		for (const y of tickYs) {
			expect(y).toBeGreaterThanOrEqual(rect.top - 0.5)
		}
	})

	it("labels the rounded ceiling above the tallest bin", () => {
		const { container } = render(<QueryBuilderHistogramChart data={awkwardBins} />)
		const labels = [...container.querySelectorAll("text")].map((node) => node.textContent)
		// [0, 137] nices to [0, 140]; without that the axis stopped at 112 and the
		// space between 112 and the tallest bin carried no gridline at all.
		expect(labels).toContain("140")
	})

	it("leaves the tallest bin headroom instead of touching the top edge", () => {
		const { container } = render(<QueryBuilderHistogramChart data={awkwardBins} />)
		const rect = plotRect(container)
		const highest = Math.min(...binRects(container).map((bin) => Number(bin.getAttribute("y"))))
		expect(highest).toBeGreaterThan(rect.top)
	})

	it("paints the bins opaque, as Recharts did", () => {
		const { container } = render(<QueryBuilderHistogramChart data={awkwardBins} />)
		for (const bin of binRects(container)) {
			const opacity = bin.getAttribute("fill-opacity")
			expect(opacity == null || Number(opacity) === 1).toBe(true)
		}
	})

	it("nices a numeric histogram's axis too", () => {
		// The numeric path bins raw observations and shares `useCountAxis`, so the
		// same rounding has to reach it.
		const rows = Array.from({ length: 137 }, () => ({ latency: 5 }))
		const { container } = render(<QueryBuilderHistogramChart data={rows} />)
		const rect = plotRect(container)
		for (const node of container.querySelectorAll("text")) {
			expect(Number(node.getAttribute("y"))).toBeGreaterThanOrEqual(rect.top - 0.5)
		}
	})
})
