import { describe, expect, it } from "vitest"
import {
	bucketTimeline,
	BUCKET_POLICIES,
	cacheSnapSecondsForRange,
	alertWindowBucketSeconds,
	computeBucketSeconds,
	computeBucketSecondsForRange,
	formatWarehouseDateTime,
	formatWarehouseDateTimeMs,
	parseWarehouseDateTime,
	relativeRangeSeconds,
	resolveRelativeRange,
	resolveRelativeRangeToWarehouse,
	snapRangeForCache,
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
	// engine. The ~100-point default keeps charts dense enough for manual
	// investigation on every window.
	const cases: Array<[label: string, rangeSeconds: number, expected: number]> = [
		["5 min", 5 * 60, 60],
		["15 min", 15 * 60, 60],
		["30 min", 30 * 60, 60],
		["1 hour", 60 * 60, 60],
		["6 hours", 6 * 3600, 300],
		["12 hours", 12 * 3600, 300],
		["24 hours", 24 * 3600, 900],
		["7 days", 7 * 86400, 3600],
		["30 days", 30 * 86400, 14400],
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

	describe("minBucketSeconds", () => {
		const rawSql = { targetPoints: 30, minBucketSeconds: 300 } as const

		it("never returns a rung below the floor, even on a tiny window", () => {
			// A sub-5-minute `$__interval_s` produces exactly the scan the raw-SQL
			// granularity was chosen to avoid, so the floor holds regardless of how
			// short the window is or how far `minBuckets` would otherwise step down.
			expect(computeBucketSeconds(0, 30_000, rawSql)).toBe(300)
			expect(computeBucketSeconds(0, 600_000, rawSql)).toBe(300)
			expect(computeBucketSeconds(0, 0, rawSql)).toBe(300)
		})

		it("reproduces the ladder the raw-SQL path used before it was shared", () => {
			// The deleted private ladder was [300, 900, 1800, 3600, 14400, 86400] at
			// a 30-point target with no minBuckets clamp. These are its outputs.
			const hour = 3600_000
			expect(computeBucketSeconds(0, 0.5 * hour, rawSql)).toBe(300)
			expect(computeBucketSeconds(0, 6 * hour, rawSql)).toBe(900)
			expect(computeBucketSeconds(0, 24 * hour, rawSql)).toBe(3600)
			expect(computeBucketSeconds(0, 7 * 24 * hour, rawSql)).toBe(14400)
			expect(computeBucketSeconds(0, 30 * 24 * hour, rawSql)).toBe(86400)
		})

		it("leaves the default (unfloored) ladder alone", () => {
			expect(computeBucketSeconds(0, 3600_000)).toBe(computeBucketSeconds(0, 3600_000, {}))
		})
	})
})

describe("BUCKET_POLICIES", () => {
	/**
	 * These three targets are NOT interchangeable, and a well-meaning "why do we
	 * have three of these?" cleanup is exactly what this guards. `alert` in
	 * particular re-tunes `minimumSampleCount` for every auto-sized rule if it
	 * moves.
	 */
	it("keeps the three surfaces on their own targets", () => {
		expect(BUCKET_POLICIES.chart.targetPoints).toBe(100)
		expect(BUCKET_POLICIES.alert.targetPoints).toBe(30)
		expect(BUCKET_POLICIES.rawSql.targetPoints).toBe(30)
		expect(BUCKET_POLICIES.rawSql.minBucketSeconds).toBe(300)
	})

	it("gives chart and alert measurably different granularity on the same window", () => {
		const sixHours = 6 * 3600_000
		expect(computeBucketSeconds(0, sixHours, BUCKET_POLICIES.chart)).toBe(300)
		expect(computeBucketSeconds(0, sixHours, BUCKET_POLICIES.alert)).toBe(900)
	})
})

