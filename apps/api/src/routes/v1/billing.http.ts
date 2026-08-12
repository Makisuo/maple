import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
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
	CatalogPlan,
	CatalogPlansResponse,
	CurrentTenant,
	CustomerPortalResult,
	MapleApi,
	PreviewAttachResult,
} from "@maple/domain/http"
import {
	CUSTOMER_CACHE_BUCKET,
	decodeUpstream,
	ensureOk,
	readCustomerCached,
} from "@/services/billing/autumn-client"
import { AutumnClient, type AutumnResult } from "@/services/billing/autumn-http"
import { AuthService } from "@/services/auth/AuthService"
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

export const HttpBillingLive = HttpApiBuilder.group(MapleApi, "billing", (handlers) =>
	Effect.gen(function* () {
		const edgeCache = yield* EdgeCacheService
		const dailySpend = yield* DailySpendService
		const autumn = yield* AutumnClient

		// Invalidate on any 2xx, matching `ensureOk` — otherwise a 201/204 from
		// attach/openCustomerPortal would decode as success yet leave the stale
		// cached customer in place for up to the TTL.
		const invalidateCustomer = (orgId: string, result: AutumnResult) =>
			result.statusCode >= 200 && result.statusCode < 300
				? edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId })
				: Effect.void

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
						yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "cache.hit": hit })
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
						yield* ensureOk(result)
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
						const result = yield* autumn.attach(tenant.orgId, { planId: payload.planId })
						const response = yield* ensureOk(result)
						yield* invalidateCustomer(tenant.orgId, result)
						return yield* decodeUpstream(AttachResult, response)
					}),
				)
				.handle("previewAttach", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const result = yield* autumn.previewAttach(tenant.orgId, {
							planId: payload.planId,
						})
						const response = yield* ensureOk(result)
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
		)
	}),
)

export const HttpBillingPublicLive = HttpApiBuilder.group(MapleApi, "billingPublic", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const autumn = yield* AutumnClient

		return handlers.handle("listPlans", () =>
			Effect.gen(function* () {
				// Public route: resolve the tenant optionally so an onboarding token gap
				// still serves the catalog, while authed callers get per-customer
				// `customerEligibility` (autumn marks listPlans' customerId optional).
				const req = yield* HttpServerRequest.HttpServerRequest
				const tenant = yield* Effect.option(auth.resolveTenant(req.headers as Record<string, string>))
				const customerId = Option.getOrUndefined(tenant)?.orgId
				const result = yield* autumn.listPlans(customerId)
				const response = yield* ensureOk(result)
				// Autumn wraps the catalog as `{ list: [...] }`.
				const list = (response as { list?: unknown })?.list ?? response
				const plans = yield* decodeUpstream(Schema.Array(CatalogPlan), list)
				return new CatalogPlansResponse({ plans })
			}),
		)
	}),
)
