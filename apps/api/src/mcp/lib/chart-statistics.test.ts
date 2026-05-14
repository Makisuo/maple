import { describe, expect, it } from "vitest"
import type { BreakdownItem, TimeseriesPoint } from "@maple/domain"
import {
	computeBreakdownStats,
	computeFlags,
	computeTimeseriesStats,
	verdictFromFlags,
} from "./chart-statistics"

const point = (bucket: string, series: Record<string, number>): TimeseriesPoint => ({ bucket, series })

describe("computeTimeseriesStats", () => {
	it("returns empty stats for empty input", () => {
		const stats = computeTimeseriesStats([])
		expect(stats.rowCount).toBe(0)
		expect(stats.seriesCount).toBe(0)
		expect(stats.seriesStats).toEqual([])
	})

	it("computes per-series min/max/avg", () => {
		const stats = computeTimeseriesStats([
			point("2026-04-12 00:00:00", { auth: 10, billing: 5 }),
			point("2026-04-12 01:00:00", { auth: 20, billing: 5 }),
			point("2026-04-12 02:00:00", { auth: 30, billing: 5 }),
		])
		expect(stats.rowCount).toBe(3)
		expect(stats.seriesCount).toBe(2)
		expect(stats.firstBucket).toBe("2026-04-12 00:00:00")
		expect(stats.lastBucket).toBe("2026-04-12 02:00:00")
		const auth = stats.seriesStats.find((s) => s.name === "auth")!
		expect(auth.min).toBe(10)
		expect(auth.max).toBe(30)
		expect(auth.avg).toBe(20)
		expect(auth.validCount).toBe(3)
		const billing = stats.seriesStats.find((s) => s.name === "billing")!
		expect(billing.min).toBe(5)
		expect(billing.max).toBe(5)
	})

	it("counts nulls when a series is missing from a bucket", () => {
		const stats = computeTimeseriesStats([
			point("b1", { auth: 1 }),
			point("b2", {}),
			point("b3", { auth: 3 }),
		])
		const auth = stats.seriesStats[0]
		expect(auth.validCount).toBe(2)
		expect(auth.nullCount).toBe(1)
	})

	it("includes head + tail samples for long series", () => {
		const points: TimeseriesPoint[] = []
		for (let i = 0; i < 10; i++) {
			points.push(point(`b${i}`, { s: i + 1 }))
		}
		const stats = computeTimeseriesStats(points)
		const samples = stats.seriesStats[0].samples
		expect(samples.length).toBe(6)
		expect(samples[0].value).toBe(1)
		expect(samples[5].value).toBe(10)
	})
})

describe("computeBreakdownStats", () => {
	it("returns empty for empty input", () => {
		const stats = computeBreakdownStats([])
		expect(stats.rowCount).toBe(0)
		expect(stats.seriesCount).toBe(0)
	})

	it("aggregates breakdown rows into one logical series", () => {
		const rows: BreakdownItem[] = [
			{ name: "auth", value: 100 },
			{ name: "billing", value: 50 },
			{ name: "checkout", value: 25 },
		]
		const stats = computeBreakdownStats(rows)
		expect(stats.rowCount).toBe(3)
		expect(stats.seriesCount).toBe(1)
		const series = stats.seriesStats[0]
		expect(series.min).toBe(25)
		expect(series.max).toBe(100)
		expect(series.avg).toBeCloseTo(58.333, 2)
	})
})

