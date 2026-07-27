import { describe, expect, it } from "vitest"

import {
	bucketIntervalLabel,
	formatBucketLabel,
	formatBytes,
	formatBytesPerSecond,
	formatDuration,
	formatErrorRate,
	formatLatency,
	formatLoad,
	formatNumber,
	formatPercent,
	formatStorageBytes,
	formatUptime,
	formatValueByUnit,
	inferBucketSeconds,
	inferRangeMs,
	parseBucketMs,
} from "../format"

// This file is the contract for the consolidation: every helper below replaced
// two or more diverging copies, and each assertion pins the behaviour that won.

describe("formatDuration", () => {
	it("walks the full μs → h ladder", () => {
		expect(formatDuration(0.5)).toBe("500μs")
		expect(formatDuration(1)).toBe("1.0ms")
		expect(formatDuration(250)).toBe("250.0ms")
		expect(formatDuration(1_000)).toBe("1.00s")
		expect(formatDuration(59_000)).toBe("59.00s")
	})

	it("keeps going past a minute instead of stopping at seconds", () => {
		// The web copy capped here and rendered an hour as "3600.00s".
		expect(formatDuration(90_000)).toBe("1.5min")
		expect(formatDuration(3_600_000)).toBe("1.0h")
	})
})

describe("formatLatency", () => {
	it("shares the duration ladder and has a placeholder for missing values", () => {
		expect(formatLatency(90_000)).toBe("1.5min")
		expect(formatLatency(3_600_000)).toBe("1.0h")
		expect(formatLatency(Number.NaN)).toBe("-")
	})
})

describe("formatNumber", () => {
	it("compacts at every tier", () => {
		expect(formatNumber(999)).toBe("999")
		expect(formatNumber(3_400)).toBe("3.4K")
		expect(formatNumber(1_200_000)).toBe("1.2M")
		expect(formatNumber(2_500_000_000)).toBe("2.5B")
		expect(formatNumber(1_200_000_000_000)).toBe("1.2T")
	})

	it("compacts negatives (delta columns), not just positives", () => {
		expect(formatNumber(-1_500)).toBe("-1.5K")
		expect(formatNumber(-2_500_000_000)).toBe("-2.5B")
	})

	it("keeps sub-1 values readable instead of collapsing to 0", () => {
		expect(formatNumber(0.0267)).toBe("0.0267")
		expect(formatNumber(0.08)).toBe("0.08")
		expect(formatNumber(0)).toBe("0")
	})
})

describe("byte formatting", () => {
	it("keeps the binary and decimal bases distinct", () => {
		expect(formatBytes(1_024)).toBe("1.0 KB")
		expect(formatStorageBytes(1_000)).toBe("1.0 KB")

		// The single assertion that makes the two impossible to conflate.
		// (Both drop the decimal above 100, hence "977 KB" rather than "976.6 KB".)
		expect(formatBytes(1_000_000)).toBe("977 KB")
		expect(formatStorageBytes(1_000_000)).toBe("1.0 MB")
	})

	it("floors at zero rather than emitting a negative size", () => {
		expect(formatBytes(0)).toBe("0 B")
		expect(formatBytes(-5)).toBe("0 B")
		expect(formatStorageBytes(-5)).toBe("0 B")
	})

	it("formats throughput on the binary base", () => {
		expect(formatBytesPerSecond(0)).toBe("0 B/s")
		expect(formatBytesPerSecond(2_048)).toBe("2.0 KB/s")
	})

	it("keeps `bytes`-unit widgets on the decimal base", () => {
		// Saved dashboards render through here; flipping this to 1024 would
		// silently rewrite existing widgets.
		expect(formatValueByUnit(1_000_000, "bytes")).toBe("1.0 MB")
	})
})

describe("percent formatters stay separate", () => {
	it("formatPercent floors small utilization to 0%", () => {
		expect(formatPercent(0.0001)).toBe("0%")
		expect(formatPercent(0.052)).toBe("5.2%")
		expect(formatPercent(0.87)).toBe("87%")
		expect(formatPercent(Number.NaN)).toBe("—")
	})

	it("formatErrorRate surfaces a rare failure instead of showing 0%", () => {
		expect(formatErrorRate(0)).toBe("0%")
		expect(formatErrorRate(0.00005)).toBe("<0.01%")
		expect(formatErrorRate(0.005)).toBe("0.50%")
		expect(formatErrorRate(0.087)).toBe("8.7%")
	})
})

describe("formatLoad / formatUptime", () => {
	it("renders load and uptime", () => {
		expect(formatLoad(1.234)).toBe("1.23")
		expect(formatLoad(Number.NaN)).toBe("—")
		expect(formatUptime(0)).toBe("—")
		expect(formatUptime(30 * 60)).toBe("30m")
		expect(formatUptime(5 * 3600)).toBe("5h")
		expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe("3d 4h")
	})
})

describe("value-by-unit dispatch", () => {
	it("routes each unit to its formatter", () => {
		expect(formatValueByUnit(0.5, "percent")).toBe("50.0%")
		expect(formatValueByUnit(90_000, "duration_ms")).toBe("1.5min")
		expect(formatValueByUnit(90_000_000, "duration_us")).toBe("1.5min")
		expect(formatValueByUnit(90, "duration_s")).toBe("1.5min")
		expect(formatValueByUnit(1_500, "requests_per_sec")).toBe("1.5K/s")
		expect(formatValueByUnit(3_400, undefined)).toBe("3.4K")
	})
})

describe("bucket helpers normalize warehouse timestamps", () => {
	// ClickHouse buckets arrive tz-less. Parsing them raw made every chart's axis
	// labels — and the trailing "incomplete bucket" marker — shift by the
	// browser's UTC offset. These assertions fail under a non-UTC TZ if the
	// normalization is dropped.
	it("parseBucketMs reads a tz-less bucket as UTC", () => {
		expect(parseBucketMs("2026-05-24 14:30:00")).toBe(Date.parse("2026-05-24T14:30:00Z"))
		expect(parseBucketMs(42)).toBeNull()
	})

	it("formatBucketLabel labels a tz-less bucket at its UTC instant", () => {
		const context = { rangeMs: 60 * 60 * 1000, bucketSeconds: 300 }
		const tzLess = formatBucketLabel("2026-05-24 14:30:00", context, "tick")
		const explicit = formatBucketLabel("2026-05-24T14:30:00Z", context, "tick")
		expect(tzLess).toBe(explicit)
	})

	it("infers spacing and range from tz-less buckets", () => {
		const data = [{ bucket: "2026-05-24 14:00:00" }, { bucket: "2026-05-24 14:05:00" }]
		expect(inferBucketSeconds(data)).toBe(300)
		expect(inferRangeMs(data)).toBe(5 * 60 * 1000)
	})

	it("maps bucket seconds to a rate suffix", () => {
		expect(bucketIntervalLabel(60)).toBe("/min")
		expect(bucketIntervalLabel(86_400)).toBe("/d")
		expect(bucketIntervalLabel(7)).toBe("")
		expect(bucketIntervalLabel(undefined)).toBe("")
	})
})
