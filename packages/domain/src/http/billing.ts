import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Schema } from "effect"
import { TAX_ID_TYPE_VALUES } from "../billing-tax-ids"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
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

export const BillingFeatureId = Schema.Literals([
	"logs",
	"traces",
	"metrics",
	"browser_sessions",
	"product_events",
])
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
	// Keyed by Autumn featureId (logs/traces/metrics/browser_sessions/product_events).
	total: Schema.optionalKey(Schema.Record(Schema.String, BillingUsageFeature)),
}) {}

// The window is the subscription's current period, resolved server-side: Autumn's
// own "1bc" range is a rolling cycle-length ending now, not "since the reset".
const BillingUsageQuery = Schema.Struct({
	featureId: Schema.Array(Schema.String),
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
	/** Product events (browser `track()` + server events) metered that day. Absent until the API emits it. */
	productEvents: Schema.optionalKey(Schema.Number),
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
	// Where Stripe sends the buyer after checkout. The web passes its own page
	// URL with a `checkout=complete` marker so the return can wait for the
	// Stripe→Autumn sync instead of re-showing the "Start trial" button.
	successUrl: Schema.optionalKey(Schema.String),
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

// ---------------------------------------------------------------------------
// Billing details (company name, address, tax IDs).
//
// Autumn has no tax-ID or address concept; these live on the Stripe customer
// Autumn links (`stripe_id`), and the API reads/writes them through Stripe
// directly. Nothing here is persisted by Maple — Stripe is the source of truth
// and is what prints them on the invoice PDF.
// ---------------------------------------------------------------------------

/** Stripe tax-ID `type` values (see `@maple/domain/billing-tax-ids`). */
export const BillingTaxIdType = Schema.Literals(TAX_ID_TYPE_VALUES)
export type BillingTaxIdType = typeof BillingTaxIdType.Type

/** Postal address as Stripe stores it; every line is optional on the wire. */
export class BillingAddress extends Schema.Class<BillingAddress>("BillingAddress")({
	line1: Schema.optionalKey(Schema.NullOr(Schema.String)),
	line2: Schema.optionalKey(Schema.NullOr(Schema.String)),
	city: Schema.optionalKey(Schema.NullOr(Schema.String)),
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	postalCode: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** ISO-3166 alpha-2. */
	country: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

/**
 * One tax ID on the Stripe customer. `type` and `verificationStatus` stay plain
 * strings (not the literal unions) so a value Stripe adds later can't fail the
 * decode — same posture as `BillingInvoice.status`. Known statuses:
 * `pending` | `verified` | `unverified` | `unavailable`.
 */
export class BillingTaxId extends Schema.Class<BillingTaxId>("BillingTaxId")({
	id: Schema.String,
	type: Schema.String,
	value: Schema.String,
	country: Schema.optionalKey(Schema.NullOr(Schema.String)),
	verificationStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
}) {}

/**
 * What the billing-details card renders. `linked: false` means the org has no
 * Stripe customer yet (Autumn creates it lazily on the first billing operation)
 * — a read never forces one into existence, so the rest is empty; the first
 * write creates it.
 */
export class BillingProfile extends Schema.Class<BillingProfile>("BillingProfile")({
	linked: Schema.Boolean,
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	address: Schema.optionalKey(Schema.NullOr(BillingAddress)),
	taxIds: Schema.Array(BillingTaxId),
}) {}

const TrimmedName = Schema.String.pipe(Schema.check(Schema.isMaxLength(150)))

export class UpdateBillingProfileRequest extends Schema.Class<UpdateBillingProfileRequest>(
	"UpdateBillingProfileRequest",
)({
	/** Legal / company name as it should print on invoices. `null` clears it. */
	name: Schema.optionalKey(Schema.NullOr(TrimmedName)),
	/** `null` clears the address. Omitted fields are left as they are. */
	address: Schema.optionalKey(Schema.NullOr(BillingAddress)),
}) {}

export class AddBillingTaxIdRequest extends Schema.Class<AddBillingTaxIdRequest>("AddBillingTaxIdRequest")({
	type: BillingTaxIdType,
	value: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
}) {}

/**
 * Context every classified Autumn rejection carries.
 *
 * `code` is Autumn's own error identifier, passed through VERBATIM as a plain
 * string. It is deliberately not a `Schema.Literals` union: Autumn owns that
 * vocabulary and can add to it at any time, and an exhaustive union here would
 * turn a new upstream code into a decode failure — trading a legible 4xx for an
 * opaque 500. The transport parses it out at `errorResponse`
 * (`apps/api/src/services/billing/autumn-http.ts`), defaulting to
 * `"autumn_api_error"` when the body carries none.
 *
 * Note this is the UPSTREAM code, distinct from the public `code` each error
 * publishes in its policy below — that one is ours and is stable.
 */
const autumnFailureFields = {
	message: Schema.String,
	code: Schema.String,
	/** The status Autumn itself answered with, before we mapped it. */
	upstreamStatus: Schema.Number,
}

/**
 * Autumn refused the charge — a declined card, an expired payment method, a
 * missing one. `exposure: "public_message"` because Autumn's own wording IS the
 * decline reason, and it is the only place that detail exists; substituting our
 * own copy would tell the customer less than we know.
 */
export class BillingPaymentRequiredError extends HttpTaggedError<BillingPaymentRequiredError>()(
	"@maple/http/errors/BillingPaymentRequiredError",
	autumnFailureFields,
	{
		status: 402,
		code: "billing_payment_required",
		title: "Payment method declined",
		retry: "never",
		// The customer fixes this in the billing portal, not by retrying.
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/**
 * The request conflicts with the customer's current state — most often a repeat
 * `attach` for a plan they already hold, which is what a double-click produces.
 * The attach handler resolves that case into a success, so reaching here means a
 * conflict we could not explain. Redacted: Autumn's phrasing describes its own
 * data model, and telling someone to retry a conflict is the advice that made
 * this whole class of bug user-visible.
 */
export class BillingConflictError extends HttpTaggedError<BillingConflictError>()(
	"@maple/http/errors/BillingConflictError",
	autumnFailureFields,
	{
		status: 409,
		code: "billing_conflict",
		title: "Subscription already changed",
		message: "That plan change conflicts with your current subscription. Refresh to see where you stand.",
		retry: "never",
		recovery: "refresh",
		exposure: "redacted",
	},
) {}

/** Autumn is throttling us. Retryable as-is, unlike every other 4xx here. */
export class BillingRateLimitedError extends HttpTaggedError<BillingRateLimitedError>()(
	"@maple/http/errors/BillingRateLimitedError",
	autumnFailureFields,
	{
		status: 429,
		code: "billing_rate_limited",
		title: "Billing is busy",
		message: "Billing is busy right now. Give it a moment and try again.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/**
 * Autumn rejected the request itself — an unknown plan id, a malformed control.
 * Only raised on endpoints that take caller input; on a pure read an upstream
 * 4xx means WE built a bad request, which is a Maple bug and stays a 502.
 */
export class BillingRequestError extends HttpTaggedError<BillingRequestError>()(
	"@maple/http/errors/BillingRequestError",
	autumnFailureFields,
	{
		status: 400,
		code: "billing_request_invalid",
		title: "Billing request rejected",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/**
 * Our credentials are missing or were rejected — an unset `AUTUMN_SECRET_KEY`,
 * or a key that was revoked or rotated. A deployment fault, not an upstream one,
 * and never the caller's: it previously surfaced as a 502, which pointed every
 * investigation at a service that was working fine.
 */
export class BillingNotConfiguredError extends HttpTaggedError<BillingNotConfiguredError>()(
	"@maple/http/errors/BillingNotConfiguredError",
	{ message: Schema.String },
	{
		status: 500,
		code: "billing_not_configured",
		title: "Billing is unavailable",
		message: "Billing is unavailable right now. This is on us — please contact support if it persists.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/**
 * Autumn is broken or unreachable: a 5xx, a transport failure, an empty 2xx, or
 * a body we could not decode. Deliberately NOT used for upstream 4xx on
 * caller-input endpoints — those are the classified errors above.
 *
 * Field shape is unchanged (`message` only): a transport failure has no upstream
 * status or code to report. Redacted because that message quotes a dependency,
 * which must never reach a public 5xx (see docs/api-v2.md).
 */
export class BillingUpstreamError extends HttpTaggedError<BillingUpstreamError>()(
	"@maple/http/errors/BillingUpstreamError",
	{
		message: Schema.String,
	},
	{
		status: 502,
		code: "billing_upstream_unavailable",
		title: "Billing is temporarily unavailable",
		message: "Maple could not reach billing. Try again in a moment.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class BillingForbiddenError extends HttpTaggedError<BillingForbiddenError>()(
	"@maple/http/errors/BillingForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "billing_forbidden",
		title: "Permission required",
		message: "Only org admins can manage billing.",
		retry: "never",
		recovery: "request_access",
		exposure: "redacted",
	},
) {}

/**
 * The org has no Stripe customer yet and one could not be created on demand,
 * so there is nowhere to put billing details. Autumn creates the Stripe
 * customer lazily — normally on the first checkout — and `create_in_stripe` on
 * the write path covers the rest; reaching here means even that came back
 * unlinked. Nothing about the request is wrong, hence `recovery: "none"`.
 */
export class BillingProfileUnavailableError extends HttpTaggedError<BillingProfileUnavailableError>()(
	"@maple/http/errors/BillingProfileUnavailableError",
	{ message: Schema.String },
	{
		status: 409,
		code: "billing_profile_unavailable",
		title: "Billing details unavailable",
		message: "Billing details become available once your organization has a plan or payment method.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
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
			error: [BillingForbiddenError, ...billingRequestErrors],
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
			error: [BillingForbiddenError, ...billingTransportErrors],
		}),
	)
	// Billing details live on the Stripe customer, read through Stripe directly.
	// The read is not admin-gated (members may see what the invoice will say)
	// and never creates the Stripe customer; the writes do both.
	.add(
		HttpApiEndpoint.get("getBillingProfile", "/profile", {
			success: BillingProfile,
			error: [...billingTransportErrors],
		}),
	)
	.add(
		HttpApiEndpoint.put("updateBillingProfile", "/profile", {
			payload: UpdateBillingProfileRequest,
			success: BillingProfile,
			error: [BillingForbiddenError, BillingProfileUnavailableError, ...billingRequestErrors],
		}),
	)
	.add(
		HttpApiEndpoint.post("addBillingTaxId", "/profile/tax-ids", {
			payload: AddBillingTaxIdRequest,
			success: BillingProfile,
			error: [BillingForbiddenError, BillingProfileUnavailableError, ...billingRequestErrors],
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeBillingTaxId", "/profile/tax-ids/:taxIdId", {
			params: { taxIdId: Schema.String },
			success: BillingProfile,
			error: [BillingForbiddenError, BillingProfileUnavailableError, ...billingRequestErrors],
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
