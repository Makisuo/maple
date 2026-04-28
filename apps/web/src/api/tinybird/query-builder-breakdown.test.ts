import { describe, expect, it } from "vitest"

import { __testables } from "@/api/tinybird/query-builder-breakdown"

describe("query-builder breakdown normalization", () => {
	it("normalizes error rate breakdown values from percent points to ratios", () => {
		expect(
			__testables.normalizeErrorRateBreakdownData([
				{ name: "checkout", value: 2.1 },
				{ name: "billing", value: 5 },
			]),
		).toEqual([
			{ name: "checkout", value: 0.021 },
			{ name: "billing", value: 0.05 },
		])
	})
})
