import { describe, expect, it } from "vitest"
import {
	bucketTimeline,
	computeBucketSeconds,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	warehouseDateTimeToIso,
} from "./datetime"

describe("warehouseDateTimeToIso", () => {
	it("appends Z to a tz-less space-separated DateTime", () => {
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00")).toBe("2026-05-24T14:30:00Z")
	})

	it("appends Z to a tz-less T-separated DateTime", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00")).toBe("2026-05-24T14:30:00Z")
	})

	it("normalizes fractional seconds to milliseconds with Z", () => {
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00.123456")).toBe("2026-05-24T14:30:00.123Z")
		expect(warehouseDateTimeToIso("2026-05-24 14:30:00.5")).toBe("2026-05-24T14:30:00.500Z")
	})

	it("passes through strings that already carry a Z", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00Z")).toBe("2026-05-24T14:30:00Z")
	})

	it("passes through strings with a numeric offset", () => {
		expect(warehouseDateTimeToIso("2026-05-24T14:30:00+02:00")).toBe("2026-05-24T14:30:00+02:00")
	})

	it("trims surrounding whitespace", () => {
		expect(warehouseDateTimeToIso("  2026-05-24 14:30:00  ")).toBe("2026-05-24T14:30:00Z")
	})

	it("returns non-timestamp input unchanged (trimmed)", () => {
		expect(warehouseDateTimeToIso(" not-a-date ")).toBe("not-a-date")
	})
})

describe("parseWarehouseDateTime", () => {
	it("parses a tz-less DateTime as UTC", () => {
		expect(parseWarehouseDateTime("2026-05-24 14:30:00")).toBe(Date.UTC(2026, 4, 24, 14, 30, 0))
	})

	it("is independent of the process timezone", () => {
		// The numeric epoch must equal the UTC instant regardless of TZ. We can't
		// re-set process.env.TZ mid-run reliably, so assert against the UTC constant
		// which is timezone-independent by construction.
		const expected = Date.UTC(2026, 0, 1, 0, 0, 0)
		expect(parseWarehouseDateTime("2026-01-01 00:00:00")).toBe(expected)
	})

	it("returns NaN for unparseable input", () => {
		expect(Number.isNaN(parseWarehouseDateTime("nonsense"))).toBe(true)
	})
})

describe("formatWarehouseDateTime", () => {
	it("formats epoch ms as tz-less space-separated UTC seconds", () => {
		expect(formatWarehouseDateTime(Date.UTC(2026, 4, 24, 14, 30, 0))).toBe("2026-05-24 14:30:00")
	})

	it("drops fractional milliseconds", () => {
		expect(formatWarehouseDateTime(Date.UTC(2026, 4, 24, 14, 30, 0, 999))).toBe("2026-05-24 14:30:00")
	})

	it("round-trips through parseWarehouseDateTime", () => {
		const epoch = Date.UTC(2026, 0, 2, 3, 4, 5)
		expect(parseWarehouseDateTime(formatWarehouseDateTime(epoch))).toBe(epoch)
	})
})

describe("computeBucketSeconds", () => {
	// Canonical windows — the single source of truth shared by the web app and the
	// engine. Short windows use the sub-5-minute rungs so charts stay dense.
	const cases: Array<[label: string, rangeSeconds: number, expected: number]> = [
		["5 min", 5 * 60, 60],
		["15 min", 15 * 60, 60],
		["30 min", 30 * 60, 60],
		["1 hour", 60 * 60, 120],
		["6 hours", 6 * 3600, 900],
		["12 hours", 12 * 3600, 1800],
		["24 hours", 24 * 3600, 3600],
		["7 days", 7 * 86400, 14400],
		["30 days", 30 * 86400, 86400],
	]

	for (const [label, rangeSeconds, expected] of cases) {
		it(`picks ${expected}s for ${label}`, () => {
			expect(computeBucketSeconds(0, rangeSeconds * 1000)).toBe(expected)
		})
	}

	it("clamps to the finest rung for windows narrower than a bucket", () => {
		expect(computeBucketSeconds(0, 30_000)).toBe(60)
		expect(computeBucketSeconds(0, 0)).toBe(60)
	})

	it("honors an explicit targetPoints (denser histograms)", () => {
		expect(computeBucketSeconds(0, 3600_000, { targetPoints: 60 })).toBe(60)
	})
})

describe("bucketTimeline", () => {
	it("spans the window with ceil-start / floor-end buckets", () => {
		expect(bucketTimeline(Date.UTC(2026, 1, 1, 0, 0, 0), Date.UTC(2026, 1, 1, 0, 10, 0), 300)).toEqual([
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:05:00.000Z",
			"2026-02-01T00:10:00.000Z",
		])
	})

	it("keeps the trailing partial bucket (floors the end)", () => {
		expect(bucketTimeline(Date.UTC(2026, 1, 1, 0, 0, 0), Date.UTC(2026, 1, 1, 0, 12, 30), 300)).toEqual([
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:05:00.000Z",
			"2026-02-01T00:10:00.000Z",
		])
	})

	it("returns a single bucket when the window is narrower than one bucket", () => {
		expect(bucketTimeline(Date.UTC(2026, 1, 1, 0, 0, 10), Date.UTC(2026, 1, 1, 0, 0, 40), 60)).toEqual([
			"2026-02-01T00:00:00.000Z",
		])
	})

	it("returns [] when the end precedes the start", () => {
		expect(bucketTimeline(Date.UTC(2026, 1, 1, 0, 10, 0), Date.UTC(2026, 1, 1, 0, 0, 0), 300)).toEqual([])
	})
})
