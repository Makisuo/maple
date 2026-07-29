import { describe, expect, it } from "vitest"
import { cycleSpend, isActivePlanSubscription, overageUnits, projectCycleSpend } from "./billing"

// The Startup plan as it ships in apps/api/autumn.config.ts: $39/mo, 100 GB of
// each byte signal at $0.30/GB, 5,000 sessions at $0.002 each.
const startupFeatures = {
	logs: { used: 390, included: 100, ratePerUnit: 0.3 },
	traces: { used: 140, included: 100, ratePerUnit: 0.3 },
	metrics: { used: 160, included: 100, ratePerUnit: 0.3 },
	browser_sessions: { used: 26_700, included: 5_000, ratePerUnit: 0.002 },
}

describe("overageUnits", () => {
	it("is the excess over included, floored at zero", () => {
		expect(overageUnits({ used: 390, included: 100, ratePerUnit: 0.3 })).toBe(290)
		expect(overageUnits({ used: 40, included: 100, ratePerUnit: 0.3 })).toBe(0)
	})

	it("is zero for unlimited features and for an unknown allotment", () => {
		expect(overageUnits({ used: 9_999, included: 100, ratePerUnit: 0.3, unlimited: true })).toBe(0)
		expect(overageUnits({ used: 9_999, included: null, ratePerUnit: 0.3 })).toBe(0)
	})
})

describe("cycleSpend", () => {
	it("prices base plus per-feature overage in cents", () => {
		const spend = cycleSpend({ baseDollars: 39, features: startupFeatures })

		expect(spend.baseCents).toBe(3_900)
		expect(spend.overageByFeature).toEqual({
			logs: 8_700,
			traces: 1_200,
			metrics: 1_800,
			browser_sessions: 4_340,
		})
		expect(spend.overageCents).toBe(16_040)
		expect(spend.totalCents).toBe(19_940)
		expect(spend.partial).toBe(false)
	})

	it("survives a sub-cent rate without rounding it away per feature", () => {
		// 1 session at $0.002 is 0.2c: rounding per feature would drop it, and an
		// org metered only in sessions would read as $0 spend forever.
		const spend = cycleSpend({
			baseDollars: 0,
			features: { browser_sessions: { used: 5_500, included: 5_000, ratePerUnit: 0.002 } },
		})
		expect(spend.overageCents).toBe(100)
	})

	it("flags a partial estimate when the base price or an overage rate is unknown", () => {
		const noBase = cycleSpend({ baseDollars: null, features: {} })
		expect(noBase.partial).toBe(true)
		expect(noBase.totalCents).toBe(0)

		const noRate = cycleSpend({
			baseDollars: 39,
			features: { logs: { used: 390, included: 100, ratePerUnit: null } },
		})
		expect(noRate.partial).toBe(true)
		expect(noRate.overageByFeature.logs).toBe(0)
		expect(noRate.totalCents).toBe(3_900)
	})
})

describe("projectCycleSpend", () => {
	it("extrapolates overage only, holding the base fee flat", () => {
		const day = 86_400_000
		// Day 29 of 31: $39 base + $160.40 overage → $39 + $171.46.
		expect(
			projectCycleSpend({
				baseCents: 3_900,
				overageCents: 16_040,
				elapsedMs: 29 * day,
				totalMs: 31 * day,
			}),
		).toBe(21_046)
	})

	it("returns spend as-is at cycle end or with nothing elapsed", () => {
		expect(
			projectCycleSpend({ baseCents: 3_900, overageCents: 16_040, elapsedMs: 100, totalMs: 100 }),
		).toBe(19_940)
		expect(
			projectCycleSpend({ baseCents: 3_900, overageCents: 16_040, elapsedMs: 0, totalMs: 100 }),
		).toBe(19_940)
	})
})

describe("isActivePlanSubscription", () => {
	it("is true for an active base plan (trials included — Autumn marks them active)", () => {
		expect(isActivePlanSubscription({ planId: "startup", status: "active" })).toBe(true)
	})

	it("is false for add-on, auto-enabled, and free plans", () => {
		expect(isActivePlanSubscription({ planId: "byoc", status: "active", addOn: true })).toBe(false)
		expect(isActivePlanSubscription({ planId: "starter", status: "active", autoEnable: true })).toBe(
			false,
		)
		expect(isActivePlanSubscription({ planId: "free", status: "active" })).toBe(false)
		expect(isActivePlanSubscription({ planId: "x", status: "active", plan: { name: "Free" } })).toBe(
			false,
		)
	})

	it("is false for non-active status and empty/missing input", () => {
		expect(isActivePlanSubscription({ planId: "startup", status: "scheduled" })).toBe(false)
		expect(isActivePlanSubscription({ planId: "startup", status: "expired" })).toBe(false)
		expect(isActivePlanSubscription({})).toBe(false)
		expect(isActivePlanSubscription(null)).toBe(false)
		expect(isActivePlanSubscription(undefined)).toBe(false)
	})
})
