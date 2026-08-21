import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { HeatmapColorScale } from "@maple/domain/http"
import { QueryBuilderHeatmapChart } from "../query-builder-heatmap-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the cells
// inspectable as real rects carrying their resolved fill.
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

/** The grid's rects, in the order the marks emitted them. */
function cellRects(container: HTMLElement): SVGRectElement[] {
	return [...container.querySelectorAll("rect")].filter((rect) => {
		const fill = rect.getAttribute("fill")
		return fill != null && fill !== "none" && fill !== "transparent"
	})
}

function fillsByValue(container: HTMLElement, order: readonly string[]): Map<string, string> {
	const rects = cellRects(container)
	const byLabel = new Map<string, string>()
	order.forEach((label, index) => {
		const fill = rects[index]?.getAttribute("fill")
		if (fill) byLabel.set(label, fill)
	})
	return byLabel
}

/**
 * A colour's OKLCH channels.
 *
 * Compared numerically rather than as strings: the ramp emits stop literals
 * verbatim at the exact endpoints and formatted (`0.8500 0.1300 78.00`) a
 * floating-point hair away from them, and a log scale reaches t=1 as
 * 0.9999999999 — which is the same colour and a different string.
 */
function oklchOf(color: string | undefined): [number, number, number] {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([-\d.]+)/.exec(color ?? "")
	if (!match) throw new Error(`not an oklch() colour: ${String(color)}`)
	return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function expectColor(actual: string | undefined, expected: string): void {
	const [l, c, h] = oklchOf(actual)
	const [el, ec, eh] = oklchOf(expected)
	expect(l).toBeCloseTo(el, 3)
	expect(c).toBeCloseTo(ec, 3)
	expect(h).toBeCloseTo(eh, 2)
}

/** Every axis tick label the chart drew. */
function axisLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("text")].map((node) => node.textContent ?? "")
}

/**
 * A single row of cells with a wide spread, so linear and log place the middle
 * value in visibly different places along the ramp.
 */
const spreadRows = [
	{ x: "a", y: "only", value: 1 },
	{ x: "b", y: "only", value: 10 },
	{ x: "c", y: "only", value: 100 },
]

describe("query-builder heatmap: colour scaling", () => {
	it("maps the endpoints to the ramp's own stops under both scale types", () => {
		for (const scaleType of ["linear", "log"] as const) {
			const { container, unmount } = render(
				<QueryBuilderHeatmapChart data={spreadRows} scaleType={scaleType} />,
			)
			const fills = fillsByValue(container, ["a", "b", "c"])
			// The bottom and top stops are the palette's own tokens, un-mixed. In
			// jsdom no stylesheet resolves `--heatmap-amber-*`, so what lands is the
			// literal fallback the token table carries.
			expectColor(fills.get("a"), "oklch(0.32 0.035 70)")
			expectColor(fills.get("c"), "oklch(0.85 0.13 78)")
			unmount()
		}
	})

	it("places the middle value differently under log than under linear", () => {
		// 10 sits 9% of the way from 1 to 100 linearly and exactly halfway in log
		// space, so the mid cell is near the bottom of the ramp under one and in
		// its middle under the other. This is the whole reason `scaleType` exists.
		const linear = render(<QueryBuilderHeatmapChart data={spreadRows} scaleType="linear" />)
		const linearMid = fillsByValue(linear.container, ["a", "b", "c"]).get("b")
		linear.unmount()

		const log = render(<QueryBuilderHeatmapChart data={spreadRows} scaleType="log" />)
		const logMid = fillsByValue(log.container, ["a", "b", "c"]).get("b")
		log.unmount()

		expect(linearMid).toBeDefined()
		expect(logMid).toBeDefined()
		expect(logMid).not.toBe(linearMid)

		// Lightness is monotone along the amber ramp (0.32 → 0.85), so it is a
		// direct read on how far up the ramp a cell landed.
		expect(oklchOf(logMid)[0]).toBeGreaterThan(oklchOf(linearMid)[0])
	})

	it("keeps a single-valued grid on the bottom stop", () => {
		// No spread means no ramp to walk. A degenerate d3 domain would park every
		// cell at the ramp's MIDPOINT, which reads as "all warm" for data that says
		// nothing of the kind.
		const { container } = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "a", y: "only", value: 7 },
					{ x: "b", y: "only", value: 7 },
				]}
			/>,
		)
		for (const rect of cellRects(container)) {
			expectColor(rect.getAttribute("fill") ?? undefined, "oklch(0.32 0.035 70)")
		}
	})
})

