import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import { WarehouseQueryError } from "./warehouse-errors"

// Contract for raw Autumn proxy responses. Schemas model only consumed fields
// and tolerate additive upstream fields.

// These precede BillingSubscriptionPlan because Schema.Class evaluates fields at module load.

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

export const BillingLimitType = Schema.Literals(["absolute", "usage_percentage"])
export type BillingLimitType = typeof BillingLimitType.Type

export const BillingFeatureId = Schema.Literals(["logs", "traces", "metrics", "browser_sessions"])
export type BillingFeatureId = typeof BillingFeatureId.Type

export const BillingAlertThresholdType = Schema.Literals([
	"usage",
	"usage_percentage",
	"remaining",
	"remaining_percentage",
])
export type BillingAlertThresholdType = typeof BillingAlertThresholdType.Type

/**
 * Autumn omits `enabled` on a billing control whose value is the API default,
 * and the two defaults differ: a spend limit is off unless said otherwise, a
 * usage alert is on. `autumn-js` injected them in its inbound Zod schemas
 * (`z._default(boolean(), false)` / `z._default(boolean(), true)`) before
 * anything downstream saw the row, so the decoded field stays a required
 * `boolean` and every consumer keeps reading it unconditionally.
 */
const SpendLimitEnabled = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
const UsageAlertEnabled = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))

/** Autumn-native cap on paid overage for one feature. */
export class BillingSpendLimit extends Schema.Class<BillingSpendLimit>("BillingSpendLimit")({
	featureId: Schema.optionalKey(Schema.String),
	enabled: SpendLimitEnabled,
	limitType: Schema.optionalKey(BillingLimitType),
	overageLimit: Schema.optionalKey(Schema.Number),
	source: Schema.optionalKey(Schema.String),
}) {}

/** Autumn-native usage alert; delivery is driven by Autumn webhooks. */
export class BillingUsageAlert extends Schema.Class<BillingUsageAlert>("BillingUsageAlert")({
	featureId: Schema.optionalKey(Schema.String),
	enabled: UsageAlertEnabled,
	threshold: Schema.Number,
	thresholdType: BillingAlertThresholdType,
	name: Schema.optionalKey(Schema.String),
	source: Schema.optionalKey(Schema.String),
}) {}

export class BillingControls extends Schema.Class<BillingControls>("BillingControls")({
	spendLimits: Schema.optionalKey(Schema.Array(BillingSpendLimit)),
	usageAlerts: Schema.optionalKey(Schema.Array(BillingUsageAlert)),
}) {}

export class BillingCustomer extends Schema.Class<BillingCustomer>("BillingCustomer")({
	id: Schema.String,
	subscriptions: Schema.Array(BillingSubscription),
	balances: Schema.optionalKey(Schema.Record(Schema.String, BillingBalance)),
	flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	billingControls: Schema.optionalKey(Schema.NullOr(BillingControls)),
}) {}

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

const NonNegativeFiniteNumber = Schema.Number.pipe(
	Schema.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
)
const UsagePercentage = Schema.Number.pipe(
	Schema.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
)

export class UpdateBillingSpendLimit extends Schema.Class<UpdateBillingSpendLimit>("UpdateBillingSpendLimit")(
	{
		featureId: BillingFeatureId,
		enabled: Schema.Boolean,
		limitType: Schema.optionalKey(BillingLimitType),
		overageLimit: Schema.optionalKey(NonNegativeFiniteNumber),
	},
) {}

export class UpdateBillingUsageAlert extends Schema.Class<UpdateBillingUsageAlert>("UpdateBillingUsageAlert")(
	{
		featureId: BillingFeatureId,
		enabled: Schema.Boolean,
		threshold: UsagePercentage,
		thresholdType: Schema.Literal("usage_percentage"),
		name: Schema.optionalKey(Schema.String),
	},
) {}

export class UpdateBillingControlsRequest extends Schema.Class<UpdateBillingControlsRequest>(
	"UpdateBillingControlsRequest",
)({
	/** Targeted Autumn upserts; disabled entries remove the corresponding control. */
	spendLimits: Schema.Array(UpdateBillingSpendLimit),
	usageAlerts: Schema.Array(UpdateBillingUsageAlert),
}) {}

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

/**
 * Context every classified Autumn rejection carries.
 *
 * `code` is Autumn's own error identifier, passed through VERBATIM as a plain
 * string. It is deliberately not a `Schema.Literals` union: Autumn owns that
 * vocabulary and can add to it at any time, and an exhaustive union here would
 * turn a new upstream code into a decode failure — trading a legible 4xx for an
 * opaque 500. The transport already parses it out at `errorResponse`
 * (`apps/api/src/services/billing/autumn-http.ts`), defaulting to
 * `"autumn_api_error"` when the body carries none.
 */
const autumnFailureFields = {
	message: Schema.String,
	code: Schema.String,
	/** The status Autumn itself answered with, before we mapped it. */
	upstreamStatus: Schema.Number,
}

/**
 * Autumn refused the charge — a declined card, an expired payment method, a
 * missing one. The `message` is Autumn's own wording, which is the only place
 * the actual decline reason exists.
 */
export class BillingPaymentRequiredError extends Schema.TaggedError<BillingPaymentRequiredError>()(
	"@maple/http/errors/BillingPaymentRequiredError",
	autumnFailureFields,
	{ httpApiStatus: 402 },
) {}

/**
 * The request conflicts with the customer's current state — most often a repeat
 * `attach` for a plan they already hold, which is what a double-click produces.
 * See the attach handler: a conflict that resolves to "already on this plan" is
 * answered as success, never surfaced.
 */
