import { describe, expect, it } from "vitest"

import { computeTimeAxisTicks, tickIntervalForWidth } from "../use-trace-timeline"
import { MIN_TICK_PX } from "../trace-timeline-types"
import { formatDurationAtStep } from "../../../lib/format"

describe("tickIntervalForWidth", () => {
	// The whole point of budgeting by width rather than a fixed count: the same window must
	// yield fewer ticks on a narrow panel and more on a wide one.
	it.each([300, 800, 2000])("keeps ticks at least MIN_TICK_PX apart at %ipx", (widthPx) => {
		for (const visibleMs of [0.5, 12, 950, 10_000, 420_000]) {
			const interval = tickIntervalForWidth(visibleMs, widthPx)
			const count = Math.floor(visibleMs / interval)
			expect(count * MIN_TICK_PX).toBeLessThanOrEqual(widthPx)
		}
	})

	it("gives a wider column more ticks for the same window", () => {
		const narrow = tickIntervalForWidth(10_000, 300)
		const wide = tickIntervalForWidth(10_000, 2000)
		expect(wide).toBeLessThan(narrow)
	})

	it("survives a window past the top of the nice-interval ladder", () => {
		const interval = tickIntervalForWidth(45 * 60_000, 800)
		expect(Number.isFinite(interval)).toBe(true)
		expect(interval).toBeGreaterThan(0)
	})
})

describe("computeTimeAxisTicks", () => {
	it("covers the window with evenly spaced offsets from the trace start", () => {
		const { ticks, intervalMs } = computeTimeAxisTicks(
			{ startMs: 1_000, endMs: 3_000 },
			1_000, // traceStartMs → offsets run 0…2000
			800,
		)
		expect(ticks.length).toBeGreaterThan(1)
		expect(ticks[0]).toBeGreaterThanOrEqual(0)
		expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(2_000)
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i] - ticks[i - 1]).toBeCloseTo(intervalMs, 6)
		}
	})

	it("returns nothing for a degenerate window or an unmeasured column", () => {
		expect(computeTimeAxisTicks({ startMs: 5, endMs: 5 }, 0, 800).ticks).toEqual([])
		expect(computeTimeAxisTicks({ startMs: 0, endMs: 100 }, 0, 0).ticks).toEqual([])
	})
})

describe("formatDurationAtStep", () => {
	// The bug this exists for: at deep zoom the fixed-precision formatter rendered "1.5ms"
	// for three consecutive ticks, so the ruler read as if it had stopped moving.
	it.each([
		[0.5, 800],
		[12, 800],
		[950, 300],
		[10_000, 2000],
		[420_000, 800],
	])("never repeats a label across the ruler (%ims window, %ipx)", (visibleMs, widthPx) => {
		const { ticks, intervalMs } = computeTimeAxisTicks({ startMs: 0, endMs: visibleMs }, 0, widthPx)
		const labels = ticks.map((t) => formatDurationAtStep(t, intervalMs))
		expect(new Set(labels).size).toBe(labels.length)
	})

	it("keeps sub-millisecond steps in microseconds", () => {
		expect(formatDurationAtStep(0.05, 0.01)).toBe("50μs")
		expect(formatDurationAtStep(0.123, 0.001)).toBe("123μs")
	})

	it("adds decimals only when the step needs them", () => {
		expect(formatDurationAtStep(500, 100)).toBe("500ms")
		expect(formatDurationAtStep(500.5, 0.5)).toBe("500.5ms")
		expect(formatDurationAtStep(2_000, 1_000)).toBe("2s")
	})

	it("returns a placeholder rather than NaN for a non-finite value", () => {
		expect(formatDurationAtStep(Number.NaN, 1)).toBe("—")
	})
})
