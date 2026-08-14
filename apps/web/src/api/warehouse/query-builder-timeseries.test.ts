import { describe, expect, it } from "vitest"
import { LAB_EMPTY_RANGE_STRATEGY } from "@maple/query-engine/query-set"
import { __testables } from "@/api/warehouse/query-builder-timeseries"

// This module is now an adapter: the fan-out, fallback ladder, merge, comparison
// window and no-data diagnosis all live in `@maple/query-engine/query-set` and
// are tested there against an in-memory executor. What is still this module's own
// is translating the wire strategy shape, which `use-widget-data` depends on.

describe("resolveStrategy (wire shape → package shape)", () => {
	it("maps the wire field names onto the strategy the package takes", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
				strategy: {
					enableEmptyRangeFallback: true,
					fallbackWindowSeconds: [7200, 60],
					maxFallbackRangeSeconds: 86400,
				},
			}),
		).toEqual({ enabled: true, windowSeconds: [60, 7200], maxRangeSeconds: 86400 })
	})

	/**
	 * `use-widget-data` sends `enableEmptyRangeFallback: false` on every dashboard
	 * tile. If that stopped disabling the ladder, an empty tile would silently
	 * start charting data from outside its own time range.
	 */
	it("honours the dashboard tile's explicit opt-out", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
				strategy: { enableEmptyRangeFallback: false },
			}).enabled,
		).toBe(false)
	})

	it("defaults to the lab ladder when the caller sends no strategy", () => {
		expect(
			__testables.resolveStrategy({
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-01 01:00:00",
				queries: [],
			}),
		).toEqual(LAB_EMPTY_RANGE_STRATEGY)
	})
})
