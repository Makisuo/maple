import { describe, expect, it } from "vitest"
import { isTimeRangeWithin, LONG_RANGE_PRESET_OPTIONS, presetLabel } from "./time-utils"

describe("long time-range presets", () => {
	it("exposes 3-month, 6-month, and one-year ranges inside the 365-day ceiling", () => {
		expect(LONG_RANGE_PRESET_OPTIONS.slice(-3).map(({ value }) => value)).toEqual(["3mo", "6mo", "12mo"])
		expect(presetLabel("12mo")).toBe("Last 1 year")

		// "365d" covers 365 calendar days with today as day one, so it starts at
		// local midnight 364 days ago: a whole year of data that still fits under
		// the exact 365-day maximum the service and alert endpoints enforce.
		const annual = LONG_RANGE_PRESET_OPTIONS.find(({ value }) => value === "12mo")!.getRange()
		const durationSeconds = (Date.parse(annual.endTime) - Date.parse(annual.startTime)) / 1000
		const day = 24 * 60 * 60
		expect(durationSeconds).toBeLessThanOrEqual(365 * day)
		expect(durationSeconds).toBeGreaterThan(364 * day)
	})

	it("validates both ISO and warehouse-format custom ranges against a page maximum", () => {
		const maximum = 365 * 24 * 60 * 60
		expect(
			isTimeRangeWithin(
				{
					startTime: "2025-07-15T12:00:00.000Z",
					endTime: "2026-07-15T12:00:00.000Z",
				},
				maximum,
			),
		).toBe(true)
		expect(
			isTimeRangeWithin({ startTime: "2025-07-14 12:00:00", endTime: "2026-07-15 12:00:00" }, maximum),
		).toBe(false)
	})
})
