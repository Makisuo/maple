import { describe, expect, it } from "vitest"

import {
	formatCompact,
	formatRange,
	formatSeconds,
	formatValue,
	parseRange,
} from "@maple/ui/components/filters/range-filter-section"

// The control lets you type "2m" where the URL stores 120. Parsing and display
// have to agree, or a value read back from the URL rewrites itself into
// something that no longer means what the reader typed.

describe("parseRange", () => {
	it("treats a bare number as already being in the control's unit", () => {
		expect(parseRange("90", "s")).toBe(90)
		expect(parseRange("90", "ms")).toBe(90)
		expect(parseRange(" 2.5 ", "s")).toBe(2.5)
	})

	it("converts suffixed durations into the control's unit", () => {
		expect(parseRange("2m", "s")).toBe(120)
		expect(parseRange("90s", "s")).toBe(90)
		expect(parseRange("1h", "s")).toBe(3600)
		expect(parseRange("1.5m", "s")).toBe(90)
		expect(parseRange("2s", "ms")).toBe(2000)
		expect(parseRange("200ms", "ms")).toBe(200)
	})

	it("sums compound durations", () => {
		expect(parseRange("1m 30s", "s")).toBe(90)
		expect(parseRange("1h 30m", "s")).toBe(5400)
	})

	it("reads ms before m", () => {
		expect(parseRange("500ms", "s")).toBe(0.5)
		expect(parseRange("500m", "s")).toBe(30_000)
	})

	it("returns undefined for blank or unparseable input, meaning unbounded", () => {
		expect(parseRange("", "s")).toBeUndefined()
		expect(parseRange("   ", "s")).toBeUndefined()
		expect(parseRange("abc", "s")).toBeUndefined()
		expect(parseRange("12x", "s")).toBeUndefined()
		expect(parseRange("-5", "s")).toBeUndefined()
		expect(parseRange("2m junk", "s")).toBeUndefined()
	})
})

describe("formatSeconds", () => {
	it("stays in seconds under a minute", () => {
		expect(formatSeconds(45)).toBe("45s")
		expect(formatSeconds(0)).toBe("0s")
	})

	it("drops the seconds part when a value lands on the minute", () => {
		expect(formatSeconds(120)).toBe("2m")
		expect(formatSeconds(90)).toBe("1m 30s")
	})

	it("switches to hours past an hour", () => {
		expect(formatSeconds(3600)).toBe("1h")
		expect(formatSeconds(3720)).toBe("1h 2m")
	})
})

describe("formatCompact", () => {
	it("leaves values bare inside the unit's natural range", () => {
		expect(formatCompact(45, "s")).toBe("45")
		expect(formatCompact(340, "ms")).toBe("340")
	})

	it("adds units once the raw number stops being legible", () => {
		expect(formatCompact(90, "s")).toBe("1m 30s")
		expect(formatCompact(1500, "ms")).toBe("1.50s")
	})

	it("renders an absent bound as an empty field", () => {
		expect(formatCompact(undefined, "s")).toBe("")
	})

	it("round-trips through parseRange", () => {
		for (const seconds of [0, 5, 45, 90, 120, 3600, 3720, 7325]) {
			expect(parseRange(formatCompact(seconds, "s"), "s")).toBe(seconds)
		}
		for (const ms of [0, 340, 999, 1500, 60_000]) {
			expect(parseRange(formatCompact(ms, "ms"), "ms")).toBe(ms)
		}
	})
})

describe("formatRange", () => {
	it("shows both bounds when both are set", () => {
		expect(formatRange(30, 120, "s")).toBe("30s – 2m")
	})

	it("shows the open side with an inequality", () => {
		expect(formatRange(30, undefined, "s")).toBe("≥ 30s")
		expect(formatRange(undefined, 10, "s")).toBe("≤ 10s")
	})

	it("keeps the millisecond badge unchanged for traces", () => {
		expect(formatValue(2500, "ms")).toBe("2.50s")
		expect(formatRange(2500, undefined, "ms")).toBe("≥ 2.50s")
	})
})
