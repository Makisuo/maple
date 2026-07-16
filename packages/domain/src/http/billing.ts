import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

// Typed Maple contract in front of the `autumn-js/backend` proxy. The handlers
// (apps/api/src/routes/billing.http.ts) still call `autumnHandler` internally, so
// every success schema below mirrors the raw JSON that Autumn returns — which is
// exactly what the old `autumn-js/react` hooks surfaced to the UI. Schemas model
// only the consumed subset and lean on optional/nullable fields so an upstream
// shape addition can't fail decoding and 500 the endpoint (excess keys are
// dropped by `Schema.Struct`/`Schema.Class` decoding).

// ---- Customer (getOrCreateCustomer) ----

export class BillingBalance extends Schema.Class<BillingBalance>("BillingBalance")({
	granted: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	usage: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	remaining: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	unlimited: Schema.optionalKey(Schema.Boolean),
	overageAllowed: Schema.optionalKey(Schema.Boolean),
}) {}

export class BillingSubscriptionPlan extends Schema.Class<BillingSubscriptionPlan>(
	"BillingSubscriptionPlan",
)({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	archived: Schema.optionalKey(Schema.Boolean),
}) {}

export class BillingSubscription extends Schema.Class<BillingSubscription>("BillingSubscription")({
	planId: Schema.String,
	// getOrCreateCustomer does NOT expand the plan, so this is usually absent —
	// legacy detection compares planId against the live catalog instead.
	plan: Schema.optionalKey(Schema.NullOr(BillingSubscriptionPlan)),
	status: Schema.String,
	addOn: Schema.optionalKey(Schema.Boolean),
	autoEnable: Schema.optionalKey(Schema.Boolean),
	pastDue: Schema.optionalKey(Schema.Boolean),
	trialEndsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	currentPeriodStart: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	currentPeriodEnd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	quantity: Schema.optionalKey(Schema.Number),
}) {}

