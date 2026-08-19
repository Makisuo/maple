import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { resolveSequentialDomain } from "../../../plot/color-scale"
import { QueryBuilderHeatmapChart, solveHeatmapLayout, truncateYLabel } from "../query-builder-heatmap-chart"

// Same harness as the sibling spec: jsdom has no ResizeObserver and lays nothing
// out, so the box is stubbed and `PlotFrame` degrades to the SVG renderer, which
// is what makes the cells and labels inspectable as DOM.
const CONTAINER_W = 800
const CONTAINER_H = 400

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
		right: CONTAINER_W,
		bottom: CONTAINER_H,
		width: CONTAINER_W,
		height: CONTAINER_H,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

function cellFills(container: HTMLElement): string[] {
	return [...container.querySelectorAll("rect")]
		.map((rect) => rect.getAttribute("fill"))
		.filter((fill): fill is string => fill != null && fill !== "none" && fill !== "transparent")
}

function oklchOf(color: string | undefined): [number, number, number] {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([-\d.]+)/.exec(color ?? "")
	if (!match) throw new Error(`not an oklch() colour: ${String(color)}`)
	return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** The legend's tick texts — the swatches carry no text of their own. */
function legendTicks(container: HTMLElement): string[] {
	const legend = container.querySelector("[data-heatmap-legend]")
	if (!legend) throw new Error("no legend rendered")
	// Leaf nodes only — the rows that CONTAIN the ticks would otherwise report
	// their children's text concatenated.
	return [...legend.querySelectorAll("div")]
		.filter((node) => node.childElementCount === 0)
		.map((node) => node.textContent ?? "")
		.filter((text) => text.length > 0)
}

/**
 * Sub-1 values under a log scale: an error ratio, an apdex, a seconds-valued
 * grid. Every one of these is a real heatmap someone can build.
 */
const subUnitRows = [
	{ x: "a", y: "r", value: 0.02 },
	{ x: "b", y: "r", value: 0.4 },
	{ x: "c", y: "r", value: 0.9 },
]

describe("log colour domain below 1", () => {
	it("keeps the domain ascending instead of inverting it at the floor", () => {
		// A flat `Math.max(min, 1)` produced `[1, 0.9]`, and `scaleSequentialLog`
		// then divided by a NEGATIVE `log(0.9/1)`: 0.02, 0.4 and 0.9 came back at
		// t = 37.1, 8.7 and 1.0, all clamped to the hottest stop.
		expect(resolveSequentialDomain([0.02, 0.9], "log")).toEqual([0.02, 0.9])
		// `max === 1` exactly was the same shape with a zero denominator (t = NaN).
		expect(resolveSequentialDomain([0.25, 1], "log")).toEqual([0.25, 1])
	})

	it("still floors a count-valued domain at 1, and never above the maximum", () => {
		// The count case the floor exists for is untouched: a zero-count cell has to
		// land on the bottom stop.
		expect(resolveSequentialDomain([0, 90], "log")).toEqual([1, 90])
		// With no positive minimum AND a sub-1 maximum the fallback has to stay
		// below the maximum, or the inversion is back.
		const [lo, hi] = resolveSequentialDomain([0, 0.5], "log")
		expect(lo).toBeGreaterThan(0)
		expect(lo).toBeLessThan(hi)
	})

	it("leaves a linear domain alone", () => {
		expect(resolveSequentialDomain([0, 0.9], "linear")).toEqual([0, 0.9])
	})

	it("paints a sub-1 grid across the ramp rather than all on the top stop", () => {
		const { container } = render(<QueryBuilderHeatmapChart data={subUnitRows} scaleType="log" />)
		const fills = cellFills(container)
		expect(fills).toHaveLength(3)

		// Lightness is monotone along the amber ramp (0.32 → 0.85), so it reads
		// directly as "how far up the ramp".
		const lightness = fills.map((fill) => oklchOf(fill)[0])
		expect(lightness[0]).toBeCloseTo(0.32, 2)
		expect(lightness[2]).toBeCloseTo(0.85, 2)
		expect(lightness[0]).toBeLessThan(lightness[1])
		expect(lightness[1]).toBeLessThan(lightness[2])
	})

	it("labels the legend from the same resolved domain the cells were painted with", () => {
		// The legend used to floor BOTH ends, so `lo === hi === 1` and all three
		// ticks read `1` beside a grid of sub-1 values.
		const { container } = render(<QueryBuilderHeatmapChart data={subUnitRows} scaleType="log" />)
		const ticks = legendTicks(container)
		expect(ticks).toHaveLength(3)
		expect(new Set(ticks).size).toBe(3)
		expect(ticks).not.toContain("1")
	})
})

describe("heatmap layout: the y gutter is bounded", () => {
	const longLabels = "checkout-service-prod-eu-west-1".length

	it("caps the gutter and hands back a character budget that fits inside it", () => {
		const layout = solveHeatmapLayout({
			containerW: 480,
			containerH: 320,
			columns: 12,
			rows: 6,
			longestYLabelChars: longLabels,
			hasFootnote: false,
		})
		// Unbounded, the axis measured the full string and took ~230px of a 480px
		// widget. The old CSS grid clamped to 96 and ellipsised inside it.
		expect(layout.margin?.left).toBe(96)
		expect(layout.gutter).toBe(96)
		expect(layout.yLabelChars).toBeLessThan(longLabels)
		// The grid keeps everything the gutter did not take.
		expect(layout.margin?.right).toBe(0)
	})

	it("shrinks the gutter for short labels rather than always spending the cap", () => {
		const layout = solveHeatmapLayout({
			containerW: 480,
			containerH: 320,
			columns: 12,
			rows: 6,
			longestYLabelChars: 3,
			hasFootnote: false,
		})
		expect(layout.gutter).toBe(36)
	})

	it("ellipsises a label into its budget and leaves a short one alone", () => {
		expect(truncateYLabel("checkout-service-prod-eu-west-1", 13)).toBe("checkout-ser…")
		expect(truncateYLabel("0-100ms", 13)).toBe("0-100ms")
	})

	it("draws the truncated label, so nothing is painted outside the locked gutter", () => {
		const { container } = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "a", y: "checkout-service-prod-eu-west-1", value: 1 },
					{ x: "a", y: "payments-worker-prod-us-east-1", value: 2 },
				]}
			/>,
		)
		const labels = [...container.querySelectorAll("text")].map((node) => node.textContent ?? "")
		expect(labels).not.toContain("checkout-service-prod-eu-west-1")
		expect(labels.some((label) => label.endsWith("…"))).toBe(true)
	})
})

