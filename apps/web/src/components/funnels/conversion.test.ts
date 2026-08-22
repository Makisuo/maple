import { describe, expect, it } from "vitest"
import { funnelStepStats, groupBreakdownRows, overallConversion } from "./conversion"

describe("funnelStepStats", () => {
	it("derives share-of-first, step conversion and drop-off per step", () => {
		const stats = funnelStepStats(
			["Landed", "Signed up", "Paid"],
			[
				{ step: 1, count: 200 },
				{ step: 2, count: 50 },
				{ step: 3, count: 10 },
			],
		)
		expect(stats.map((s) => s.count)).toEqual([200, 50, 10])
		expect(stats.map((s) => s.ofFirst)).toEqual([1, 0.25, 0.05])
		expect(stats.map((s) => s.ofPrevious)).toEqual([null, 0.25, 0.2])
		expect(stats.map((s) => s.dropOff)).toEqual([0, 150, 40])
		expect(stats.map((s) => s.dropOffRate)).toEqual([null, 0.75, 0.8])
		expect(overallConversion(stats)).toBe(0.05)
	})

	it("matches rows by step number and treats a missing step as zero", () => {
		const stats = funnelStepStats(["a", "b", "c"], [{ step: 1, count: 4 }])
		expect(stats.map((s) => s.count)).toEqual([4, 0, 0])
		// Step 3's previous step counted nobody, so its conversion is unknown, not 0%.
		expect(stats[2]!.ofPrevious).toBeNull()
		expect(stats[2]!.dropOffRate).toBeNull()
		expect(stats[1]!.ofPrevious).toBe(0)
	})

	it("reports no overall conversion for an empty first step or a single step", () => {
		expect(overallConversion(funnelStepStats(["a", "b"], []))).toBeNull()
		expect(overallConversion(funnelStepStats(["a"], [{ step: 1, count: 9 }]))).toBeNull()
	})
})

describe("groupBreakdownRows", () => {
	it("pivots group/step rows into one row per group, keeping first-seen order", () => {
		const grouped = groupBreakdownRows(3, [
			{ group: "google.com", step: 1, count: 30 },
			{ group: "google.com", step: 2, count: 12 },
			{ group: "(direct)", step: 1, count: 20 },
			{ group: "google.com", step: 3, count: 4 },
			// Out-of-range steps are ignored rather than thrown.
			{ group: "(direct)", step: 7, count: 99 },
		])
		expect(grouped).toEqual([
			{ group: "google.com", counts: [30, 12, 4] },
			{ group: "(direct)", counts: [20, 0, 0] },
		])
	})
})
