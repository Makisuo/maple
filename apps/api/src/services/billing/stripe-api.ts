/**
 * Stripe API version every request pins via `Stripe-Version`.
 *
 * Pinned explicitly rather than inheriting the account default so a Dashboard
 * upgrade can't change the wire shape under us. The customer + tax-ID
 * endpoints this worker uses are unchanged across every version since 2019,
 * so bumping this is a no-risk housekeeping edit.
 */
export const STRIPE_API_VERSION = "2025-08-27.basil"
