import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

// ── Errors ──────────────────────────────────────────────────────────────

export class BillingError extends Schema.TaggedErrorClass<BillingError>()(
  "BillingError",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class BillingNotConfiguredError extends Schema.TaggedErrorClass<BillingNotConfiguredError>()(
  "BillingNotConfiguredError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

// ── Nested schemas ──────────────────────────────────────────────────────

export class BillingPlanPrice extends Schema.Class<BillingPlanPrice>("BillingPlanPrice")({
  amount: Schema.Number,
  interval: Schema.String,
}) {}

export class BillingPlanItem extends Schema.Class<BillingPlanItem>("BillingPlanItem")({
  featureId: Schema.String,
  unlimited: Schema.Boolean,
  included: Schema.NullOr(Schema.Number),
  feature: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
  display: Schema.optional(Schema.NullOr(Schema.Struct({ secondaryText: Schema.optional(Schema.String) }))),
}) {}

export class BillingFreeTrial extends Schema.Class<BillingFreeTrial>("BillingFreeTrial")({
  durationLength: Schema.Number,
}) {}

export class BillingCustomerEligibility extends Schema.Class<BillingCustomerEligibility>("BillingCustomerEligibility")({
  status: Schema.NullOr(Schema.String),
  attachAction: Schema.NullOr(Schema.String),
  trialAvailable: Schema.Boolean,
}) {}

export class BillingPlanResponse extends Schema.Class<BillingPlanResponse>("BillingPlanResponse")({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  group: Schema.NullOr(Schema.String),
  version: Schema.Number,
  addOn: Schema.Boolean,
  autoEnable: Schema.Boolean,
  price: Schema.NullOr(BillingPlanPrice),
  items: Schema.Array(BillingPlanItem),
  freeTrial: Schema.optional(BillingFreeTrial),
  createdAt: Schema.Number,
  env: Schema.String,
  archived: Schema.Boolean,
  baseVariantId: Schema.NullOr(Schema.String),
  customerEligibility: Schema.optional(BillingCustomerEligibility),
}) {}

export class BillingSubscription extends Schema.Class<BillingSubscription>("BillingSubscription")({
  id: Schema.String,
  planId: Schema.String,
  plan: Schema.NullOr(BillingPlanResponse),
  autoEnable: Schema.Boolean,
  addOn: Schema.Boolean,
  status: Schema.String,
  pastDue: Schema.Boolean,
  canceledAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  trialEndsAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
  currentPeriodStart: Schema.NullOr(Schema.Number),
  currentPeriodEnd: Schema.NullOr(Schema.Number),
  quantity: Schema.Number,
}) {}

export class BillingBalance extends Schema.Class<BillingBalance>("BillingBalance")({
  featureId: Schema.String,
  granted: Schema.Number,
  remaining: Schema.Number,
  usage: Schema.Number,
  unlimited: Schema.Boolean,
}) {}

export class BillingFlag extends Schema.Class<BillingFlag>("BillingFlag")({
  id: Schema.String,
  planId: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  featureId: Schema.String,
}) {}

// ── Response schemas ────────────────────────────────────────────────────

export class BillingCustomerResponse extends Schema.Class<BillingCustomerResponse>("BillingCustomerResponse")({
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  fingerprint: Schema.NullOr(Schema.String),
  stripeId: Schema.NullOr(Schema.String),
  env: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  sendEmailReceipts: Schema.Boolean,
  billingControls: Schema.Record(Schema.String, Schema.Unknown),
  subscriptions: Schema.Array(BillingSubscription),
  purchases: Schema.Array(Schema.Unknown),
  balances: Schema.Record(Schema.String, BillingBalance),
  flags: Schema.Record(Schema.String, BillingFlag),
}) {}

export class BillingPlansListResponse extends Schema.Class<BillingPlansListResponse>("BillingPlansListResponse")({
  plans: Schema.Array(BillingPlanResponse),
}) {}

export class BillingAttachResponse extends Schema.Class<BillingAttachResponse>("BillingAttachResponse")({
  customerId: Schema.String,
  paymentUrl: Schema.NullOr(Schema.String),
}) {}

export class BillingPreviewLineItem extends Schema.Class<BillingPreviewLineItem>("BillingPreviewLineItem")({
  description: Schema.String,
  total: Schema.Number,
}) {}

export class BillingPreviewNextCycle extends Schema.Class<BillingPreviewNextCycle>("BillingPreviewNextCycle")({
  startsAt: Schema.Number,
  total: Schema.Number,
}) {}

export class BillingPreviewAttachResponse extends Schema.Class<BillingPreviewAttachResponse>("BillingPreviewAttachResponse")({
  lineItems: Schema.Array(BillingPreviewLineItem),
  total: Schema.Number,
  currency: Schema.String,
  nextCycle: Schema.optional(BillingPreviewNextCycle),
}) {}

export class BillingEventTotal extends Schema.Class<BillingEventTotal>("BillingEventTotal")({
  count: Schema.Number,
  sum: Schema.Number,
}) {}

export class BillingAggregateEventsResponse extends Schema.Class<BillingAggregateEventsResponse>("BillingAggregateEventsResponse")({
  total: Schema.Record(Schema.String, BillingEventTotal),
}) {}

export class BillingCustomerPortalResponse extends Schema.Class<BillingCustomerPortalResponse>("BillingCustomerPortalResponse")({
  url: Schema.String,
}) {}

// ── Request schemas ─────────────────────────────────────────────────────

export class BillingAttachRequest extends Schema.Class<BillingAttachRequest>("BillingAttachRequest")({
  planId: Schema.String,
}) {}

export class BillingAggregateEventsRequest extends Schema.Class<BillingAggregateEventsRequest>("BillingAggregateEventsRequest")({
  featureId: Schema.Array(Schema.String),
  range: Schema.String,
}) {}

export class BillingCustomerPortalRequest extends Schema.Class<BillingCustomerPortalRequest>("BillingCustomerPortalRequest")({
  returnUrl: Schema.String,
}) {}

// ── API Group ───────────────────────────────────────────────────────────

export class BillingApiGroup extends HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.post("getCustomer", "/customer", {
      success: BillingCustomerResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .add(
    HttpApiEndpoint.post("listPlans", "/plans", {
      success: BillingPlansListResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .add(
    HttpApiEndpoint.post("attach", "/attach", {
      payload: BillingAttachRequest,
      success: BillingAttachResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .add(
    HttpApiEndpoint.post("previewAttach", "/preview-attach", {
      payload: BillingAttachRequest,
      success: BillingPreviewAttachResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .add(
    HttpApiEndpoint.post("aggregateEvents", "/aggregate-events", {
      payload: BillingAggregateEventsRequest,
      success: BillingAggregateEventsResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .add(
    HttpApiEndpoint.post("openCustomerPortal", "/customer-portal", {
      payload: BillingCustomerPortalRequest,
      success: BillingCustomerPortalResponse,
      error: [BillingError, BillingNotConfiguredError],
    }),
  )
  .prefix("/api/billing")
  .middleware(Authorization) {}
