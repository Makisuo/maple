import { describe, expect, it } from "vitest"

import {
	computeSeriesStats,
	isAllZeroStats,
	sortZeroSeriesLast,
	type SeriesStats,
	type StatsSeries,
} from "../series-stats"

function series(...keys: string[]): StatsSeries[] {
	return keys.map((key) => ({ key, label: key, color: "#000" }))
}

const ROWS = [
	{ bucket: "2026-08-18T00:00:00", "demo-api": 4, "zzz-idle": 0 },
	{ bucket: "2026-08-18T00:01:00", "demo-api": 6, "zzz-idle": 0 },
]

describe("computeSeriesStats", () => {
	it("summarises a series over the rows", () => {
		const stats = computeSeriesStats(ROWS, ["demo-api"])
		expect(stats["demo-api"]).toEqual({ min: 4, max: 6, mean: 5, last: 6 })
	})

	it("reports zeros for a series with no numeric values", () => {
		const stats = computeSeriesStats(ROWS, ["absent"])
		expect(stats.absent).toEqual({ min: 0, max: 0, mean: 0, last: 0 })
	})
})

describe("isAllZeroStats", () => {
	it("treats a flat-zero series and a missing one alike", () => {
		expect(isAllZeroStats({ min: 0, max: 0, mean: 0, last: 0 })).toBe(true)
		expect(isAllZeroStats(undefined)).toBe(true)
		expect(isAllZeroStats({ min: 0, max: 6, mean: 5, last: 6 })).toBe(false)
		// A series that is entirely NEGATIVE still carries data.
		expect(isAllZeroStats({ min: -3, max: 0, mean: -1, last: 0 })).toBe(false)
	})
})

describe("sortZeroSeriesLast", () => {
	/**
	 * MAP-49: a legend that lists an all-zero series first buries the series that
	 * actually have data. Declaration order is alphabetical often enough that this
	 * is the common case, not the exotic one.
	 */
	it("sinks an all-zero series below one that carries data", () => {
		const stats = computeSeriesStats(ROWS, ["zzz-idle", "demo-api"])
		const sorted = sortZeroSeriesLast(series("zzz-idle", "demo-api"), stats)
		expect(sorted.map((entry) => entry.key)).toEqual(["demo-api", "zzz-idle"])
	})

	it("keeps the incoming order among series that carry data", () => {
		// The legend order has to match the paint order or the swatches stop
		// identifying anything, so the sort must be stable.
		const stats = {
			c: { min: 1, max: 2, mean: 1.5, last: 2 },
			a: { min: 1, max: 2, mean: 1.5, last: 2 },
			b: { min: 1, max: 2, mean: 1.5, last: 2 },
		} satisfies Record<string, SeriesStats>
		expect(sortZeroSeriesLast(series("c", "a", "b"), stats).map((e) => e.key)).toEqual(["c", "a", "b"])
	})

	it("keeps the incoming order among the sunk series too", () => {
		const stats = computeSeriesStats(ROWS, ["zzz-idle"])
		const sorted = sortZeroSeriesLast(series("zzz-idle", "unknown-b", "demo-api"), stats)
		// Two series have no entry in `stats` here, so they sink alongside the zero
		// one; what this pins is that the sunk block keeps its relative order.
		// (Note this differs from the legacy `query-builder-legend.tsx` helper, which
		// leaves a series with NO stats where it is. Unreachable in practice — stats
		// are computed over every key before the legend sees them.)
		expect(sorted.map((entry) => entry.key)).toEqual(["zzz-idle", "unknown-b", "demo-api"])
	})

	it("does not mutate the input", () => {
		const stats = computeSeriesStats(ROWS, ["zzz-idle", "demo-api"])
		const input = series("zzz-idle", "demo-api")
		sortZeroSeriesLast(input, stats)
		expect(input.map((entry) => entry.key)).toEqual(["zzz-idle", "demo-api"])
	})
})