describe("heatmap layout: a capped grid keeps its axes", () => {
	// 4 columns × 3 rows on a ~700×320 card: both axes cap, and the surplus used
	// to be bought back as `paddingOuter`, which centred the grid inside the plot
	// rect while the axis labels stayed at the RECT's edges.
	const capped = solveHeatmapLayout({
		containerW: 700,
		containerH: 320,
		columns: 4,
		rows: 3,
		longestYLabelChars: 6,
		hasFootnote: false,
	})

	it("spends the horizontal surplus as right margin, not as centring", () => {
		const margin = capped.margin
		if (!margin) throw new Error("expected a measured layout")
		// 4 capped cells and 3 seams.
		const gridW = 4 * 72 + 3 * 2
		expect(700 - margin.left - margin.right).toBe(gridW)
		expect(margin.right).toBeGreaterThan(0)
		// The gutter is where the y labels are drawn, so the grid starts there —
		// flush to the first column.
		expect(margin.left).toBe(capped.gutter)
	})

	it("top-anchors the grid and puts the x axis immediately beneath it", () => {
		const margin = capped.margin
		if (!margin) throw new Error("expected a measured layout")
		const gridH = 3 * 40 + 2 * 2
		const chartBoxH = 320 - 34 // the legend strip is a sibling of the plot
		expect(margin.top).toBe(2)
		expect(chartBoxH - margin.top - margin.bottom).toBe(gridH)
	})

	it("keeps the seam at the grout width once the plot rect IS the grid", () => {
		// `bandwidth = (length - (count - 1) * gap) / count` holds only when
		// paddingInner is solved against the length the axis really gets.
		const gridW = 4 * 72 + 3 * 2
		const step = gridW / (4 - capped.paddingInnerX)
		expect(step * (1 - capped.paddingInnerX)).toBeCloseTo(72, 6)
	})
})

describe("heatmap layout: the legend spans the columns", () => {
	it("insets the legend and the footnote by the plot's own margins", () => {
		const { container } = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "a", y: "one", value: 4 },
					{ x: "b", y: "one", value: 9 },
					{ x: "a", y: "quiet", value: 0 },
					{ x: "b", y: "quiet", value: 0 },
				]}
			/>,
		)
		const expected = solveHeatmapLayout({
			containerW: CONTAINER_W,
			containerH: CONTAINER_H,
			columns: 2,
			rows: 1,
			longestYLabelChars: 3,
			hasFootnote: true,
		})
		expect(expected.rightInset).toBeGreaterThan(0)

		const legend = container.querySelector("[data-heatmap-legend]")
		if (!(legend instanceof HTMLElement)) throw new Error("no legend rendered")
		expect(legend.style.paddingLeft).toBe(`${expected.gutter}px`)
		expect(legend.style.paddingRight).toBe(`${expected.rightInset}px`)

		// The footnote is right-aligned, so it needs the same right inset to land
		// under the last column rather than under the card's edge.
		const footnote = [...container.querySelectorAll("p")].find((node) =>
			(node.textContent ?? "").includes("hidden"),
		)
		if (!footnote) throw new Error("no footnote rendered")
		expect(footnote.style.paddingRight).toBe(`${expected.rightInset}px`)
	})
})
