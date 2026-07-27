import { describe, expect, it } from "vitest"
import { defaultWidgetHeight } from "./dashboards"

describe("defaultWidgetHeight", () => {
	// The canvas is rowHeight 60 with a 12px gutter, so h:6 is a 420px tile.
	// Pinned because nothing else in the repo asserts these numbers, and they
	// used to be copy-pasted across six call sites that silently drifted apart.
	it("gives charts the tall default", () => {
		expect(defaultWidgetHeight("chart")).toEqual({ h: 6, minH: 2 })
	})

	it("treats every unrecognized visualization as a chart", () => {
		for (const visualization of ["gauge", "pie", "heatmap", "funnel", ""]) {
			expect(defaultWidgetHeight(visualization).h).toBe(6)
		}
	})

	it("keeps stats compact and row-based widgets at table height", () => {
		expect(defaultWidgetHeight("stat")).toEqual({ h: 2, minH: 2 })
		expect(defaultWidgetHeight("table")).toEqual({ h: 5, minH: 3 })
		expect(defaultWidgetHeight("list")).toEqual({ h: 5, minH: 3 })
		expect(defaultWidgetHeight("markdown")).toEqual({ h: 5, minH: 3 })
	})
})
