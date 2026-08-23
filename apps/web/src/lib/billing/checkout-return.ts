/**
 * The round trip through Stripe Checkout.
 *
 * `attach` hands Autumn a `success_url`; Stripe sends the buyer back there the
 * moment checkout completes — which is BEFORE the Stripe→Autumn webhook has
 * written the subscription. A replay of a churned trial showed what that looks
 * like: the return page read a planless customer, re-rendered "Start 14-day
 * trial", and the user clicked it again. These helpers put a marker on the
 * success URL so the return can be told apart from a fresh visit and wait for
 * the sync instead of re-offering the plan.
 */

export const CHECKOUT_RETURN_PARAM = "checkout"
export const CHECKOUT_RETURN_VALUE = "complete"

/** How often the return page re-reads the customer while waiting on the sync. */
export const CHECKOUT_CONFIRM_POLL_MS = 2_000
/**
 * How long to wait before giving up and showing the plan cards again. The
 * webhook normally lands within a few seconds; a minute covers a slow Stripe
 * day without parking a user who abandoned checkout on a spinner forever.
 */
export const CHECKOUT_CONFIRM_TIMEOUT_MS = 60_000

/** The page the buyer is on, with the return marker added — Autumn's `success_url`. */
export function buildCheckoutSuccessUrl(href: string): string {
	const url = new URL(href)
	url.searchParams.set(CHECKOUT_RETURN_PARAM, CHECKOUT_RETURN_VALUE)
	return url.toString()
}

/** Did this page load come back from Stripe Checkout? */
export function isCheckoutReturn(searchStr: string | undefined): boolean {
	if (!searchStr) return false
	return new URLSearchParams(searchStr).get(CHECKOUT_RETURN_PARAM) === CHECKOUT_RETURN_VALUE
}

/** The route search without the return marker, for the `replace` that clears it. */
export function withoutCheckoutReturn<T extends Record<string, unknown>>(search: T): Omit<T, "checkout"> {
	const { [CHECKOUT_RETURN_PARAM]: _checkout, ...rest } = search
	return rest
}