describe("computeBucketSecondsForRange", () => {
	it("parses warehouse DateTime strings under the chart policy", () => {
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 00:30:00")).toBe(60)
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 06:00:00")).toBe(300)
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-08 00:00:00")).toBe(3600)
	})

	it("falls back rather than throwing on absent, unparseable or inverted ranges", () => {
		expect(computeBucketSecondsForRange(undefined, "2026-02-01 00:00:00")).toBe(300)
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", undefined)).toBe(300)
		expect(computeBucketSecondsForRange("not a date", "2026-02-01 00:00:00")).toBe(300)
		// endTime <= startTime is inverted, not a zero-width window.
		expect(computeBucketSecondsForRange("2026-02-01 06:00:00", "2026-02-01 00:00:00")).toBe(300)
	})

	it("honors the rawSql floor through the policy name", () => {
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 00:30:00", "rawSql")).toBe(300)
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 06:00:00", "rawSql")).toBe(900)
	})

	it("lets a caller override the target for a denser histogram", () => {
		expect(computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 01:00:00", "chart", 60)).toBe(
			60,
		)
	})

	it("treats a tz-marked string the same as its tz-less spelling", () => {
		expect(computeBucketSecondsForRange("2026-02-01T00:00:00Z", "2026-02-01T06:00:00Z")).toBe(
			computeBucketSecondsForRange("2026-02-01 00:00:00", "2026-02-01 06:00:00"),
		)
	})
})

