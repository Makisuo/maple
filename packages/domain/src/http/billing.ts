import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { WarehouseQueryError } from "./warehouse-errors"

// Typed Maple contract in front of the `autumn-js/backend` proxy. The handlers
// (apps/api/src/routes/billing.http.ts) still call `autumnHandler` internally, so
// every success schema below mirrors the raw JSON that Autumn returns — which is
// exactly what the old `autumn-js/react` hooks surfaced to the UI. Schemas model
// only the consumed subset and lean on optional/nullable fields so an upstream
// shape addition can't fail decoding and 500 the endpoint (excess keys are
// dropped by `Schema.Struct`/`Schema.Class` decoding).

// ---- Plan shapes shared by the catalog and the customer's own plan ----
//
// Declared first because `BillingSubscriptionPlan` (the customer's expanded plan)
// is built from them, and a Schema.Class evaluates its fields at module init —
// referencing a class declared further down would throw at import time.

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

// ---- Customer (getOrCreateCustomer) ----

export class BillingBalance extends Schema.Class<BillingBalance>("BillingBalance")({
	granted: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	usage: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	remaining: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	unlimited: Schema.optionalKey(Schema.Boolean),
	overageAllowed: Schema.optionalKey(Schema.Boolean),
}) {}

/**
 * The customer's OWN plan, as returned by `getOrCreateCustomer` with
 * `expand: ["subscriptions.plan"]`.
 *
 * This is the authority on what the customer pays. The public catalog
 * (`listPlans`) only describes what is *for sale*, so for a custom-priced or
 * grandfathered plan its prices are somebody else's — pricing anything from the
 * catalog when this is present shows the customer a bill that isn't theirs.
 *
 * Shares `CatalogPlanItem` / `CatalogPlanPrice`: same shape, same units.
 */
export class BillingSubscriptionPlan extends Schema.Class<BillingSubscriptionPlan>("BillingSubscriptionPlan")(
	{
		id: Schema.optionalKey(Schema.NullOr(Schema.String)),
		name: Schema.optionalKey(Schema.NullOr(Schema.String)),
		archived: Schema.optionalKey(Schema.Boolean),
		price: Schema.optionalKey(Schema.NullOr(CatalogPlanPrice)),
		// Absent unless expanded, so every consumer has to tolerate its absence.
		items: Schema.optionalKey(Schema.NullOr(Schema.Array(CatalogPlanItem))),
	},
) {}

export class BillingSubscription extends Schema.Class<BillingSubscription>("BillingSubscription")({
	planId: Schema.String,
	// Present when the caller expands `subscriptions.plan` (the customer read
	// does). Legacy detection still compares planId against the live catalog.
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

export class CatalogPlanEligibility extends Schema.Class<CatalogPlanEligibility>("CatalogPlanEligibility")({
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

export class BillingInvoicesResponse extends Schema.Class<BillingInvoicesResponse>("BillingInvoicesResponse")(
	{
		invoices: Schema.Array(BillingInvoice),
	},
) {}

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

// ---- Daily spend series (warehouse-backed) ----

/**
 * One UTC day of billable volume. Units match how the ingest gateway meters to
 * Autumn — decimal GB for the byte signals, a raw count for sessions — so the
 * client can price a day with the catalog's overage rates and land on the same
 * dollars as the invoice.
 */
export class DailyVolume extends Schema.Class<DailyVolume>("DailyVolume")({
	/** `YYYY-MM-DD`, UTC. */
	date: Schema.String,
	logsGB: Schema.Number,
	tracesGB: Schema.Number,
	metricsGB: Schema.Number,
	browserSessions: Schema.Number,
}) {}

export class DailySpendResponse extends Schema.Class<DailySpendResponse>("DailySpendResponse")({
	/** Ascending by date, gap-filled across the whole cycle so day N is index N. */
	days: Schema.Array(DailyVolume),
	/** Cycle bounds the series covers, epoch ms. */
	cycleStart: Schema.Number,
	cycleEnd: Schema.Number,
}) {}

// ---- Spend limits (Postgres-backed) ----

export const SpendEnforcementMode = Schema.Literals(["notify", "pause"])
export type SpendEnforcementMode = typeof SpendEnforcementMode.Type

export class SpendLimits extends Schema.Class<SpendLimits>("SpendLimits")({
	/** Null = no ceiling configured; per-feature caps may still apply. */
	monthlyLimitCents: Schema.NullOr(Schema.Number),
	enforcementMode: SpendEnforcementMode,
	alertThresholdPercents: Schema.Array(Schema.Number),
	/** Keyed by Autumn featureId; null = no cap, overage billed at the plan rate. */
	featureCaps: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),

	// Derived evaluation state, written by the spend-limit cron. Read-only here:
	// the client renders breach/pause state, it never asserts it.
	lastEvaluatedAt: Schema.NullOr(Schema.Number),
	evaluatedSpendCents: Schema.NullOr(Schema.Number),
	breachedAt: Schema.NullOr(Schema.Number),
	pausedAt: Schema.NullOr(Schema.Number),
	/** Features paused by their own cap — a logs cap never stops traces. */
	pausedFeatures: Schema.Array(Schema.String),
}) {}

/**
 * Full replace of the editable fields — the billing page edits this as one card
 * (limit + thresholds + mode + caps), so a partial patch would let two
 * concurrent saves interleave into a state neither user chose.
 */
export class UpdateSpendLimitsRequest extends Schema.Class<UpdateSpendLimitsRequest>(
	"UpdateSpendLimitsRequest",
)({
	monthlyLimitCents: Schema.NullOr(Schema.Number),
	enforcementMode: SpendEnforcementMode,
	alertThresholdPercents: Schema.Array(Schema.Number),
	featureCaps: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
}) {}

export class SpendLimitValidationError extends Schema.TaggedErrorClass<SpendLimitValidationError>()(
	"@maple/http/errors/SpendLimitValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class SpendLimitPersistenceError extends Schema.TaggedErrorClass<SpendLimitPersistenceError>()(
	"@maple/http/errors/SpendLimitPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

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
	// Warehouse-backed, unlike every other read in this group: Autumn only knows
	// cycle totals, so the daily shape behind the spend chart comes from
	// `service_usage` + `session_replays`.
	.add(
		HttpApiEndpoint.get("getDailySpend", "/daily-spend", {
			success: DailySpendResponse,
			error: [BillingUpstreamError, WarehouseQueryError],
		}),
	)
	.add(
		HttpApiEndpoint.get("getSpendLimits", "/spend-limits", {
			success: SpendLimits,
			error: SpendLimitPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("updateSpendLimits", "/spend-limits", {
			payload: UpdateSpendLimitsRequest,
			success: SpendLimits,
			error: [SpendLimitValidationError, SpendLimitPersistenceError],
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
