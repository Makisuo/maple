import { describe, expect, it } from "vitest"
import {
	MAX_BREAKDOWN_RANGE_SECONDS,
	MAX_LIST_RANGE_SECONDS,
	MAX_QUERY_RANGE_SECONDS,
	formatRangeSeconds,
	maxRangeSecondsForKind,
	validateRelativeRange,
} from "./limits"
import { relativeRangeSeconds } from "./datetime"

describe("maxRangeSecondsForKind", () => {
	it("gives charts a far wider ceiling than lists", () => {
		// The whole point of the module: a dashboard's charts are not bound by the
		// list tiles sitting next to them.
		expect(maxRangeSecondsForKind("timeseries")).toBe(MAX_QUERY_RANGE_SECONDS)
		expect(maxRangeSecondsForKind("list")).toBe(MAX_LIST_RANGE_SECONDS)
		expect(maxRangeSecondsForKind("breakdown")).toBe(MAX_BREAKDOWN_RANGE_SECONDS)
		expect(maxRangeSecondsForKind("timeseries")).toBeGreaterThan(maxRangeSecondsForKind("list"))
	})
})

describe("formatRangeSeconds", () => {
	it("renders whole-day spans as days", () => {
		expect(formatRangeSeconds(MAX_LIST_RANGE_SECONDS)).toBe("7 days")
		expect(formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)).toBe("31 days")
		expect(formatRangeSeconds(86_400)).toBe("1 day")
	})

	it("renders sub-day spans as hours and minutes", () => {
		expect(formatRangeSeconds(6 * 3600)).toBe("6 hours")
		expect(formatRangeSeconds(3600)).toBe("1 hour")
		expect(formatRangeSeconds(900)).toBe("15 minutes")
	})
})

describe("relativeRangeSeconds", () => {
	it("parses every unit the time picker can emit", () => {
		expect(relativeRangeSeconds("15m")).toBe(15 * 60)
		expect(relativeRangeSeconds("6h")).toBe(6 * 3600)
		expect(relativeRangeSeconds("7d")).toBe(7 * 86_400)
		expect(relativeRangeSeconds("2w")).toBe(14 * 86_400)
		expect(relativeRangeSeconds("3mo")).toBe(90 * 86_400)
		expect(relativeRangeSeconds("today")).toBe(86_400)
	})

	it("is case- and whitespace-insensitive", () => {
		expect(relativeRangeSeconds("  7D  ")).toBe(7 * 86_400)
	})

	it("rejects malformed shorthand", () => {
		for (const bad of ["", "d", "7", "7x", "-7d", "0d", "7 d", "last week"]) {
			expect(relativeRangeSeconds(bad)).toBeNull()
		}
	})

	it("does not confuse the minute and month units", () => {
		expect(relativeRangeSeconds("3m")).toBe(3 * 60)
		expect(relativeRangeSeconds("3mo")).toBe(90 * 86_400)
	})
})

describe("validateRelativeRange", () => {
	it("accepts ranges up to the ceiling", () => {
		expect(validateRelativeRange("30d").ok).toBe(true)
		expect(validateRelativeRange("31d").ok).toBe(true)
		expect(validateRelativeRange("1h").ok).toBe(true)
	})

	it("rejects ranges past the ceiling with an explicit message", () => {
		const result = validateRelativeRange("90d")
		expect(result.ok).toBe(false)
		expect(result.error).toContain("90d")
		expect(result.error).toContain("31 days")
	})

	it("honours a caller-supplied ceiling", () => {
		expect(validateRelativeRange("30d", MAX_LIST_RANGE_SECONDS).ok).toBe(false)
		expect(validateRelativeRange("6h", MAX_LIST_RANGE_SECONDS).ok).toBe(true)
	})

	it("reports malformed shorthand separately from an over-wide one", () => {
		const result = validateRelativeRange("last week")
		expect(result.ok).toBe(false)
		expect(result.error).toContain("Invalid time range")
		expect(result.seconds).toBeUndefined()
	})
})
