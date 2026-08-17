import { describe, expect, it } from "vitest"

import {
	DEFAULT_WIDGET_WIDTH_PX,
	MIN_BAR_WIDTH_PX,
	WIDTH_STEP_PX,
	maxDataPointsForWidth,
	quantizeWidthPx,
} from "./use-widget-max-data-points"

describe("quantizeWidthPx", () => {
	it("rounds down to the step so a drag-resize does not refetch per pixel", () => {
		expect(quantizeWidthPx(1399)).toBe(1300)
		expect(quantizeWidthPx(1400)).toBe(1400)
		expect(quantizeWidthPx(1400.7)).toBe(1400)
	})

	it("never goes below one step, and is undefined until measured", () => {
		expect(quantizeWidthPx(40)).toBe(WIDTH_STEP_PX)
		expect(quantizeWidthPx(0)).toBeUndefined()
		expect(quantizeWidthPx(undefined)).toBeUndefined()
		expect(quantizeWidthPx(Number.NaN)).toBeUndefined()
	})
})

describe("maxDataPointsForWidth", () => {
	it("is one point per pixel for lines and areas", () => {
		expect(maxDataPointsForWidth(1400, "line")).toBe(1400)
		expect(maxDataPointsForWidth(DEFAULT_WIDGET_WIDTH_PX, "area")).toBe(DEFAULT_WIDGET_WIDTH_PX)
	})

	it("gives bars a minimum width", () => {
		expect(maxDataPointsForWidth(1400, "bar")).toBe(Math.floor(1400 / MIN_BAR_WIDTH_PX))
	})
})