describe("query-builder heatmap: the colour scale prop", () => {
	it("defaults to amber and honours a named scale", () => {
		const amber = render(<QueryBuilderHeatmapChart data={spreadRows} />)
		const amberTop = fillsByValue(amber.container, ["a", "b", "c"]).get("c")
		amber.unmount()

		const blues = render(<QueryBuilderHeatmapChart data={spreadRows} colorScale="blues" />)
		const bluesTop = fillsByValue(blues.container, ["a", "b", "c"]).get("c")
		blues.unmount()

		expectColor(amberTop, "oklch(0.85 0.13 78)")
		expectColor(bluesTop, "oklch(0.85 0.11 238)")
	})

	it("falls back to amber for a scale name it no longer ships", () => {
		// SAFETY: a dashboard persisted months ago can carry a colour scale that has
		// since been renamed. The runtime guard, not the prop type, is under test.
		const retired = "sunset" as HeatmapColorScale
		const { container } = render(<QueryBuilderHeatmapChart data={spreadRows} colorScale={retired} />)
		expectColor(fillsByValue(container, ["a", "b", "c"]).get("c"), "oklch(0.85 0.13 78)")
	})
})

describe("query-builder heatmap: empty-track pruning", () => {
	const rows = [
		{ x: "live", y: "row-a", value: 4 },
		{ x: "live", y: "row-b", value: 0 },
		{ x: "quiet", y: "row-a", value: 0 },
		{ x: "quiet", y: "row-b", value: 0 },
	]

	it("drops the all-zero column and row and reports both", () => {
		const { container } = render(<QueryBuilderHeatmapChart data={rows} />)
		const labels = axisLabels(container)
		expect(labels).toContain("live")
		expect(labels).not.toContain("quiet")
		expect(labels).toContain("row-a")
		expect(labels).not.toContain("row-b")
		// Reported, never dropped silently — a trimmed grid otherwise reads as the
		// whole result.
		expect(container.textContent ?? "").toContain("1 empty column · 1 empty row hidden")
	})

	it("prunes the data with the domain, not just the axis", () => {
		// A datum whose band value is not in the pinned domain does not disappear:
		// the scale maps it to nothing and the rect lands at x=0, on top of the
		// first surviving column. One cell survives here, so one rect is drawn.
		const { container } = render(<QueryBuilderHeatmapChart data={rows} />)
		expect(cellRects(container)).toHaveLength(1)
	})

	it("says nothing when nothing was hidden", () => {
		const { container } = render(<QueryBuilderHeatmapChart data={spreadRows} />)
		expect(container.textContent ?? "").not.toContain("hidden")
	})

	it("keeps an all-zero result intact rather than pruning it to nothing", () => {
		// "Nothing happened" is a real answer. Pruning every track would turn it
		// into the empty state, which says something different.
		const { container } = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "a", y: "one", value: 0 },
					{ x: "b", y: "one", value: 0 },
				]}
			/>,
		)
		const labels = axisLabels(container)
		expect(labels).toContain("a")
		expect(labels).toContain("b")
		expect(container.textContent ?? "").not.toContain("hidden")
	})
})

describe("query-builder heatmap: holes", () => {
	it("draws an absent slot as grout rather than leaving it focusable-free", () => {
		// Two columns, two rows, three rows of data: the fourth slot has no value
		// and must still exist, so hovering it can say "no data" instead of
		// `focus: "nearest"` reporting a neighbour's count.
		const { container } = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "a", y: "one", value: 1 },
					{ x: "a", y: "two", value: 2 },
					{ x: "b", y: "one", value: 3 },
				]}
			/>,
		)
		const fills = cellRects(container).map((rect) => rect.getAttribute("fill"))
		expect(fills).toHaveLength(4)
		expect(fills.filter((fill) => fill === "oklch(0.175 0.008 62)")).toHaveLength(1)
	})
})
