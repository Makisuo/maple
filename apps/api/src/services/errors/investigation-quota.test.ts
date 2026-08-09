import { describe, expect, it } from "vitest"
import {
	DEFAULT_MAX_PASSES_PER_DAY,
	DEFAULT_MAX_RUNS_PER_DAY,
	evaluateInvestigationQuota,
	startOfUtcDay,
} from "./investigation-quota"

const NOW = Date.UTC(2026, 7, 9, 13, 30)
const MIDNIGHT_TOMORROW = Date.UTC(2026, 7, 10)

const verdict = (input: {
	runs: number
	passes: number
	passCount: number
	limits?: { maxRunsPerDay?: number | null; maxPassesPerDay?: number | null }
}) =>
	evaluateInvestigationQuota({
		usage: { runs: input.runs, passes: input.passes },
		limits: input.limits,
		passCount: input.passCount,
		nowMs: NOW,
	})

describe("evaluateInvestigationQuota", () => {
	it("allows a start below both ceilings", () => {
		expect(verdict({ runs: 1, passes: 6, passCount: 6 })).toEqual({ kind: "allowed" })
	})

	/**
	 * The reported dimension is what tells an operator which number to raise. A
	 * run cap raised to 100 looks ignored when it was the pass cap that stopped
	 * the start, so the two cases must stay distinguishable.
	 */
	it("names the runs ceiling when runs are spent", () => {
		expect(verdict({ runs: 20, passes: 0, passCount: 1 })).toEqual({
			kind: "exceeded",
			dimension: "runs",
			limit: DEFAULT_MAX_RUNS_PER_DAY,
			retryableAtMs: MIDNIGHT_TOMORROW,
		})
	})

	it("names the passes ceiling when a raised run cap leaves passes short", () => {
		expect(verdict({ runs: 15, passes: 88, passCount: 6, limits: { maxRunsPerDay: 100 } })).toEqual({
			kind: "exceeded",
			dimension: "passes",
			limit: DEFAULT_MAX_PASSES_PER_DAY,
			retryableAtMs: MIDNIGHT_TOMORROW,
		})
	})

	/** Passes are checked as `used + requested`; runs as `used`, so the last slot stays usable. */
	it("lets the last run slot be used", () => {
		expect(verdict({ runs: 19, passes: 0, passCount: 1 })).toEqual({ kind: "allowed" })
	})

	it("resets at the next UTC midnight regardless of the time of day", () => {
		expect(startOfUtcDay(NOW) + 24 * 60 * 60 * 1000).toBe(MIDNIGHT_TOMORROW)
	})
})
