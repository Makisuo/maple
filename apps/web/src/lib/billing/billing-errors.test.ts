import { describe, expect, it } from "vitest"
import {
	BillingConflictError,
	BillingNotConfiguredError,
	BillingPaymentRequiredError,
	BillingRateLimitedError,
	BillingRequestError,
	BillingUpstreamError,
} from "@maple/domain/http"
import { GENERIC_BILLING_ERROR, billingErrorMessage } from "./billing-errors"

const context = { code: "some_code", upstreamStatus: 402 }

describe("billingErrorMessage", () => {
	it("keeps Autumn's decline reason, which is the only place that detail exists", () => {
		const message = billingErrorMessage(
			new BillingPaymentRequiredError({ ...context, message: "Card declined" }),
		)
		expect(message).toContain("Card declined")
		expect(message).toContain("billing portal")
	})

	it("never tells someone to retry a conflict", () => {
		// Retrying a 409 can only produce another 409. This was the actual copy
		// shown to customers who had already subscribed successfully.
		const message = billingErrorMessage(
			new BillingConflictError({ ...context, upstreamStatus: 409, message: "already attached" }),
		)
		expect(message).not.toContain("try again")
		expect(message).toContain("Refresh")
	})

	it("owns a configuration fault instead of blaming the customer", () => {
		const message = billingErrorMessage(
			new BillingNotConfiguredError({ message: "Billing is not configured" }),
		)
		expect(message).toContain("on us")
		expect(message).not.toBe(GENERIC_BILLING_ERROR)
	})

	it("tells a rate-limited caller to wait rather than hammer", () => {
		const message = billingErrorMessage(
			new BillingRateLimitedError({ ...context, upstreamStatus: 429, message: "slow down" }),
		)
		expect(message).toContain("moment")
	})

	it("passes an upstream request rejection through in Autumn's words", () => {
		const message = billingErrorMessage(
			new BillingRequestError({ ...context, upstreamStatus: 400, message: "Unknown plan id" }),
		)
		expect(message).toBe("Unknown plan id")
	})

	it("still surfaces a plain 502 message", () => {
		expect(billingErrorMessage(new BillingUpstreamError({ message: "upstream unavailable" }))).toBe(
			"upstream unavailable",
		)
	})

	it("falls back only when there is genuinely nothing to say", () => {
		expect(billingErrorMessage({})).toBe(GENERIC_BILLING_ERROR)
		expect(billingErrorMessage(new Error("   "))).toBe(GENERIC_BILLING_ERROR)
	})
})