describe("computeFlags", () => {
	it("flags EMPTY when there are no rows", () => {
		const flags = computeFlags(computeTimeseriesStats([]))
		expect(flags).toContain("EMPTY")
		expect(verdictFromFlags(flags)).toBe("broken")
	})

	it("flags ALL_NULLS when every bucket has empty series", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", {}), point("b2", {})]))
		expect(flags).toContain("ALL_NULLS")
		expect(verdictFromFlags(flags)).toBe("broken")
	})

	it("flags ALL_ZEROS when every value is zero", () => {
		const flags = computeFlags(
			computeTimeseriesStats([point("b1", { s: 0 }), point("b2", { s: 0 }), point("b3", { s: 0 })]),
		)
		expect(flags).toContain("ALL_ZEROS")
		expect(verdictFromFlags(flags)).toBe("suspicious")
	})

	it("flags FLAT_LINE when all non-zero values are equal", () => {
		const flags = computeFlags(
			computeTimeseriesStats([point("b1", { s: 42 }), point("b2", { s: 42 }), point("b3", { s: 42 })]),
		)
		expect(flags).toContain("FLAT_LINE")
		expect(flags).not.toContain("ALL_ZEROS")
	})

	it("flags SINGLE_POINT when only one bucket exists", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", { s: 5 })]))
		expect(flags).toContain("SINGLE_POINT")
	})

	it("flags SUSPICIOUS_GAP when more than 30% of buckets are null", () => {
		const points: TimeseriesPoint[] = []
		for (let i = 0; i < 10; i++) {
			points.push(point(`b${i}`, i < 4 ? {} : { s: i }))
		}
		const flags = computeFlags(computeTimeseriesStats(points))
		expect(flags).toContain("SUSPICIOUS_GAP")
	})

	it("flags NEGATIVE_VALUES on count metrics", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", { s: 5 }), point("b2", { s: -2 })]), {
			metric: "count",
		})
		expect(flags).toContain("NEGATIVE_VALUES")
	})

	it("flags UNREALISTIC_MAGNITUDE for error_rate > 1.0", () => {
		const flags = computeFlags(
			computeTimeseriesStats([point("b1", { s: 0.5 }), point("b2", { s: 67 })]),
			{ metric: "error_rate" },
		)
		expect(flags).toContain("UNREALISTIC_MAGNITUDE")
	})

	it("flags SINGLE_SERIES_DOMINATES when one series is >99% of total", () => {
		const flags = computeFlags(
			computeTimeseriesStats([
				point("b1", { dominant: 1000, other: 1 }),
				point("b2", { dominant: 1000, other: 1 }),
			]),
		)
		expect(flags).toContain("SINGLE_SERIES_DOMINATES")
	})

	it("flags CARDINALITY_EXPLOSION above 50 series", () => {
		const series: Record<string, number> = {}
		for (let i = 0; i < 60; i++) series[`s${i}`] = i + 1
		const flags = computeFlags(computeTimeseriesStats([point("b1", series)]))
		expect(flags).toContain("CARDINALITY_EXPLOSION")
	})

	it("flags UNIT_MISMATCH when display unit conflicts with metric class", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", { s: 5 }), point("b2", { s: 6 })]), {
			metric: "count",
			displayUnit: "ms",
		})
		expect(flags).toContain("UNIT_MISMATCH")
		expect(verdictFromFlags(flags)).toBe("broken")
	})

	it("does not flag UNIT_MISMATCH when widget has no unit", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", { s: 5 }), point("b2", { s: 6 })]), {
			metric: "count",
		})
		expect(flags).not.toContain("UNIT_MISMATCH")
	})

	it("returns no flags for healthy timeseries", () => {
		const flags = computeFlags(
			computeTimeseriesStats([
				point("b1", { auth: 10, billing: 8 }),
				point("b2", { auth: 12, billing: 9 }),
				point("b3", { auth: 15, billing: 11 }),
				point("b4", { auth: 14, billing: 10 }),
			]),
			{ metric: "count" },
		)
		expect(flags).toEqual([])
		expect(verdictFromFlags(flags)).toBe("looks_healthy")
	})

	it("preserves preFlags from caller", () => {
		const flags = computeFlags(computeTimeseriesStats([point("b1", { s: 1 }), point("b2", { s: 2 })]), {
			preFlags: ["BROKEN_BREAKDOWN"],
		})
		expect(flags).toContain("BROKEN_BREAKDOWN")
		expect(verdictFromFlags(flags)).toBe("broken")
	})
})

describe("verdictFromFlags", () => {
	it("returns looks_healthy when there are no flags", () => {
		expect(verdictFromFlags([])).toBe("looks_healthy")
	})

	it("returns broken for severe flags", () => {
		expect(verdictFromFlags(["EMPTY"])).toBe("broken")
		expect(verdictFromFlags(["ALL_NULLS"])).toBe("broken")
		expect(verdictFromFlags(["UNIT_MISMATCH"])).toBe("broken")
		expect(verdictFromFlags(["BROKEN_BREAKDOWN"])).toBe("broken")
	})

	it("returns suspicious for milder flags", () => {
		expect(verdictFromFlags(["ALL_ZEROS"])).toBe("suspicious")
		expect(verdictFromFlags(["FLAT_LINE"])).toBe("suspicious")
		expect(verdictFromFlags(["SUSPICIOUS_GAP"])).toBe("suspicious")
		expect(verdictFromFlags(["BUILDER_WARNINGS"])).toBe("suspicious")
	})
})
