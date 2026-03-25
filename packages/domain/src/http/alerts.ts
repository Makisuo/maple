import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import type { LogsFilters, MetricsFilters, TracesFilters } from "@maple/query-engine"
import { normalizeKey, parseBoolean, parseWhereClause, splitCsv } from "@maple/query-engine/where-clause"
import {
  AlertDeliveryEventId,
  AlertDestinationId,
  AlertIncidentId,
  AlertRuleId,
  IsoDateTimeString,
  RoleName,
} from "../primitives"
import { Authorization } from "./current-tenant"

export const AlertDestinationType = Schema.Literals([
  "slack",
  "pagerduty",
  "webhook",
]).annotate({
  identifier: "@maple/AlertDestinationType",
  title: "Alert Destination Type",
})
export type AlertDestinationType = Schema.Schema.Type<typeof AlertDestinationType>

export const AlertSeverity = Schema.Literals(["warning", "critical"]).annotate({
  identifier: "@maple/AlertSeverity",
  title: "Alert Severity",
})
export type AlertSeverity = Schema.Schema.Type<typeof AlertSeverity>

export const AlertSignalType = Schema.Literals([
  "error_rate",
  "p95_latency",
  "p99_latency",
  "apdex",
  "throughput",
  "metric",
  "query",
]).annotate({
  identifier: "@maple/AlertSignalType",
  title: "Alert Signal Type",
})
export type AlertSignalType = Schema.Schema.Type<typeof AlertSignalType>

export const AlertQueryDataSource = Schema.Literals(["traces", "logs", "metrics"]).annotate({
  identifier: "@maple/AlertQueryDataSource",
  title: "Alert Query Data Source",
})
export type AlertQueryDataSource = Schema.Schema.Type<typeof AlertQueryDataSource>

export const AlertQueryAggregation = Schema.Literals([
  "count",
  "avg_duration",
  "p50_duration",
  "p95_duration",
  "p99_duration",
  "error_rate",
  "avg",
  "sum",
  "min",
  "max",
]).annotate({
  identifier: "@maple/AlertQueryAggregation",
  title: "Alert Query Aggregation",
})
export type AlertQueryAggregation = Schema.Schema.Type<typeof AlertQueryAggregation>

export const AlertGroupBy = Schema.Literal("service").annotate({
  identifier: "@maple/AlertGroupBy",
  title: "Alert Group By",
})
export type AlertGroupBy = Schema.Schema.Type<typeof AlertGroupBy>

export const AlertComparator = Schema.Literals(["gt", "gte", "lt", "lte"]).annotate({
  identifier: "@maple/AlertComparator",
  title: "Alert Comparator",
})
export type AlertComparator = Schema.Schema.Type<typeof AlertComparator>

export const AlertMetricType = Schema.Literals([
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
]).annotate({
  identifier: "@maple/AlertMetricType",
  title: "Alert Metric Type",
})
export type AlertMetricType = Schema.Schema.Type<typeof AlertMetricType>

export const AlertMetricAggregation = Schema.Literals([
  "avg",
  "min",
  "max",
  "sum",
  "count",
]).annotate({
  identifier: "@maple/AlertMetricAggregation",
  title: "Alert Metric Aggregation",
})
export type AlertMetricAggregation = Schema.Schema.Type<
  typeof AlertMetricAggregation
>

export const AlertIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
  identifier: "@maple/AlertIncidentStatus",
  title: "Alert Incident Status",
})
export type AlertIncidentStatus = Schema.Schema.Type<typeof AlertIncidentStatus>

export const AlertEventType = Schema.Literals([
  "trigger",
  "resolve",
  "renotify",
  "test",
]).annotate({
  identifier: "@maple/AlertEventType",
  title: "Alert Event Type",
})
export type AlertEventType = Schema.Schema.Type<typeof AlertEventType>

export const AlertDeliveryStatus = Schema.Literals([
  "queued",
  "processing",
  "success",
  "failed",
]).annotate({
  identifier: "@maple/AlertDeliveryStatus",
  title: "Alert Delivery Status",
})
export type AlertDeliveryStatus = Schema.Schema.Type<typeof AlertDeliveryStatus>

export const AlertEvaluationStatus = Schema.Literals([
  "breached",
  "healthy",
  "skipped",
]).annotate({
  identifier: "@maple/AlertEvaluationStatus",
  title: "Alert Evaluation Status",
})
export type AlertEvaluationStatus = Schema.Schema.Type<
  typeof AlertEvaluationStatus
