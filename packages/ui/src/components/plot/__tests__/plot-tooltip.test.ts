import { describe, expect, it } from "vitest"

import { resolveTooltipHighlight, type PlotTooltipSeries, type TooltipFocus } from "../plot-tooltip"

/**
 * A 400px-tall plot over a `[0, 100]` domain: value 0 sits on the axis at y=400,
 * value 100 at the top at y=0. The real `mapY` comes off the resolved scale the
 * anchor captured; this is the same function, written out so the pixels in these
 * tests are readable.
 */
const mapY = (value: number) => 400 - value * 4

function focusAt(pointerY: number): TooltipFocus {
	return { pointerY, mapY }
}

interface Row {
	lower: number
	upper: number
}

/** One bucket: a thick band on the axis, a thin one riding on top of it. */
const ROW: Row = { lower: 50, upper: 2 }

const format = (value: number) => String(value)

/** The unstacked reading: each series is plotted AT its value. */
function unstackedSeries(): PlotTooltipSeries<Row>[] {
	return [
		{ label: "lower", color: "#111", value: (row) => row.lower, format },
		{ label: "upper", color: "#222", value: (row) => row.upper, format },
	]
}

/** The stacked reading: `upper` is plotted at `lower + upper`, its top edge. */
function stackedSeries(): PlotTooltipSeries<Row>[] {
	return [
		{ label: "lower", color: "#111", value: (row) => row.lower, position: (row) => row.lower, format },
		{
			label: "upper",
			color: "#222",
			value: (row) => row.upper,
			position: (row) => row.lower + row.upper,
			format,
		},
	]
}

describe("resolveTooltipHighlight", () => {
	it("emphasises the stacked band under the cursor, not the one its raw value lands on", () => {
		// The cursor sits exactly on the upper band's top edge (50 + 2 = 52).
		const pointer = focusAt(mapY(52))

		// Read from raw values — which is all the tooltip had before series could
		// state a position — the two candidates are 50 (8px away, inside the 24px
		// radius) and 2 (200px away). The thin band the cursor is actually on loses
		// to the thick one beneath it.
		expect(resolveTooltipHighlight(unstackedSeries(), ROW, pointer)).toBe("lower")

		// With the plotted positions, the band under the cursor wins outright.
		expect(resolveTooltipHighlight(stackedSeries(), ROW, pointer)).toBe("upper")
	})

	it("emphasises the lower band when the cursor is on ITS edge", () => {
		// Sanity that the stacked reading did not simply invert the answer: at
		// y=mapY(50) the lower band's own top edge is the nearest thing.
		expect(resolveTooltipHighlight(stackedSeries(), ROW, focusAt(mapY(50)))).toBe("lower")
	})

	it("falls back to the raw value when a series states no position", () => {
		// The line chart's reference behaviour: nearest plotted point wins.
		expect(resolveTooltipHighlight(unstackedSeries(), ROW, focusAt(mapY(2)))).toBe("upper")
		expect(resolveTooltipHighlight(unstackedSeries(), ROW, focusAt(mapY(50)))).toBe("lower")
	})

	it("emphasises nothing when the cursor is further than the highlight radius", () => {
		// Halfway between the two bands (26 → 6.5px per unit of value away from
		// each), so both sit well outside 24px and hovering empty space bolds
		// nothing.
		expect(resolveTooltipHighlight(unstackedSeries(), ROW, focusAt(mapY(26)))).toBeUndefined()
	})

	it("emphasises nothing on a single-series chart", () => {
		// There is no ambiguity to resolve, and bolding the only row is just noise.
		const single = unstackedSeries().slice(0, 1)
		expect(resolveTooltipHighlight(single, ROW, focusAt(mapY(50)))).toBeUndefined()
	})

	it("emphasises nothing before the anchor has captured a pointer and a scale", () => {
		expect(resolveTooltipHighlight(stackedSeries(), ROW, { pointerY: null, mapY: null })).toBeUndefined()
		expect(resolveTooltipHighlight(stackedSeries(), ROW, { pointerY: 100, mapY: null })).toBeUndefined()
	})

	it("skips a series with no reading in this bucket", () => {
		// A sparse group-by omits a key from the buckets where it had no events;
		// that series has no plotted point to be nearest to.
		const sparse: PlotTooltipSeries<Row>[] = [
			{ label: "lower", color: "#111", value: () => null, position: () => null, format },
			{
				label: "upper",
				color: "#222",
				value: (row) => row.upper,
				position: (row) => row.lower + row.upper,
				format,
			},
		]
		expect(resolveTooltipHighlight(sparse, ROW, focusAt(mapY(52)))).toBe("upper")
		// …and the absent series cannot be picked in its stead down where its
		// values would have been.
		expect(resolveTooltipHighlight(sparse, ROW, focusAt(mapY(20)))).toBeUndefined()
	})
})