describe("alertWindowBucketSeconds", () => {
	it("makes the evaluation window the bucket", () => {
		expect(alertWindowBucketSeconds(5)).toBe(300)
		expect(alertWindowBucketSeconds(60)).toBe(3600)
	})

	it("floors at 60s — a zero-width bucket is not a bucket", () => {
		expect(alertWindowBucketSeconds(0)).toBe(60)
		expect(alertWindowBucketSeconds(-1)).toBe(60)
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

const AT = (iso: string) => Date.parse(iso)

describe("formatWarehouseDateTimeMs", () => {
	it("keeps milliseconds, so sub-second ordering survives", () => {
		expect(formatWarehouseDateTimeMs(AT("2026-03-08T14:30:05.789Z"))).toBe("2026-03-08 14:30:05.789")
	})

	it("agrees with the second-precision variant up to the decimal point", () => {
		const ms = AT("2026-03-08T14:30:05.789Z")
		expect(formatWarehouseDateTimeMs(ms).startsWith(formatWarehouseDateTime(ms))).toBe(true)
	})
})

describe("relativeRangeSeconds", () => {
	it("parses every unit the time picker emits", () => {
		expect(relativeRangeSeconds("15m")).toBe(900)
		expect(relativeRangeSeconds("6h")).toBe(21_600)
		expect(relativeRangeSeconds("7d")).toBe(604_800)
		expect(relativeRangeSeconds("2w")).toBe(1_209_600)
		expect(relativeRangeSeconds("3mo")).toBe(7_776_000)
		expect(relativeRangeSeconds("today")).toBe(86_400)
	})

	it("does not confuse the minute and month units", () => {
		expect(relativeRangeSeconds("3m")).toBe(180)
		expect(relativeRangeSeconds("3mo")).toBe(7_776_000)
	})

	it("rejects malformed shorthand", () => {
		for (const bad of ["", "d", "7", "7x", "-7d", "0d", "7 d", "last week"]) {
			expect(relativeRangeSeconds(bad)).toBeNull()
		}
	})
})

describe("resolveRelativeRange", () => {
	const now = AT("2026-03-08T14:30:00.000Z")

	it("subtracts fixed-width units exactly", () => {
		expect(resolveRelativeRange("15m", now)).toEqual({ startMs: now - 900_000, endMs: now })
		expect(resolveRelativeRange("6h", now)).toEqual({ startMs: now - 21_600_000, endMs: now })
		expect(resolveRelativeRange("7d", now)).toEqual({ startMs: now - 604_800_000, endMs: now })
		expect(resolveRelativeRange("2w", now)).toEqual({ startMs: now - 1_209_600_000, endMs: now })
	})

	it("uses real calendar months, not 30-day approximations", () => {
		// The MCP resolver used to do `days: amount * 30`, so "1mo" from 8 March
		// landed on 6 February instead of 8 February.
		const start = new Date(resolveRelativeRange("1mo", now)!.startMs)
		expect(start.getMonth()).toBe(1)
		expect(start.getDate()).toBe(8)
	})

	it("clamps the day of month when the target month is shorter", () => {
		// 31 March minus one month is 28 February, never 3 March. Mirrors
		// date-fns `subMonths`, which the web app relied on.
		const march31 = new Date(2026, 2, 31, 12, 0, 0).getTime()
		const start = new Date(resolveRelativeRange("1mo", march31)!.startMs)
		expect(start.getMonth()).toBe(1)
		expect(start.getDate()).toBe(28)
	})

	it("clamps across a year boundary too", () => {
		const march31 = new Date(2026, 2, 31, 12, 0, 0).getTime()
		const start = new Date(resolveRelativeRange("13mo", march31)!.startMs)
		expect(start.getFullYear()).toBe(2025)
		expect(start.getMonth()).toBe(1)
		expect(start.getDate()).toBe(28)
	})

	it("resolves 'today' to local midnight", () => {
		const midday = new Date(2026, 2, 8, 13, 45, 0).getTime()
		const start = new Date(resolveRelativeRange("today", midday)!.startMs)
		expect(start.getHours()).toBe(0)
		expect(start.getMinutes()).toBe(0)
		expect(start.getSeconds()).toBe(0)
		expect(start.getDate()).toBe(8)
	})

	it("returns null for shorthand it cannot parse", () => {
		for (const bad of ["", "last month", "7x", "0d"]) {
			expect(resolveRelativeRange(bad, now)).toBeNull()
		}
	})

	it("always ends at now", () => {
		for (const value of ["15m", "7d", "3mo", "today"]) {
			expect(resolveRelativeRange(value, now)!.endMs).toBe(now)
		}
	})
})

describe("resolveRelativeRangeToWarehouse", () => {
	it("renders both bounds in warehouse format", () => {
		const now = AT("2026-03-08T14:30:00.000Z")
		expect(resolveRelativeRangeToWarehouse("6h", now)).toEqual({
			startTime: "2026-03-08 08:30:00",
			endTime: "2026-03-08 14:30:00",
		})
	})

	it("propagates null for invalid shorthand", () => {
		expect(resolveRelativeRangeToWarehouse("nope")).toBeNull()
	})
})

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe("cacheSnapSecondsForRange", () => {
	it("coarsens the grid as the window widens", () => {
		expect(cacheSnapSecondsForRange(30 * 60 * 1000)).toBe(15)
		expect(cacheSnapSecondsForRange(HOUR_MS)).toBe(15)
		expect(cacheSnapSecondsForRange(6 * HOUR_MS)).toBe(60)
		expect(cacheSnapSecondsForRange(12 * HOUR_MS)).toBe(300)
		expect(cacheSnapSecondsForRange(DAY_MS)).toBe(300)
		expect(cacheSnapSecondsForRange(7 * DAY_MS)).toBe(900)
		expect(cacheSnapSecondsForRange(30 * DAY_MS)).toBe(1800)
	})

	// Worst case is just above a rung boundary, where the wider grid has just
	// kicked in but the window has not grown to match. The peak is 1h+ε on the
	// 1m rung (1.67%); each later boundary is milder (6h+ε 1.39%, 24h+ε 1.04%,
	// 7d+ε 0.30%).
	it("keeps drift under 2% of the window at every rung boundary", () => {
		for (const rangeMs of [
			HOUR_MS,
			HOUR_MS + 1,
			6 * HOUR_MS,
			6 * HOUR_MS + 1,
			12 * HOUR_MS,
			DAY_MS,
			DAY_MS + 1,
			7 * DAY_MS,
			7 * DAY_MS + 1,
			30 * DAY_MS,
		]) {
			expect((cacheSnapSecondsForRange(rangeMs) * 1000) / rangeMs).toBeLessThan(0.02)
		}
	})

	it("bounds absolute drift by window class", () => {
		// The guarantee users actually feel, in wall-clock terms.
		expect(cacheSnapSecondsForRange(6 * HOUR_MS)).toBeLessThanOrEqual(60)
		expect(cacheSnapSecondsForRange(DAY_MS)).toBeLessThanOrEqual(300)
		expect(cacheSnapSecondsForRange(7 * DAY_MS)).toBeLessThanOrEqual(900)
		expect(cacheSnapSecondsForRange(90 * DAY_MS)).toBeLessThanOrEqual(1800)
	})

	it("falls back to the finest rung for degenerate widths", () => {
		expect(cacheSnapSecondsForRange(0)).toBe(15)
		expect(cacheSnapSecondsForRange(-1)).toBe(15)
		expect(cacheSnapSecondsForRange(Number.NaN)).toBe(15)
	})
})

describe("snapRangeForCache", () => {
	// The point of the whole exercise: `now` drifting within one grid cell must
	// produce a byte-identical range, because that range becomes the cache key.
	it("collapses clock drift inside a grid cell to one key", () => {
		const at = (iso: string) => resolveRelativeRangeToWarehouse("12h", Date.parse(iso))!

		const early = snapRangeForCache(at("2026-03-08T14:31:02.000Z"))
		const late = snapRangeForCache(at("2026-03-08T14:34:59.000Z"))

		expect(early).toEqual(late)
		expect(early.endTime).toBe("2026-03-08 14:30:00")
		expect(early.startTime).toBe("2026-03-08 02:30:00")
	})

	it("advances once the next cell is reached", () => {
		const at = (iso: string) => resolveRelativeRangeToWarehouse("12h", Date.parse(iso))!

		expect(snapRangeForCache(at("2026-03-08T14:34:59.000Z")).endTime).toBe("2026-03-08 14:30:00")
		expect(snapRangeForCache(at("2026-03-08T14:35:00.000Z")).endTime).toBe("2026-03-08 14:35:00")
	})

	it("holds the window width exactly constant across the ladder", () => {
		for (const shorthand of ["30m", "1h", "6h", "12h", "1d", "7d", "30d"]) {
			// Sweep offsets that straddle grid boundaries — flooring both bounds
			// independently would make the width oscillate by one grid step here.
			for (const offsetMs of [0, 1000, 61_000, 299_000, 899_000, 1_799_000]) {
				const resolved = resolveRelativeRangeToWarehouse(
					shorthand,
					Date.parse("2026-03-08T14:30:00.000Z") + offsetMs,
				)!
				const before =
					parseWarehouseDateTime(resolved.endTime) - parseWarehouseDateTime(resolved.startTime)

				const snapped = snapRangeForCache(resolved)
				const after =
					parseWarehouseDateTime(snapped.endTime) - parseWarehouseDateTime(snapped.startTime)

				expect(after).toBe(before)
			}
		}
	})

	it("never moves the endpoint forward", () => {
		const resolved = resolveRelativeRangeToWarehouse("12h", Date.parse("2026-03-08T14:34:59.000Z"))!
		const snapped = snapRangeForCache(resolved)

		expect(parseWarehouseDateTime(snapped.endTime)).toBeLessThanOrEqual(
			parseWarehouseDateTime(resolved.endTime),
		)
	})

	it("passes unparseable input through untouched", () => {
		const garbage = { startTime: "not-a-date", endTime: "also-not" }
		expect(snapRangeForCache(garbage)).toBe(garbage)
	})

	it("passes an inverted range through untouched", () => {
		const inverted = { startTime: "2026-03-08 14:30:00", endTime: "2026-03-08 02:30:00" }
		expect(snapRangeForCache(inverted)).toBe(inverted)
	})
})