>

export type AlertQueryFilterSet =
  | { readonly source: "traces"; readonly filters: TracesFilters | undefined }
  | { readonly source: "logs"; readonly filters: LogsFilters | undefined }
  | { readonly source: "metrics"; readonly filters: MetricsFilters }

const ChannelLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isTrimmed()),
)

const NonEmptyString = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isTrimmed()),
)

const OptionalNonEmptyString = Schema.optionalKey(
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
)

const PositiveInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
)

const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
)

const PositiveFloat = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isGreaterThan(0)),
)

export class SlackAlertDestinationConfig extends Schema.Class<SlackAlertDestinationConfig>(
  "SlackAlertDestinationConfig",
)({
  type: Schema.Literal("slack"),
  name: ChannelLabel,
  webhookUrl: NonEmptyString,
  channelLabel: OptionalNonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class PagerDutyAlertDestinationConfig extends Schema.Class<PagerDutyAlertDestinationConfig>(
  "PagerDutyAlertDestinationConfig",
)({
  type: Schema.Literal("pagerduty"),
  name: ChannelLabel,
  integrationKey: NonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class WebhookAlertDestinationConfig extends Schema.Class<WebhookAlertDestinationConfig>(
  "WebhookAlertDestinationConfig",
)({
  type: Schema.Literal("webhook"),
  name: ChannelLabel,
  url: NonEmptyString,
  signingSecret: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export const AlertDestinationCreateRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("slack"),
    name: ChannelLabel,
    webhookUrl: NonEmptyString,
    channelLabel: OptionalNonEmptyString,
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("pagerduty"),
    name: ChannelLabel,
    integrationKey: NonEmptyString,
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    name: ChannelLabel,
    url: NonEmptyString,
    signingSecret: Schema.optionalKey(Schema.String),
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
])
export type AlertDestinationCreateRequest = Schema.Schema.Type<
  typeof AlertDestinationCreateRequest
>

export class UpdateSlackAlertDestinationConfig extends Schema.Class<UpdateSlackAlertDestinationConfig>(
  "UpdateSlackAlertDestinationConfig",
)({
  name: OptionalNonEmptyString,
  webhookUrl: Schema.optionalKey(Schema.String),
  channelLabel: OptionalNonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdatePagerDutyAlertDestinationConfig extends Schema.Class<UpdatePagerDutyAlertDestinationConfig>(
  "UpdatePagerDutyAlertDestinationConfig",
)({
  name: OptionalNonEmptyString,
  integrationKey: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateWebhookAlertDestinationConfig extends Schema.Class<UpdateWebhookAlertDestinationConfig>(
  "UpdateWebhookAlertDestinationConfig",
)({
  name: OptionalNonEmptyString,
  url: Schema.optionalKey(Schema.String),
  signingSecret: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export const AlertDestinationUpdateRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("slack"),
    ...UpdateSlackAlertDestinationConfig.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("pagerduty"),
    ...UpdatePagerDutyAlertDestinationConfig.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    ...UpdateWebhookAlertDestinationConfig.fields,
  }),
])
export type AlertDestinationUpdateRequest = Schema.Schema.Type<
  typeof AlertDestinationUpdateRequest
>

export class AlertDestinationDocument extends Schema.Class<AlertDestinationDocument>(
  "AlertDestinationDocument",
)({
  id: AlertDestinationId,
  name: Schema.String,
  type: AlertDestinationType,
  enabled: Schema.Boolean,
  summary: Schema.String,
  channelLabel: Schema.NullOr(Schema.String),
  lastTestedAt: Schema.NullOr(IsoDateTimeString),
  lastTestError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
}) {}

export class AlertDestinationDeleteResponse extends Schema.Class<AlertDestinationDeleteResponse>(
  "AlertDestinationDeleteResponse",
)({
  id: AlertDestinationId,
}) {}

export class AlertDestinationsListResponse extends Schema.Class<AlertDestinationsListResponse>(
  "AlertDestinationsListResponse",
)({
  destinations: Schema.Array(AlertDestinationDocument),
}) {}

export class AlertRuleDocument extends Schema.Class<AlertRuleDocument>("AlertRuleDocument")({
  id: AlertRuleId,
  name: Schema.String,
  enabled: Schema.Boolean,
  severity: AlertSeverity,
  serviceName: Schema.NullOr(Schema.String),
  serviceNames: Schema.Array(Schema.String),
  groupBy: Schema.NullOr(AlertGroupBy),
  signalType: AlertSignalType,
  comparator: AlertComparator,
  threshold: Schema.Number,
  windowMinutes: PositiveInt,
  minimumSampleCount: NonNegativeInt,
  consecutiveBreachesRequired: PositiveInt,
  consecutiveHealthyRequired: PositiveInt,
  renotifyIntervalMinutes: PositiveInt,
  metricName: Schema.NullOr(Schema.String),
  metricType: Schema.NullOr(AlertMetricType),
  metricAggregation: Schema.NullOr(AlertMetricAggregation),
  apdexThresholdMs: Schema.NullOr(PositiveFloat),
  queryDataSource: Schema.NullOr(AlertQueryDataSource),
  queryAggregation: Schema.NullOr(AlertQueryAggregation),
  queryWhereClause: Schema.NullOr(Schema.String),
  destinationIds: Schema.Array(AlertDestinationId),
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
  createdBy: Schema.String,
  updatedBy: Schema.String,
}) {}

export class AlertRuleUpsertRequest extends Schema.Class<AlertRuleUpsertRequest>(
  "AlertRuleUpsertRequest",
)({
  name: ChannelLabel,
  enabled: Schema.optionalKey(Schema.Boolean),
  severity: AlertSeverity,
  serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  serviceNames: Schema.optionalKey(Schema.Array(Schema.String)),
  groupBy: Schema.optionalKey(Schema.NullOr(AlertGroupBy)),
  signalType: AlertSignalType,
  comparator: AlertComparator,
  threshold: Schema.Number,
  windowMinutes: PositiveInt,
  minimumSampleCount: Schema.optionalKey(NonNegativeInt),
  consecutiveBreachesRequired: Schema.optionalKey(PositiveInt),
  consecutiveHealthyRequired: Schema.optionalKey(PositiveInt),
  renotifyIntervalMinutes: Schema.optionalKey(PositiveInt),
  metricName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  metricType: Schema.optionalKey(Schema.NullOr(AlertMetricType)),
  metricAggregation: Schema.optionalKey(Schema.NullOr(AlertMetricAggregation)),
  apdexThresholdMs: Schema.optionalKey(Schema.NullOr(PositiveFloat)),
  queryDataSource: Schema.optionalKey(Schema.NullOr(AlertQueryDataSource)),
  queryAggregation: Schema.optionalKey(Schema.NullOr(AlertQueryAggregation)),
  queryWhereClause: Schema.optionalKey(Schema.NullOr(Schema.String)),
  destinationIds: Schema.Array(AlertDestinationId),
}) {}

export class AlertRulesListResponse extends Schema.Class<AlertRulesListResponse>(
  "AlertRulesListResponse",
)({
  rules: Schema.Array(AlertRuleDocument),
}) {}

export class AlertRuleDeleteResponse extends Schema.Class<AlertRuleDeleteResponse>(
  "AlertRuleDeleteResponse",
)({
  id: AlertRuleId,
}) {}

export class AlertRuleTestRequest extends Schema.Class<AlertRuleTestRequest>(
  "AlertRuleTestRequest",
)({
  rule: AlertRuleUpsertRequest,
  sendNotification: Schema.optionalKey(Schema.Boolean),
}) {}

export class AlertEvaluationResult extends Schema.Class<AlertEvaluationResult>(
  "AlertEvaluationResult",
)({
  status: AlertEvaluationStatus,
  value: Schema.NullOr(Schema.Number),
  sampleCount: Schema.Number,
  threshold: Schema.Number,
  comparator: AlertComparator,
  reason: Schema.String,
}) {}

export class AlertIncidentDocument extends Schema.Class<AlertIncidentDocument>(
  "AlertIncidentDocument",
)({
  id: AlertIncidentId,
  ruleId: AlertRuleId,
  ruleName: Schema.String,
  serviceName: Schema.NullOr(Schema.String),
  signalType: AlertSignalType,
  severity: AlertSeverity,
  status: AlertIncidentStatus,
  comparator: AlertComparator,
  threshold: Schema.Number,
  firstTriggeredAt: IsoDateTimeString,
  lastTriggeredAt: IsoDateTimeString,
  resolvedAt: Schema.NullOr(IsoDateTimeString),
  lastObservedValue: Schema.NullOr(Schema.Number),
  lastSampleCount: Schema.NullOr(Schema.Number),
  dedupeKey: Schema.String,
  lastDeliveredEventType: Schema.NullOr(AlertEventType),
  lastNotifiedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class AlertIncidentsListResponse extends Schema.Class<AlertIncidentsListResponse>(
  "AlertIncidentsListResponse",
)({
  incidents: Schema.Array(AlertIncidentDocument),
}) {}

export class AlertDeliveryEventDocument extends Schema.Class<AlertDeliveryEventDocument>(
  "AlertDeliveryEventDocument",
)({
  id: AlertDeliveryEventId,
  incidentId: Schema.NullOr(AlertIncidentId),
  ruleId: AlertRuleId,
  destinationId: AlertDestinationId,
  destinationName: Schema.String,
  destinationType: AlertDestinationType,
  deliveryKey: Schema.String,
  eventType: AlertEventType,
  attemptNumber: PositiveInt,
  status: AlertDeliveryStatus,
  scheduledAt: IsoDateTimeString,
  attemptedAt: Schema.NullOr(IsoDateTimeString),
  providerMessage: Schema.NullOr(Schema.String),
  providerReference: Schema.NullOr(Schema.String),
  responseCode: Schema.NullOr(Schema.Number),
  errorMessage: Schema.NullOr(Schema.String),
}) {}

export class AlertDeliveryEventsListResponse extends Schema.Class<AlertDeliveryEventsListResponse>(
  "AlertDeliveryEventsListResponse",
)({
  events: Schema.Array(AlertDeliveryEventDocument),
}) {}

export class AlertDestinationTestResponse extends Schema.Class<AlertDestinationTestResponse>(
  "AlertDestinationTestResponse",
)({
  success: Schema.Boolean,
  message: Schema.String,
}) {}

export class AlertForbiddenError extends Schema.TaggedErrorClass<AlertForbiddenError>()(
  "AlertForbiddenError",
  {
    message: Schema.String,
    roles: Schema.optionalKey(Schema.Array(RoleName)),
  },
  { httpApiStatus: 403 },
) {}

export class AlertValidationError extends Schema.TaggedErrorClass<AlertValidationError>()(
  "AlertValidationError",
  {
    message: Schema.String,
    details: Schema.Array(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class AlertPersistenceError extends Schema.TaggedErrorClass<AlertPersistenceError>()(
  "AlertPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class AlertNotFoundError extends Schema.TaggedErrorClass<AlertNotFoundError>()(
  "AlertNotFoundError",
  {
    message: Schema.String,
    resourceType: Schema.String,
    resourceId: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class AlertDeliveryError extends Schema.TaggedErrorClass<AlertDeliveryError>()(
  "AlertDeliveryError",
  {
    message: Schema.String,
    destinationType: Schema.optionalKey(AlertDestinationType),
  },
  { httpApiStatus: 502 },
) {}

export class AlertDestinationInUseError extends Schema.TaggedErrorClass<AlertDestinationInUseError>()(
  "AlertDestinationInUseError",
  {
    message: Schema.String,
    destinationId: AlertDestinationId,
    ruleIds: Schema.Array(AlertRuleId),
    ruleNames: Schema.Array(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export function buildAlertQueryFilterSet(params: {
  readonly queryDataSource: AlertQueryDataSource
  readonly serviceName: string | null
  readonly metricName: string | null
  readonly metricType: AlertMetricType | null
  readonly queryWhereClause: string | null | undefined
}): AlertQueryFilterSet | null {
  const { clauses } = parseWhereClause(params.queryWhereClause ?? "")

  if (params.queryDataSource === "traces") {
    const filters: Record<string, unknown> = params.serviceName == null
      ? {}
      : { serviceName: params.serviceName }

    for (const clause of clauses) {
      const key = normalizeKey(clause.key)

      if (key.startsWith("attr.")) {
        if (filters.attributeKey == null) {
          filters.attributeKey = key.slice(5)
          if (clause.operator === "exists") {
            filters.attributeFilterMode = "exists"
          } else {
            filters.attributeValue = clause.value
          }
        }
        continue
      }

      if (key.startsWith("resource.")) {
        if (filters.resourceAttributeKey == null) {
          filters.resourceAttributeKey = key.slice(9)
          if (clause.operator === "exists") {
            filters.resourceAttributeFilterMode = "exists"
          } else {
            filters.resourceAttributeValue = clause.value
          }
        }
        continue
      }

      switch (key) {
        case "service.name":
          filters.serviceName = clause.value
          break
        case "span.name":
          filters.spanName = clause.value
          break
        case "deployment.environment":
          filters.environments = splitCsv(clause.value)
          break
        case "deployment.commit_sha":
          filters.commitShas = splitCsv(clause.value)
          break
        case "root_only": {
          const boolValue = parseBoolean(clause.value)
          if (boolValue != null) {
            filters.rootSpansOnly = boolValue
          }
          break
        }
        case "has_error": {
          const boolValue = parseBoolean(clause.value)
          if (boolValue != null) {
            filters.errorsOnly = boolValue
          }
          break
        }
      }
    }

    return {
      source: "traces",
      filters: Object.keys(filters).length > 0 ? filters as TracesFilters : undefined,
    }
  }

  if (params.queryDataSource === "logs") {
    const filters: Record<string, unknown> = params.serviceName == null
      ? {}
      : { serviceName: params.serviceName }

    for (const clause of clauses) {
      const key = normalizeKey(clause.key)
      if (key === "service.name") filters.serviceName = clause.value
      else if (key === "severity") filters.severity = clause.value
    }

    return {
      source: "logs",
      filters: Object.keys(filters).length > 0 ? filters as LogsFilters : undefined,
    }
  }

  if (params.metricName == null || params.metricType == null) {
    return null
  }

  const filters: Record<string, unknown> = {
    metricName: params.metricName,
    metricType: params.metricType,
  }

  if (params.serviceName != null) {
    filters.serviceName = params.serviceName
  }

  for (const clause of clauses) {
    const key = normalizeKey(clause.key)
    if (key === "service.name") {
      filters.serviceName = clause.value
    }
  }

  return {
    source: "metrics",
    filters: filters as MetricsFilters,
  }
}

export class AlertsApiGroup extends HttpApiGroup.make("alerts")
  .add(
    HttpApiEndpoint.get("listDestinations", "/destinations", {
      success: AlertDestinationsListResponse,
      error: AlertPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.post("createDestination", "/destinations", {
      payload: AlertDestinationCreateRequest,
      success: AlertDestinationDocument,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateDestination", "/destinations/:destinationId", {
      params: {
        destinationId: AlertDestinationId,
      },
      payload: AlertDestinationUpdateRequest,
      success: AlertDestinationDocument,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
        AlertNotFoundError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteDestination", "/destinations/:destinationId", {
      params: {
        destinationId: AlertDestinationId,
      },
      success: AlertDestinationDeleteResponse,
      error: [
        AlertForbiddenError,
        AlertPersistenceError,
        AlertNotFoundError,
        AlertDestinationInUseError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("testDestination", "/destinations/:destinationId/test", {
      params: {
        destinationId: AlertDestinationId,
      },
      success: AlertDestinationTestResponse,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
        AlertNotFoundError,
        AlertDeliveryError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listRules", "/rules", {
      success: AlertRulesListResponse,
      error: AlertPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.post("createRule", "/rules", {
      payload: AlertRuleUpsertRequest,
      success: AlertRuleDocument,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
        AlertNotFoundError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateRule", "/rules/:ruleId", {
      params: {
        ruleId: AlertRuleId,
      },
      payload: AlertRuleUpsertRequest,
      success: AlertRuleDocument,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
        AlertNotFoundError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteRule", "/rules/:ruleId", {
      params: {
        ruleId: AlertRuleId,
      },
      success: AlertRuleDeleteResponse,
      error: [AlertForbiddenError, AlertPersistenceError, AlertNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.post("testRule", "/rules/test", {
      payload: AlertRuleTestRequest,
      success: AlertEvaluationResult,
      error: [
        AlertForbiddenError,
        AlertValidationError,
        AlertPersistenceError,
        AlertNotFoundError,
        AlertDeliveryError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listIncidents", "/incidents", {
      success: AlertIncidentsListResponse,
      error: AlertPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.get("listDeliveryEvents", "/delivery-events", {
      success: AlertDeliveryEventsListResponse,
      error: AlertPersistenceError,
    }),
  )
  .prefix("/api/alerts")
  .middleware(Authorization) {}