export class BillingConflictError extends Schema.TaggedError<BillingConflictError>()(
	"@maple/http/errors/BillingConflictError",
	autumnFailureFields,
	{ httpApiStatus: 409 },
) {}

/** Autumn is throttling us. Retryable as-is, unlike every other 4xx here. */
export class BillingRateLimitedError extends Schema.TaggedError<BillingRateLimitedError>()(
	"@maple/http/errors/BillingRateLimitedError",
	autumnFailureFields,
	{ httpApiStatus: 429 },
) {}

/**
 * Autumn rejected the request itself — an unknown plan id, a malformed control.
 * Only raised on endpoints that take caller input; on a pure read an upstream
 * 4xx means WE built a bad request, which is a Maple bug and stays a 502.
 */
export class BillingRequestError extends Schema.TaggedError<BillingRequestError>()(
	"@maple/http/errors/BillingRequestError",
	autumnFailureFields,
	{ httpApiStatus: 400 },
) {}

/**
 * `AUTUMN_SECRET_KEY` is unset. A deployment fault, not an upstream one — it
 * previously surfaced as a 502, which pointed every investigation at Autumn.
 */
export class BillingNotConfiguredError extends Schema.TaggedError<BillingNotConfiguredError>()(
	"@maple/http/errors/BillingNotConfiguredError",
	{ message: Schema.String },
	{ httpApiStatus: 500 },
) {}

/**
 * Autumn is broken or unreachable: a 5xx, a transport failure, an empty 2xx, or
 * a body we could not decode. Deliberately NOT used for upstream 4xx on
 * caller-input endpoints — those are the classified errors above.
 *
 * Field shape is unchanged (`message` only): a transport failure has no upstream
 * status or code to report.
 */
export class BillingUpstreamError extends Schema.TaggedError<BillingUpstreamError>()(
	"@maple/http/errors/BillingUpstreamError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 502 },
) {}

/**
 * Every failure `classifyAutumn` can produce. Endpoints that take caller input
 * declare the whole union; pure reads collapse the 4xx members back into
 * `BillingUpstreamError` at the handler, because on those endpoints an upstream
 * 4xx is our bug and blaming the browser with a 400 would be a lie.
 */
export type AutumnFailure =
	| BillingPaymentRequiredError
	| BillingConflictError
	| BillingRateLimitedError
	| BillingRequestError
	| BillingNotConfiguredError
	| BillingUpstreamError

export class BillingForbiddenError extends Schema.TaggedError<BillingForbiddenError>()(
	"@maple/http/errors/BillingForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

/**
 * Failures reachable on every billing call, whatever it does: Autumn is broken
 * or unreachable (502), or we are not configured to call it (500).
 */
const billingTransportErrors = [BillingUpstreamError, BillingNotConfiguredError] as const

/**
 * The above plus Autumn's classified rejections — declared ONLY on endpoints
 * that carry caller input (a plan id, a set of controls), where an upstream 4xx
 * is genuinely about what the caller asked for. Pure reads deliberately omit
 * these: there, a 4xx means we built a bad request, and answering the browser
 * with a 400 would blame someone who supplied nothing.
 */
const billingRequestErrors = [
	BillingRequestError,
	BillingPaymentRequiredError,
	BillingConflictError,
	BillingRateLimitedError,
	...billingTransportErrors,
] as const

// Authed billing operations: customer/usage reads, native controls, and checkout/portal.
export class BillingApiGroup extends HttpApiGroup.make("billing")
	.add(
		HttpApiEndpoint.get("getCustomer", "/customer", {
			success: BillingCustomer,
			error: [...billingTransportErrors],
		}),
	)
	.add(
		HttpApiEndpoint.get("getUsage", "/usage", {
			query: BillingUsageQuery,
			success: BillingUsage,
			error: [...billingTransportErrors],
		}),
	)
	.add(
		HttpApiEndpoint.get("listInvoices", "/invoices", {
			success: BillingInvoicesResponse,
			error: [...billingTransportErrors],
		}),
	)
	// Warehouse-backed, unlike every other read in this group: Autumn only knows
	// cycle totals, so the daily shape behind the spend chart comes from
	// `service_usage` + `session_replays`.
	.add(
		HttpApiEndpoint.get("getDailySpend", "/daily-spend", {
			success: DailySpendResponse,
			error: [...billingTransportErrors, WarehouseQueryError],
		}),
	)
	.add(
		HttpApiEndpoint.put("updateBillingControls", "/billing-controls", {
			payload: UpdateBillingControlsRequest,
			success: BillingCustomer,
			error: [BillingForbiddenError, ...billingRequestErrors],
		}),
	)
	.add(
		HttpApiEndpoint.post("attach", "/attach", {
			payload: AttachRequest,
			success: AttachResult,
			error: [...billingRequestErrors],
		}),
	)
	.add(
		HttpApiEndpoint.post("previewAttach", "/preview-attach", {
			payload: PreviewAttachRequest,
			success: PreviewAttachResult,
			error: [...billingRequestErrors],
		}),
	)
	.add(
		HttpApiEndpoint.post("openCustomerPortal", "/portal", {
			payload: CustomerPortalRequest,
			success: CustomerPortalResult,
			error: [...billingTransportErrors],
		}),
	)
	.prefix("/internal/billing")
	.middleware(SessionAuthorization) {}

// The plan catalog is global, so `listPlans` stays public — a transient
// onboarding token gap serves the catalog instead of a 401. The handler still
// resolves the tenant optionally to carry per-customer `customerEligibility`.
export class BillingPublicApiGroup extends HttpApiGroup.make("billingPublic")
	.add(
		HttpApiEndpoint.get("listPlans", "/plans", {
			success: CatalogPlansResponse,
			error: [...billingTransportErrors],
		}),
	)
	.prefix("/api/billing") {}
