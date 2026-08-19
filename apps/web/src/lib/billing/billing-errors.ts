/**
 * Turn a billing failure into something worth showing a customer.
 *
 * Every call site used to fall back to "Something went wrong. Please try
 * again." — which, for the failure these paths actually produce, was the worst
 * possible advice. Autumn answers a repeat `attach` with 409 (already
 * attached), so the person being told to try again had already paid, and trying
 * again could only produce another 409.
 *
 * The API now classifies upstream rejections instead of collapsing them into a
 * single 502 (see `apps/api/src/services/billing/autumn-client.ts`), so the tag
 * is available here and each case can say what actually happened.
 */

const tagOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "_tag" in error
		? String((error as { _tag: unknown })._tag)
		: ""

/** Autumn's own wording, when it left us any. */
const upstreamMessage = (error: unknown): string | null => {
	const message = error instanceof Error ? error.message : null
	return message !== null && message.trim().length > 0 ? message : null
}

export const GENERIC_BILLING_ERROR = "Something went wrong. Please try again."

export function billingErrorMessage(error: unknown): string {
	switch (tagOf(error)) {
		case "@maple/http/errors/BillingConflictError":
			// The server resolves the common case (a double-click on a plan the
			// customer now holds) into a success, so reaching this is a genuine
			// conflict — but still never the caller's fault to retry away.
			return "That plan change conflicts with your current subscription. Refresh to see where you stand."

		case "@maple/http/errors/BillingPaymentRequiredError":
			// Autumn's message IS the decline reason ("Card declined", "Your card
			// has expired"). It is the only place that detail exists, so lead with
			// it and add the one action that can fix it.
			return `${upstreamMessage(error) ?? "Your payment method was declined."} Update your payment details in the billing portal.`

		case "@maple/http/errors/BillingRateLimitedError":
			return "Billing is busy right now. Give it a moment and try again."

		case "@maple/http/errors/BillingNotConfiguredError":
			// Our deployment fault. Telling the customer to retry would be a lie.
			return "Billing is unavailable right now. This is on us — please contact support if it persists."

		case "@maple/http/errors/BillingRequestError":
			return upstreamMessage(error) ?? "That plan isn't available. Please pick another."

		default:
			return upstreamMessage(error) ?? GENERIC_BILLING_ERROR
	}
}
