import { describe, expect, it } from "vitest"
import { isActivePlanSubscription } from "./billing"

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
