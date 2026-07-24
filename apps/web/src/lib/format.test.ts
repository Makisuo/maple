import { describe, expect, it } from "vitest"

import { formatErrorRate as formatSharedErrorRate } from "@maple/ui/lib/format"

import { formatErrorRate as formatWebErrorRate } from "./format"

describe.each([
	["shared", formatSharedErrorRate],
	["web", formatWebErrorRate],
])("%s formatErrorRate", (_name, formatErrorRate) => {
	it("reserves zero for an exact zero rate", () => {
		expect(formatErrorRate(0)).toBe("0%")
	})

	it("preserves a visible distinction for tiny nonzero rates", () => {
		expect(formatErrorRate(0.000001)).toBe("<0.01%")
		expect(formatErrorRate(0.000099)).toBe("<0.01%")
		expect(formatErrorRate(0.0001)).toBe("0.01%")
	})
})
