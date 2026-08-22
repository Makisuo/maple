import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Clock, Effect, Option, Schema } from "effect"
import { EdgeCacheService } from "@maple/cache"
import {
	AttachResult,
	BillingCustomer,
	BillingForbiddenError,
	BillingInvoice,
	BillingInvoicesResponse,
	BillingUpstreamError,
	BillingUsage,
	CurrentTenant,
	CustomerPortalResult,
	MapleInternalApi,
	PreviewAttachResult,
} from "@maple/domain/http"
import {
	CUSTOMER_CACHE_BUCKET,
	classifyAutumn,
	decodeUpstream,
	ensureOk,
	readCustomerCached,
	resolveAttachConflict,
	summariseSubscriptions,
} from "@/services/billing/autumn-client"
import { AutumnClient, type AutumnResult } from "@/services/billing/autumn-http"
import { StripeClient } from "@/services/billing/stripe-http"
import {
	ensureStripeCustomerId,
	isAlreadyRemoved,
	readBillingProfile,
	readStripeCustomerId,
	unlinkedProfile,
} from "@/services/billing/billing-profile"
import { forkRequestScoped } from "@/platform/fork-request-scoped"
import { emitPlanStartedFromAttach } from "@/services/billing/plan-events"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { requireAdmin } from "@/services/auth/auth"
import { DailySpendService } from "@/services/billing/DailySpendService"

// Pull the `invoices` array off a raw expanded `getOrCreateCustomer` response.
// Exported for tests. Autumn omits the key for a customer with no invoices, so
// an absent/null field decodes as an empty list rather than a 502.
export const decodeInvoices = (
	response: unknown,
): Effect.Effect<BillingInvoicesResponse, BillingUpstreamError> => {
	const invoices = (response as { invoices?: unknown } | null)?.invoices ?? []
	return decodeUpstream(Schema.Array(BillingInvoice), invoices).pipe(
		Effect.map((decoded) => new BillingInvoicesResponse({ invoices: decoded })),
	)
}

/**
 * The FULL billing cycle for the spend series. Prefers the active subscription's
 * period (an org billed on its own anniversary must not be charted on calendar
 * months), and falls back to the current calendar month for an org between
 * subscriptions — there's still usage to show.
 *
 * Deliberately NOT clamped to now: the chart's job is to show where this cycle is
 * headed, so the axis has to reach the day the bill closes. Clamping belongs to
 * the warehouse read (DailySpendService), not to the window itself.
 */
export const resolveCycleWindow = (
	customer: BillingCustomer,
	nowMs: number,
): { readonly startMs: number; readonly endMs: number; readonly nowMs: number } => {
	const active = customer.subscriptions.find((sub) => sub.status === "active")
	if (active?.currentPeriodStart != null && active.currentPeriodEnd != null) {
		return { startMs: active.currentPeriodStart, endMs: active.currentPeriodEnd, nowMs }
	}
	const now = new Date(nowMs)
	return {
		startMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		// End of the calendar month, so a planless org still gets a full axis.
		endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1,
		nowMs,
	}
}

