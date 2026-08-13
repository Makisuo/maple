import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { BillingControls, BillingSpendLimit, BillingUsageAlert } from "./billing"

// Autumn omits a billing control's `enabled` when it holds the API default, and
// the two defaults differ. `autumn-js` injected them in its inbound Zod schemas
// (`z._default(boolean(), false)` for a spend limit, `z._default(boolean(),
// true)` for a usage alert), so nothing downstream ever saw the key missing.
// Without the same defaults here, every `getCustomer` on such an org 502s.
describe("billing control enabled defaults", () => {
	const decodeSpendLimit = Schema.decodeUnknownSync(BillingSpendLimit)
	const decodeUsageAlert = Schema.decodeUnknownSync(BillingUsageAlert)

	it("defaults a spend limit with no enabled key to disabled", () => {
		expect(
			decodeSpendLimit({ featureId: "logs", limitType: "absolute", overageLimit: 250 }),
		).toMatchObject({ featureId: "logs", enabled: false })
	})

	it("defaults a usage alert with no enabled key to enabled", () => {
		expect(
			decodeUsageAlert({ featureId: "logs", threshold: 80, thresholdType: "usage_percentage" }),
		).toMatchObject({ featureId: "logs", enabled: true })
	})

	it("keeps an explicit enabled over the default, either way", () => {
		expect(decodeSpendLimit({ featureId: "logs", enabled: true }).enabled).toBe(true)
		expect(
			decodeUsageAlert({
				featureId: "logs",
				enabled: false,
				threshold: 80,
				thresholdType: "usage_percentage",
			}).enabled,
		).toBe(false)
	})

	// The same classes are the `getCustomer` success schema, so the server
	// ENCODES them on the way out. A defaulted value has to survive that trip or
	// the web client would decode it back to the default rather than the truth.
	it("round-trips through encoding with enabled present on the wire", () => {
		const controls = Schema.decodeSync(BillingControls)({
			spendLimits: [{ featureId: "logs", overageLimit: 250 }],
			usageAlerts: [{ featureId: "logs", threshold: 80, thresholdType: "usage_percentage" }],
		})
		expect(Schema.encodeUnknownSync(BillingControls)(controls)).toEqual({
			spendLimits: [{ featureId: "logs", enabled: false, overageLimit: 250 }],
			usageAlerts: [
				{ featureId: "logs", enabled: true, threshold: 80, thresholdType: "usage_percentage" },
			],
		})
	})
})
