import { describe, expect, it } from "vitest"
import { buildCheckoutSuccessUrl, isCheckoutReturn, withoutCheckoutReturn } from "./checkout-return"

describe("checkout-return", () => {
	it("adds the marker to the page URL without losing the existing search", () => {
		expect(buildCheckoutSuccessUrl("https://app.maple.dev/quick-start?redirect_url=%2F")).toBe(
			"https://app.maple.dev/quick-start?redirect_url=%2F&checkout=complete",
		)
	})

	it("recognises only the exact marker", () => {
		expect(isCheckoutReturn("?checkout=complete")).toBe(true)
		expect(isCheckoutReturn("?tab=billing&checkout=complete")).toBe(true)
		expect(isCheckoutReturn("?checkout=started")).toBe(false)
		expect(isCheckoutReturn("?tab=billing")).toBe(false)
		expect(isCheckoutReturn(undefined)).toBe(false)
		expect(isCheckoutReturn("")).toBe(false)
	})

	it("strips the marker and keeps the rest of the search", () => {
		expect(withoutCheckoutReturn({ tab: "billing", checkout: "complete" })).toEqual({ tab: "billing" })
		expect(withoutCheckoutReturn({ redirect_url: "/" })).toEqual({ redirect_url: "/" })
	})
})