export const HttpBillingLive = HttpApiBuilder.group(MapleInternalApi, "billing", (handlers) =>
	Effect.gen(function* () {
		const edgeCache = yield* EdgeCacheService
		const dailySpend = yield* DailySpendService
		const autumn = yield* AutumnClient
		const stripe = yield* StripeClient
		const productEvents = yield* ProductEventsService

		// Invalidate on any 2xx, matching `ensureOk` — otherwise a 201/204 from
		// attach/openCustomerPortal would decode as success yet leave the stale
		// cached customer in place for up to the TTL.
		const invalidateCustomer = (orgId: string, result: AutumnResult) =>
			result.statusCode >= 200 && result.statusCode < 300
				? edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId })
				: Effect.void

		// The billing-details writes share one preamble: admins only, and a Stripe
		// customer to write to (created through Autumn on first use).
		const stripeCustomerForWrite = (tenant: CurrentTenant.TenantSchema) =>
			Effect.gen(function* () {
				yield* requireAdmin(
					tenant.roles,
					() =>
						new BillingForbiddenError({ message: "Only org admins can manage billing details" }),
				)
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
				return yield* ensureStripeCustomerId(edgeCache, autumn, tenant.orgId)
			})

		return (
			handlers
				.handle("getCustomer", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const { result, hit } = yield* readCustomerCached(
							edgeCache,
							tenant.orgId,
							// The customer's OWN plan: for a custom-priced or grandfathered
							// plan it is the only source of their real price and allotments.
							// Without it the page would quote the public catalog's rates at
							// them.
							autumn.getOrCreateCustomer(tenant.orgId, { expand: ["subscriptions.plan"] }),
						)
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"cache.hit": hit,
							// The plan gate is derived from these rows; without them a
							// wrongly-gated org can only be diagnosed by asking the customer
							// to open devtools.
							...summariseSubscriptions(result.response),
						})
						const response = yield* ensureOk(result)
						return yield* decodeUpstream(BillingCustomer, response)
					}),
				)
				.handle("getUsage", ({ query }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* autumn.aggregateEvents(tenant.orgId, {
							featureId: query.featureId,
							range: query.range,
						})
						const response = yield* ensureOk(result)
						return yield* decodeUpstream(BillingUsage, response)
					}),
				)
				// Invoices ride along on getOrCreateCustomer via `expand`, but through a
				// dedicated endpoint (not the cached hot-path customer read): the customer
				// atom is fetched on every page and edge-cached 5 min, while the invoice
				// list is a settings-only read where an "open" invoice must show promptly.
				.handle("listInvoices", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* autumn.getOrCreateCustomer(tenant.orgId, {
							expand: ["invoices"],
						})
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const response = yield* ensureOk(result)
						return yield* decodeInvoices(response)
					}),
				)
				.handle("getDailySpend", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// The cycle window comes from the subscription, not the calendar:
						// an org that subscribed mid-month is billed on its own anniversary
						// and a calendar-month chart would disagree with the invoice.
						const { result } = yield* readCustomerCached(
							edgeCache,
							tenant.orgId,
							// The customer's OWN plan: for a custom-priced or grandfathered
							// plan it is the only source of their real price and allotments.
							// Without it the page would quote the public catalog's rates at
							// them.
							autumn.getOrCreateCustomer(tenant.orgId, { expand: ["subscriptions.plan"] }),
						)
						const response = yield* ensureOk(result)
						const customer = yield* decodeUpstream(BillingCustomer, response)
						const cycle = resolveCycleWindow(customer, yield* Clock.currentTimeMillis)
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						return yield* dailySpend.get(tenant, cycle)
					}),
				)
				.handle("updateBillingControls", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* requireAdmin(
							tenant.roles,
							() =>
								new BillingForbiddenError({
									message: "Only org admins can manage billing controls",
								}),
						)
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const result = yield* autumn.updateCustomerBillingControls(tenant.orgId, payload)
						// Caller input: a rejected control is about what THEY asked for, so
						// the classified 4xx survives to the client instead of a blanket 502.
						yield* classifyAutumn(result)
						yield* invalidateCustomer(tenant.orgId, result)
						const refreshed = yield* autumn.getOrCreateCustomer(tenant.orgId, {
							expand: ["subscriptions.plan"],
						})
						return yield* ensureOk(refreshed).pipe(
							Effect.flatMap((response) => decodeUpstream(BillingCustomer, response)),
						)
					}),
				)
				.handle("attach", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						// No buyer identity rides along: `/v1/billing.attach` carries no
						// identity fields in Autumn 2.3.0, and the `customerData` we used to
						// hand `autumnHandler` here was silently discarded by it. Seeding
						// the Stripe checkout with the Clerk email would need a separate
						// `customers.get_or_create` on this path — a behaviour change, not
						// part of this port.
						yield* Effect.annotateCurrentSpan({
							orgId: tenant.orgId,
							"billing.plan_id": payload.planId,
						})
						const result = yield* autumn.attach(tenant.orgId, {
							planId: payload.planId,
							successUrl: payload.successUrl,
						})
						const response = yield* classifyAutumn(result).pipe(
							Effect.catchTag(
								"@maple/http/errors/BillingConflictError",
								// A conflict is what a double-click produces: the first attach
								// succeeded, the page sat on the old DOM while the browser
								// navigated to Stripe, and the customer clicked again. Autumn
								// answers 409, which we used to launder into a 502 and show as
								// "Something went wrong. Please try again." — telling someone
								// who had just paid that their purchase had failed.
								//
								// Re-read rather than assume: 409 is not exclusively
								// already-attached. Only when the customer genuinely holds the
								// plan is this a success; any other conflict still surfaces.
								(conflict) =>
									resolveAttachConflict(
										autumn.getOrCreateCustomer(tenant.orgId, {
											expand: ["subscriptions.plan"],
										}),
										payload.planId,
										conflict,
									),
							),
						)
						yield* invalidateCustomer(tenant.orgId, result)
						const attached = yield* decodeUpstream(AttachResult, response)
						// Inline (no-redirect) plan start; the Autumn webhook covers the
						// Stripe-checkout path. Never fails the request.
						//
						// FORKED, unlike the webhook receivers: this is the Subscribe
						// click, the one request where a stall reads as a failed payment,
						// and `track` is a bounded-but-not-free POST to the ingest
						// gateway. `forkRequestScoped` means a gateway that answers
						// normally still gets the event (the fiber finishes long before
						// the response is written) while a stalled one is interrupted at
						// the response instead of holding the user. Losing it there costs
						// nothing durable — `plan_events.ts` is explicit that this emit is
						// the low-latency COMPLEMENT and the `billing.updated` webhook is
						// the authoritative `plan_started`.
						yield* forkRequestScoped(
							emitPlanStartedFromAttach(productEvents, {
								orgId: tenant.orgId,
								userId: tenant.userId,
								planId: payload.planId,
								result: attached,
							}),
						)
						return attached
					}),
				)
				.handle("previewAttach", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* autumn.previewAttach(tenant.orgId, {
							planId: payload.planId,
						})
						// Caller input (a plan id): keep the classified rejection.
						const response = yield* classifyAutumn(result)
						return yield* decodeUpstream(PreviewAttachResult, response)
					}),
				)
				.handle("openCustomerPortal", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* autumn.openCustomerPortal(tenant.orgId, {
							returnUrl: payload.returnUrl,
						})
						const response = yield* ensureOk(result)
						yield* invalidateCustomer(tenant.orgId, result)
						return yield* decodeUpstream(CustomerPortalResult, response)
					}),
				)
				.handle("getBillingProfile", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
						const stripeCustomerId = yield* readStripeCustomerId(edgeCache, autumn, tenant.orgId)
						yield* Effect.annotateCurrentSpan({
							"billing.stripe_linked": Option.isSome(stripeCustomerId),
						})
						if (Option.isNone(stripeCustomerId)) return unlinkedProfile()
						return yield* readBillingProfile(stripe, stripeCustomerId.value)
					}),
				)
				.handle("updateBillingProfile", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const stripeCustomerId = yield* stripeCustomerForWrite(tenant)
						const result = yield* stripe.updateCustomer(stripeCustomerId, {
							name: payload.name,
							address: payload.address,
						})
						// Caller input: Stripe's rejection (a bad country code, say) is about
						// what THEY sent, so the classified 4xx survives to the client.
						yield* classifyAutumn(result)
						return yield* readBillingProfile(stripe, stripeCustomerId)
					}),
				)
				.handle("addBillingTaxId", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const stripeCustomerId = yield* stripeCustomerForWrite(tenant)
						// The type is a catalog identifier; the value is customer data and
						// stays off the span.
						yield* Effect.annotateCurrentSpan({ "billing.tax_id_type": payload.type })
						const result = yield* stripe.createTaxId(stripeCustomerId, {
							type: payload.type,
							value: payload.value,
						})
						// `tax_id_invalid` lands here with Stripe's own wording, which is the
						// only place the format expectation is spelled out.
						yield* classifyAutumn(result)
						return yield* readBillingProfile(stripe, stripeCustomerId)
					}),
				)
				.handle("removeBillingTaxId", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const stripeCustomerId = yield* stripeCustomerForWrite(tenant)
						const result = yield* stripe.deleteTaxId(stripeCustomerId, params.taxIdId)
						if (!isAlreadyRemoved(result)) yield* classifyAutumn(result)
						return yield* readBillingProfile(stripe, stripeCustomerId)
					}),
				)
		)
	}),
)
