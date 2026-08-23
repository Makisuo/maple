import { describe, expect, it } from "vitest"

import { formatSessionDuration } from "../replay-format"

describe("formatSessionDuration", () => {
	it("renders missing, zero, and negative durations as an em dash", () => {
		expect(formatSessionDuration(null)).toBe("—")
		expect(formatSessionDuration(0)).toBe("—")
		expect(formatSessionDuration(-60_000)).toBe("—")
	})

	it("renders sub-hour durations in minutes and seconds", () => {
		expect(formatSessionDuration(45_000)).toBe("45s")
		expect(formatSessionDuration(90_000)).toBe("1m 30s")
		expect(formatSessionDuration(3_599_499)).toBe("59m 59s")
	})

	it("rolls minutes into hours", () => {
		expect(formatSessionDuration(3_600_000)).toBe("1h 0m")
		expect(formatSessionDuration(5_400_000)).toBe("1h 30m")
		expect(formatSessionDuration(28_812_000)).toBe("8h 0m")
	})
})