export class BillingCustomer extends Schema.Class<BillingCustomer>("BillingCustomer")({
	id: Schema.String,
	subscriptions: Schema.Array(BillingSubscription),
	balances: Schema.optionalKey(Schema.Record(Schema.String, BillingBalance)),
	flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// ---- Plan catalog (listPlans) ----

export class CatalogPlanItemPrice extends Schema.Class<CatalogPlanItemPrice>("CatalogPlanItemPrice")({
	amount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	billingUnits: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	interval: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class CatalogPlanItem extends Schema.Class<CatalogPlanItem>("CatalogPlanItem")({
	featureId: Schema.String,
	included: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	unlimited: Schema.optionalKey(Schema.Boolean),
	price: Schema.optionalKey(Schema.NullOr(CatalogPlanItemPrice)),
	feature: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
	display: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ secondaryText: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
}) {}

export class CatalogPlanPrice extends Schema.Class<CatalogPlanPrice>("CatalogPlanPrice")({
	amount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	interval: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class CatalogPlanEligibility extends Schema.Class<CatalogPlanEligibility>(
	"CatalogPlanEligibility",
)({
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
	attachAction: Schema.optionalKey(Schema.NullOr(Schema.String)),
	trialAvailable: Schema.optionalKey(Schema.Boolean),
}) {}

export class CatalogPlanFreeTrial extends Schema.Class<CatalogPlanFreeTrial>("CatalogPlanFreeTrial")({
	durationLength: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

export class CatalogPlan extends Schema.Class<CatalogPlan>("CatalogPlan")({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	addOn: Schema.optionalKey(Schema.Boolean),
	autoEnable: Schema.optionalKey(Schema.Boolean),
	archived: Schema.optionalKey(Schema.Boolean),
	price: Schema.optionalKey(Schema.NullOr(CatalogPlanPrice)),
	items: Schema.Array(CatalogPlanItem),
	customerEligibility: Schema.optionalKey(Schema.NullOr(CatalogPlanEligibility)),
	freeTrial: Schema.optionalKey(Schema.NullOr(CatalogPlanFreeTrial)),
}) {}

export class CatalogPlansResponse extends Schema.Class<CatalogPlansResponse>("CatalogPlansResponse")({
	plans: Schema.Array(CatalogPlan),
}) {}

// ---- Invoices (getOrCreateCustomer with expand: ["invoices"]) ----

export class BillingInvoice extends Schema.Class<BillingInvoice>("BillingInvoice")({
	stripeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	planIds: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
	// Stripe invoice status: "paid" | "open" | "draft" | "void" | "uncollectible"
	// — kept as a plain string so an unknown status can't fail decoding.
	status: Schema.String,
	// Dollars, not cents (matches previewAttach totals).
	total: Schema.Number,
	currency: Schema.String,
	createdAt: Schema.Number,
	// Stripe-hosted invoice page (view/PDF). Absent for draft invoices.
	hostedInvoiceUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class BillingInvoicesResponse extends Schema.Class<BillingInvoicesResponse>(
	"BillingInvoicesResponse",
)({
	invoices: Schema.Array(BillingInvoice),
}) {}

// ---- Usage (aggregateEvents) ----

export class BillingUsageFeature extends Schema.Class<BillingUsageFeature>("BillingUsageFeature")({
	sum: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

export class BillingUsage extends Schema.Class<BillingUsage>("BillingUsage")({
	// Keyed by Autumn featureId (logs/traces/metrics/browser_sessions).
	total: Schema.optionalKey(Schema.Record(Schema.String, BillingUsageFeature)),
}) {}

const BillingUsageQuery = Schema.Struct({
	featureId: Schema.Array(Schema.String),
	range: Schema.String,
})

// ---- Mutations (attach / previewAttach / openCustomerPortal) ----

export class AttachRequest extends Schema.Class<AttachRequest>("AttachRequest")({
	planId: Schema.String,
}) {}

export class AttachResult extends Schema.Class<AttachResult>("AttachResult")({
	// Present when checkout requires a redirect to Stripe; absent on inline change.
	paymentUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

export class PreviewAttachRequest extends Schema.Class<PreviewAttachRequest>("PreviewAttachRequest")({
	planId: Schema.String,
}) {}

export class PreviewLineItem extends Schema.Class<PreviewLineItem>("PreviewLineItem")({
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	total: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

export class PreviewNextCycle extends Schema.Class<PreviewNextCycle>("PreviewNextCycle")({
	startsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	total: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

export class PreviewAttachResult extends Schema.Class<PreviewAttachResult>("PreviewAttachResult")({
	lineItems: Schema.Array(PreviewLineItem),
	total: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
	nextCycle: Schema.optionalKey(Schema.NullOr(PreviewNextCycle)),
}) {}

export class CustomerPortalRequest extends Schema.Class<CustomerPortalRequest>("CustomerPortalRequest")({
	returnUrl: Schema.optional(Schema.String),
}) {}

export class CustomerPortalResult extends Schema.Class<CustomerPortalResult>("CustomerPortalResult")({
	url: Schema.String,
}) {}

// ---- Errors ----

export class BillingUpstreamError extends Schema.TaggedErrorClass<BillingUpstreamError>()(
	"@maple/http/errors/BillingUpstreamError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 502 },
) {}

// ---- Groups ----

// Authed billing operations: customer/usage reads + attach/preview/portal.
export class BillingApiGroup extends HttpApiGroup.make("billing")
	.add(
		HttpApiEndpoint.get("getCustomer", "/customer", {
			success: BillingCustomer,
			error: BillingUpstreamError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getUsage", "/usage", {
			query: BillingUsageQuery,
			success: BillingUsage,
			error: BillingUpstreamError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listInvoices", "/invoices", {
			success: BillingInvoicesResponse,
			error: BillingUpstreamError,
		}),
	)
	.add(
		HttpApiEndpoint.post("attach", "/attach", {
			payload: AttachRequest,
			success: AttachResult,
			error: BillingUpstreamError,
		}),
	)
	.add(
		HttpApiEndpoint.post("previewAttach", "/preview-attach", {
			payload: PreviewAttachRequest,
			success: PreviewAttachResult,
			error: BillingUpstreamError,
		}),
	)
	.add(
		HttpApiEndpoint.post("openCustomerPortal", "/portal", {
			payload: CustomerPortalRequest,
			success: CustomerPortalResult,
			error: BillingUpstreamError,
		}),
	)
	.prefix("/api/billing")
	.middleware(Authorization) {}

// The plan catalog is global, so `listPlans` stays public — a transient
// onboarding token gap serves the catalog instead of a 401. The handler still
// resolves the tenant optionally to carry per-customer `customerEligibility`.
export class BillingPublicApiGroup extends HttpApiGroup.make("billingPublic")
	.add(
		HttpApiEndpoint.get("listPlans", "/plans", {
			success: CatalogPlansResponse,
			error: BillingUpstreamError,
		}),
	)
	.prefix("/api/billing") {}
