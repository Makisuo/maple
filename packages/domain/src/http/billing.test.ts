import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
	BillingConflictError,
	BillingControls,
	BillingNotConfiguredError,
	BillingPaymentRequiredError,
	BillingRateLimitedError,
	BillingRequestError,
	BillingSpendLimit,
	BillingUpstreamError,
	BillingUsageAlert,
} from "./billing"
import { publicHttpErrorBody } from "./error-policy"

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

// Each billing failure owns its public presentation, so the web needs no
// tag switch: `displayError(err).message` reads whatever the class declares.
// These assertions are the contract that makes deleting that switch safe.
describe("billing error presentation", () => {
	const context = { code: "autumn_code", upstreamStatus: 402 }

	it("shows the upstream decline reason verbatim — it is the only place that detail exists", () => {
		const body = publicHttpErrorBody(
			new BillingPaymentRequiredError({ ...context, message: "Card declined" }),
		)
		expect(body).toMatchObject({
			type: "payment_error",
			code: "billing_payment_required",
			message: "Card declined",
			retryable: false,
			recovery: "fix_request",
		})
	})

	it("never advises retrying a conflict, and redacts the upstream wording", () => {
		// Retrying a 409 can only produce another 409 — this was the copy shown to
		// customers whose subscription had already succeeded.
		const body = publicHttpErrorBody(
			new BillingConflictError({ ...context, upstreamStatus: 409, message: "already attached" }),
		)
		expect(body.type).toBe("conflict_error")
		expect(body.message).not.toContain("already attached")
		expect(body.retryable).toBe(false)
		expect(body.recovery).toBe("refresh")
	})

	it("marks throttling as the one retryable rejection", () => {
		const body = publicHttpErrorBody(
			new BillingRateLimitedError({ ...context, upstreamStatus: 429, message: "slow down" }),
		)
		expect(body).toMatchObject({ type: "rate_limit_error", retryable: true, recovery: "retry" })
	})

	it("owns a credentials fault instead of blaming the customer or the upstream", () => {
		// A revoked key is our deployment fault: 5xx so it stays in error tracking,
		// and contact_support because no amount of retrying fixes it.
		const body = publicHttpErrorBody(
			new BillingNotConfiguredError({ message: "Autumn rejected our credentials (HTTP 401)" }),
		)
		expect(body).toMatchObject({
			type: "api_error",
			code: "billing_not_configured",
			retryable: false,
			recovery: "contact_support",
		})
		expect(body.message).not.toContain("Autumn")
	})

	it("keeps a dependency's wording out of a public 5xx", () => {
		const body = publicHttpErrorBody(new BillingUpstreamError({ message: "ECONNREFUSED 10.0.0.1" }))
		expect(body.type).toBe("api_error")
		expect(body.message).not.toContain("ECONNREFUSED")
		expect(body.retryable).toBe(true)
	})

	it("passes an upstream request rejection through in the upstream's words", () => {
		const body = publicHttpErrorBody(
			new BillingRequestError({ ...context, upstreamStatus: 400, message: "Unknown plan id" }),
		)
		expect(body).toMatchObject({ type: "invalid_request_error", message: "Unknown plan id" })
	})
})
