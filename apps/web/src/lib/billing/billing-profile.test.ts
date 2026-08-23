import { describe, expect, it } from "vitest"
import { BillingAddress } from "@maple/domain/http"
import { fieldOrNull, formatAddressLines, hasAddress, verificationBadge } from "./billing-profile"

describe("formatAddressLines", () => {
	it("renders street, 'postal city, state' and the country name", () => {
		expect(
			formatAddressLines(
				new BillingAddress({
					line1: "Hauptstr. 1",
					line2: "Aufgang B",
					city: "Berlin",
					state: "BE",
					postalCode: "10115",
					country: "DE",
				}),
			),
		).toEqual(["Hauptstr. 1", "Aufgang B", "10115 Berlin, BE", "Germany"])
	})

	it("skips empty and whitespace-only parts", () => {
		expect(
			formatAddressLines(new BillingAddress({ line1: " ", city: "Paris", country: "fr", state: null })),
		).toEqual(["Paris", "France"])
		expect(formatAddressLines(new BillingAddress({}))).toEqual([])
		expect(formatAddressLines(null)).toEqual([])
	})

	it("hasAddress mirrors the line count", () => {
		expect(hasAddress(new BillingAddress({ country: "US" }))).toBe(true)
		expect(hasAddress(new BillingAddress({ line1: "" }))).toBe(false)
	})
})

describe("verificationBadge", () => {
	it("maps Stripe's statuses and stays silent on the rest", () => {
		expect(verificationBadge("verified")).toEqual({ label: "Verified", variant: "success" })
		expect(verificationBadge("pending")?.variant).toBe("secondary")
		expect(verificationBadge("unverified")?.variant).toBe("warning")
		expect(verificationBadge("unavailable")).toBeNull()
		expect(verificationBadge(null)).toBeNull()
		expect(verificationBadge("something_new")).toBeNull()
	})
})

describe("fieldOrNull", () => {
	it("trims and nulls the empty field", () => {
		expect(fieldOrNull("  Acme ")).toBe("Acme")
		expect(fieldOrNull("   ")).toBeNull()
	})
})
