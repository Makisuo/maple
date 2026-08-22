import { Effect, Option, Schema } from "effect"
import type { EdgeCacheServiceApi } from "@maple/cache"
import {
	BillingAddress,
	BillingProfile,
	BillingProfileUnavailableError,
	BillingTaxId,
	type BillingNotConfiguredError,
	type BillingUpstreamError,
} from "@maple/domain/http"
import { CUSTOMER_CACHE_BUCKET, decodeUpstream, ensureOk, readCustomerCached } from "./autumn-client"
import type { AutumnClientApi, AutumnResult } from "./autumn-http"
import type { StripeClientApi } from "./stripe-http"

/**
 * Billing details (company name, address, tax IDs) — the glue between the
 * Autumn customer, which names the Stripe customer, and the Stripe customer,
 * which holds the details.
 *
 * Plain functions taking their collaborators, like `readCustomerCached` and
 * `resolveAttachConflict`: the route owns the services, and these stay
 * unit-testable without a handler harness.
 */

// The one field of the (raw, already-camelised, possibly cached) Autumn
// customer this module reads. Decoded, not cast: the value crosses a boundary
// marked as carrying opaque data.
const StripeLink = Schema.Struct({
	stripeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const decodeStripeLink = Schema.decodeUnknownOption(StripeLink)

/** The Stripe customer id Autumn has linked, or `None` while it hasn't created one yet. */
export const stripeCustomerIdOf = (response: unknown): Option.Option<string> =>
	decodeStripeLink(response).pipe(
		Option.flatMap((link) => Option.fromNullishOr(link.stripeId)),
		Option.filter((id) => id.length > 0),
	)

/**
 * Expand list for the customer reads here. Matches the hot-path `getCustomer`
 * read so a cache entry written by either is usable by both (the cache is keyed
 * by org only).
 */
const CUSTOMER_EXPAND = ["subscriptions.plan"] as const

/**
 * The linked Stripe customer id for an org, reading through the per-org
 * customer cache. `None` when Autumn has not created one — a READ never forces
 * it into existence, so the billing page does not mint Stripe customers for
 * every visiting org.
 */
export const readStripeCustomerId = (
	edgeCache: Pick<EdgeCacheServiceApi, "getOrCompute">,
	autumn: Pick<AutumnClientApi, "getOrCreateCustomer">,
	orgId: string,
): Effect.Effect<Option.Option<string>, BillingUpstreamError | BillingNotConfiguredError> =>
	Effect.gen(function* () {
		const { result } = yield* readCustomerCached(
			edgeCache,
			orgId,
			autumn.getOrCreateCustomer(orgId, { expand: CUSTOMER_EXPAND }),
		)
		const response = yield* ensureOk(result)
		return stripeCustomerIdOf(response)
	})

/**
 * The Stripe customer id, creating the Stripe customer through Autumn if it
 * does not exist yet (`create_in_stripe`). For the WRITE path: a customer
 * about to receive a tax ID needs somewhere to put it. Fails with
 * `BillingProfileUnavailableError` if Autumn still reports no link afterwards.
 */
export const ensureStripeCustomerId = (
	edgeCache: Pick<EdgeCacheServiceApi, "getOrCompute" | "invalidate">,
	autumn: Pick<AutumnClientApi, "getOrCreateCustomer">,
	orgId: string,
): Effect.Effect<string, BillingUpstreamError | BillingNotConfiguredError | BillingProfileUnavailableError> =>
	Effect.gen(function* () {
		const cached = yield* readStripeCustomerId(edgeCache, autumn, orgId)
		if (Option.isSome(cached)) return cached.value

		const created: AutumnResult = yield* autumn.getOrCreateCustomer(orgId, {
			expand: CUSTOMER_EXPAND,
			createInStripe: true,
		})
		const response = yield* ensureOk(created)
		// The cached snapshot predates the link; drop it so the next customer read
		// (and the next call here) sees the Stripe id.
		yield* edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId })
		const linked = stripeCustomerIdOf(response)
		yield* Effect.annotateCurrentSpan({ "billing.stripe_customer_created": Option.isSome(linked) })
		if (Option.isSome(linked)) return linked.value
		return yield* new BillingProfileUnavailableError({
			message: "Autumn returned no Stripe customer id after create_in_stripe",
		})
	})

// Stripe wire shapes, post-`camelizeKeys`. Only the consumed fields; additive
// upstream fields are tolerated.
const StripeCustomer = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	address: Schema.optionalKey(Schema.NullOr(BillingAddress)),
})

const StripeTaxIdRow = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	value: Schema.String,
	country: Schema.optionalKey(Schema.NullOr(Schema.String)),
	verification: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ status: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
})

const StripeTaxIdList = Schema.Struct({
	data: Schema.Array(StripeTaxIdRow),
})

/** An unlinked org's profile: nothing to show, nothing to edit yet. */
export const unlinkedProfile = (): BillingProfile => new BillingProfile({ linked: false, taxIds: [] })

/**
 * Read the Stripe customer + its tax IDs (concurrently) into a `BillingProfile`.
 * Both are pure reads, so a Stripe 4xx here is our bug and collapses to 502.
 */
export const readBillingProfile = (
	stripe: Pick<StripeClientApi, "getCustomer" | "listTaxIds">,
	stripeCustomerId: string,
): Effect.Effect<BillingProfile, BillingUpstreamError | BillingNotConfiguredError> =>
	Effect.gen(function* () {
		const [customerResult, taxIdsResult] = yield* Effect.all(
			[stripe.getCustomer(stripeCustomerId), stripe.listTaxIds(stripeCustomerId)],
			{ concurrency: 2 },
		)
		const customer = yield* ensureOk(customerResult).pipe(
			Effect.flatMap((body) => decodeUpstream(StripeCustomer, body)),
		)
		const taxIds = yield* ensureOk(taxIdsResult).pipe(
			Effect.flatMap((body) => decodeUpstream(StripeTaxIdList, body)),
		)
		return new BillingProfile({
			linked: true,
			name: customer.name ?? null,
			address: customer.address ?? null,
			taxIds: taxIds.data.map(
				(row) =>
					new BillingTaxId({
						id: row.id,
						type: row.type,
						value: row.value,
						country: row.country ?? null,
						verificationStatus: row.verification?.status ?? null,
					}),
			),
		})
	})

/** The `code` of the Autumn-shaped rejection body a Stripe call returns. */
const rejectionCode = (result: AutumnResult): string | undefined => {
	const code = decodeStripeCode(result.response)
	return Option.getOrUndefined(code)
}
const decodeStripeCode = (value: unknown): Option.Option<string> =>
	Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(value).pipe(
		Option.map((body) => body.code),
	)

/**
 * Deleting a tax ID Stripe no longer has is a success, not an error: the row
 * was already removed (double click, second tab). Stripe answers 404
 * `resource_missing`; anything else passes through for classification.
 */
export const isAlreadyRemoved = (result: AutumnResult): boolean =>
	result.statusCode === 404 && rejectionCode(result) === "resource_missing"
