import { randomUUID } from "node:crypto"
import {
  CompiledAlertQueryPlan,
  type QueryEngineNoDataBehavior,
  type QueryEngineSampleCountStrategy,
  QuerySpec,
} from "@maple/query-engine"
import { resolveGroupBy } from "@maple/query-engine/query-builder"
import {
  buildAlertQueryFilterSet,
  AlertComparator as AlertComparatorSchema,
  AlertDeliveryError,
  AlertDeliveryEventDocument,
  AlertDeliveryEventsListResponse,
  AlertDeliveryStatus,
  AlertDestinationDeleteResponse,
  AlertDestinationDocument,
  AlertDestinationInUseError,
  AlertDestinationTestResponse,
  AlertDestinationsListResponse,
  AlertEvaluationResult,
  AlertEventType as AlertEventTypeSchema,
  AlertForbiddenError,
  AlertGroupBy as AlertGroupBySchema,
  AlertIncidentDocument,
  AlertIncidentsListResponse,
  AlertIncidentStatus,
  AlertMetricAggregation as AlertMetricAggregationSchema,
  AlertMetricType as AlertMetricTypeSchema,
  AlertNotFoundError,
  AlertPersistenceError,
  AlertQueryAggregation as AlertQueryAggregationSchema,
  AlertQueryDataSource as AlertQueryDataSourceSchema,
  AlertRuleDeleteResponse,
  AlertRuleDocument,
  AlertRulesListResponse,
  AlertSeverity as AlertSeveritySchema,
  AlertSignalType as AlertSignalTypeSchema,
  AlertValidationError,
  type AlertComparator,
  AlertDestinationType as AlertDestinationTypeSchema,
  type AlertDestinationCreateRequest,
  type AlertDestinationType,
  type AlertDestinationUpdateRequest,
  type AlertEventType as AlertEventTypeValue,
  type AlertMetricAggregation as AlertMetricAggregationValue,
  type AlertMetricType,
  type AlertQueryAggregation,
  type AlertQueryDataSource,
  type AlertRuleUpsertRequest,
  type AlertSeverity,
  type AlertSignalType,
  type AlertGroupBy,
  type OrgId,
  type AlertRuleId,
  type AlertDestinationId,
  type AlertIncidentId,
  QueryEngineExecutionError,
  QueryEngineTimeoutError,
  QueryEngineValidationError,
  RoleName,
  UserId as UserIdSchema,
  type UserId,
} from "@maple/domain/http"
import {
  alertDeliveryEvents,
  type AlertDeliveryEventRow,
  alertDestinations,
  type AlertDestinationRow,
  alertIncidents,
  type AlertIncidentRow,
  alertRules,
  type AlertRuleRow,
  alertRuleStates,
} from "@maple/db"
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm"
import {
  Array as Arr,
  Effect,
  HashSet,
  Layer,
  Match,
  Metric,
  Option,
  Redacted,
  Schema,
  Context,
} from "effect"
import * as AlertingMetrics from "./AlertingMetrics"
import type { TenantContext } from "./AuthService"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
  type EncryptedValue,
} from "./Crypto"
import { Database, type DatabaseClient } from "./DatabaseLive"
import {
  dispatchDelivery as dispatchDeliveryImpl,
  formatComparator,
  formatSignalLabel,
  formatEventTypeLabel,
  formatSignalMetric,
} from "./AlertDeliveryDispatch"
import { Env } from "./Env"
import { QueryEngineService, type GroupedAlertObservation } from "./QueryEngineService"


interface DestinationPublicConfig {
  readonly summary: string
  readonly channelLabel: string | null
}

type DestinationSecretConfig =
  | { readonly type: "slack"; readonly webhookUrl: string }
  | { readonly type: "pagerduty"; readonly integrationKey: string }
  | {
      readonly type: "webhook"
      readonly url: string
      readonly signingSecret: string | null
    }

interface NormalizedRule {
  readonly id: AlertRuleId
  readonly name: string
  readonly enabled: boolean
  readonly severity: AlertSeverity
  readonly serviceName: string | null
  readonly serviceNames: ReadonlyArray<string>
  readonly excludeServiceNames: ReadonlyArray<string>
  readonly groupBy: AlertGroupBy | null
  readonly signalType: AlertSignalType
  readonly comparator: AlertComparator
  readonly threshold: number
  readonly windowMinutes: number
  readonly minimumSampleCount: number
  readonly consecutiveBreachesRequired: number
  readonly consecutiveHealthyRequired: number
  readonly renotifyIntervalMinutes: number
  readonly metricName: string | null
  readonly metricType: AlertMetricType | null
  readonly metricAggregation: AlertMetricAggregationValue | null
  readonly apdexThresholdMs: number | null
  readonly queryDataSource: string | null
  readonly queryAggregation: string | null
  readonly queryWhereClause: string | null
  readonly destinationIds: ReadonlyArray<AlertDestinationId>
  readonly compiledPlan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>
  readonly createdAt: number
  readonly updatedAt: number
}

interface EvaluatedRule {
  readonly status: Schema.Schema.Type<typeof AlertEvaluationResult.fields.status>
  readonly value: number | null
  readonly sampleCount: number
  readonly threshold: number
  readonly comparator: AlertComparator
  readonly reason: string
}

interface DispatchContext {
  readonly deliveryKey: string
  readonly destination: AlertDestinationRow
  readonly publicConfig: DestinationPublicConfig
  readonly secretConfig: DestinationSecretConfig
  readonly ruleId: AlertRuleId
  readonly ruleName: string
  readonly groupKey: string | null
  readonly signalType: AlertSignalType
  readonly severity: AlertSeverity
  readonly comparator: AlertComparator
  readonly threshold: number
  readonly eventType: AlertEventTypeValue
  readonly incidentId: AlertIncidentId | null
  readonly incidentStatus: Schema.Schema.Type<typeof AlertIncidentStatus>
  readonly dedupeKey: string
  readonly windowMinutes: number
  readonly value: number | null
  readonly sampleCount: number | null
  readonly linkUrl: string
}

interface DispatchResult {
  readonly providerMessage: string | null
  readonly providerReference: string | null
  readonly responseCode: number | null
}

interface DeliveryPayloadContext {
  readonly eventType: AlertEventTypeValue
  readonly incidentId: AlertIncidentId | null
  readonly incidentStatus: Schema.Schema.Type<typeof AlertIncidentStatus>
  readonly dedupeKey: string
  readonly ruleId: AlertRuleId
  readonly ruleName: string
  readonly groupKey: string | null
  readonly signalType: AlertSignalType
  readonly severity: AlertSeverity
  readonly comparator: AlertComparator
  readonly threshold: number
  readonly windowMinutes: number
  readonly value: number | null
  readonly sampleCount: number | null
  readonly linkUrl: string
}


interface DeliveryAttemptFailure {
  readonly message: string
  readonly kind: "transport" | "timeout" | "payload" | "destination" | "unknown"
  readonly retryable: boolean
}

const MAX_DELIVERY_ATTEMPTS = 5
const DELIVERY_TIMEOUT_MS_DEFAULT = 15_000
const DELIVERY_LEASE_TTL_MS = 30_000

type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]
type DatabaseExecutor = DatabaseClient | DatabaseTransaction

/* -------------------------------------------------------------------------- */
/*  Schemas for stored JSON formats                                           */
/* -------------------------------------------------------------------------- */

const DestinationPublicConfigSchema = Schema.Struct({
  summary: Schema.String,
  channelLabel: Schema.NullOr(Schema.String),
})

const DestinationSecretConfigSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("slack"),
    webhookUrl: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("pagerduty"),
    integrationKey: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: Schema.String,
    signingSecret: Schema.NullOr(Schema.String),
  }),
])

const StoredDeliveryPayloadSchema = Schema.Struct({
  eventType: Schema.optional(Schema.String),
  incidentId: Schema.optional(Schema.NullOr(Schema.String)),
  incidentStatus: Schema.optional(Schema.String),
  dedupeKey: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.Struct({
    id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    signalType: Schema.optional(Schema.String),
    severity: Schema.optional(Schema.String),
    groupKey: Schema.optional(Schema.NullOr(Schema.String)),
    comparator: Schema.optional(Schema.String),
    threshold: Schema.optional(Schema.Number),
    windowMinutes: Schema.optional(Schema.Number),
  })),
  observed: Schema.optional(Schema.Struct({
    value: Schema.optional(Schema.NullOr(Schema.Number)),
    sampleCount: Schema.optional(Schema.NullOr(Schema.Number)),
  })),
})

const StringArraySchema = Schema.Array(Schema.String)
const DestinationIdArraySchema = Schema.Array(AlertDestinationDocument.fields.id)

const PublicConfigFromJson = Schema.fromJsonString(DestinationPublicConfigSchema)
const SecretConfigFromJson = Schema.fromJsonString(DestinationSecretConfigSchema)
const DeliveryPayloadFromJson = Schema.fromJsonString(StoredDeliveryPayloadSchema)
const StringArrayFromJson = Schema.fromJsonString(StringArraySchema)
const DestinationIdArrayFromJson = Schema.fromJsonString(DestinationIdArraySchema)
const AlertGroupByFromJson = Schema.fromJsonString(AlertGroupBySchema)

const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeAlertDestinationTypeSync = Schema.decodeUnknownSync(AlertDestinationTypeSchema)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertMetricTypeSync = Schema.decodeUnknownSync(AlertMetricTypeSchema)
const decodeAlertMetricAggregationSync = Schema.decodeUnknownSync(AlertMetricAggregationSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)
const decodeAlertDeliveryStatusSync = Schema.decodeUnknownSync(AlertDeliveryStatus)
const decodeAlertGroupBySync = Schema.decodeUnknownSync(AlertGroupBySchema)
const decodeAlertGroupByFromJsonSync = Schema.decodeUnknownSync(AlertGroupByFromJson)

const parseStoredGroupBy = (raw: string | null): AlertGroupBy | null =>
  raw == null ? null : decodeAlertGroupByFromJsonSync(raw)

const isServiceGroupBy = (groupBy: AlertGroupBy | null): boolean =>
  groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name"

const resolveServiceLinkName = (
  rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
  groupKey: string | null,
): string | null => {
  if (rule.serviceNames.length === 1) return rule.serviceNames[0] ?? null
  if (groupKey != null && groupKey !== "all" && isServiceGroupBy(rule.groupBy)) {
    return groupKey
  }
  return null
}
const decodeAlertQueryDataSourceSync = Schema.decodeUnknownSync(AlertQueryDataSourceSchema)
const decodeAlertQueryAggregationSync = Schema.decodeUnknownSync(AlertQueryAggregationSchema)
type IsoDateTimeValue = Schema.Schema.Type<
  typeof AlertDestinationDocument.fields.createdAt
>

const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]

export interface AlertRuntimeShape {
  readonly now: () => number
  readonly makeUuid: () => string
  readonly fetch: typeof fetch
  readonly deliveryTimeoutMs: () => number
}

export class AlertRuntime extends Context.Service<AlertRuntime, AlertRuntimeShape>()(
  "AlertRuntime",
  {
    make: Effect.succeed({
      now: () => Date.now(),
      makeUuid: () => randomUUID(),
      fetch: globalThis.fetch as typeof fetch,
      deliveryTimeoutMs: () => DELIVERY_TIMEOUT_MS_DEFAULT,
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}

const toIso = (value: number | null | undefined): IsoDateTimeValue | null =>
  value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

const toTinybirdDateTime = (epochMs: number) =>
  new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

const compareThreshold = (
  value: number,
  comparator: AlertComparator,
  threshold: number,
): boolean =>
  Match.value(comparator).pipe(
    Match.when("gt", () => value > threshold),
    Match.when("gte", () => value >= threshold),
    Match.when("lt", () => value < threshold),
    Match.when("lte", () => value <= threshold),
    Match.exhaustive,
  )

const normalizeOptionalString = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

const makePersistenceError = (error: unknown) =>
  new AlertPersistenceError({
    message: error instanceof Error ? error.message : "Alert persistence failed",
  })

const makeValidationError = (message: string, details: ReadonlyArray<string> = []) =>
  new AlertValidationError({ message, details })

const makeDeliveryError = (
  message: string,
  destinationType?: AlertDestinationType,
) =>
  new AlertDeliveryError({
    message,
    destinationType,
  })

const isAdmin = (roles: ReadonlyArray<RoleName>) =>
  roles.some((role) => adminRoles.includes(role))

const parseEncryptionKey = (
  raw: string,
): Effect.Effect<Buffer, AlertValidationError> =>
  parseBase64Aes256GcmKey(raw, (message) =>
    makeValidationError(
      message === "Expected a non-empty base64 encryption key"
        ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
        : message === "Expected base64 for exactly 32 bytes"
          ? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
          : message,
    ),
  )

const encryptSecret = (
  plaintext: string,
  encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, AlertValidationError> =>
  encryptAes256Gcm(plaintext, encryptionKey, () =>
    makeValidationError("Failed to encrypt destination secret"),
  )

const decryptSecret = (
  encrypted: {
    secretCiphertext: string
    secretIv: string
    secretTag: string
  },
  encryptionKey: Buffer,
): Effect.Effect<string, AlertValidationError> =>
  decryptAes256Gcm(
    {
      ciphertext: encrypted.secretCiphertext,
      iv: encrypted.secretIv,
      tag: encrypted.secretTag,
    },
    encryptionKey,
    () => makeValidationError("Failed to decrypt destination secret"),
  )

const parsePublicConfig = (row: AlertDestinationRow): Effect.Effect<DestinationPublicConfig, AlertValidationError> =>
  Schema.decodeUnknownEffect(PublicConfigFromJson)(row.configJson).pipe(
    Effect.mapError(() => makeValidationError("Stored destination config is invalid")),
  )

const parseSecretConfig = (json: string): Effect.Effect<DestinationSecretConfig, AlertValidationError> =>
  Schema.decodeUnknownEffect(SecretConfigFromJson)(json).pipe(
    Effect.mapError(() => makeValidationError("Stored destination secret is invalid")),
  )

type StoredDeliveryPayloadType = Schema.Schema.Type<typeof StoredDeliveryPayloadSchema>

const parseDeliveryPayload = (json: string): Effect.Effect<StoredDeliveryPayloadType, AlertValidationError> =>
  Schema.decodeUnknownEffect(DeliveryPayloadFromJson)(json).pipe(
    Effect.mapError(() => makeValidationError("Stored delivery payload is invalid")),
  )

const summarizeWebhookUrl = (url: string) =>
  Option.match(Option.liftThrowable(() => new URL(url))(), {
    onNone: () => "Webhook endpoint",
    onSome: (parsed) => `POST ${parsed.host}`,
  })

const buildPublicConfig = (
  request: AlertDestinationCreateRequest,
): DestinationPublicConfig =>
  Match.value(request).pipe(
    Match.discriminatorsExhaustive("type")({
      slack: (r) => ({
        summary: r.channelLabel?.trim() || "Slack incoming webhook",
        channelLabel: normalizeOptionalString(r.channelLabel),
      }),
      pagerduty: () => ({
        summary: "PagerDuty Events API v2" as string,
        channelLabel: null,
      }),
      webhook: (r) => ({
        summary: summarizeWebhookUrl(r.url),
        channelLabel: null,
      }),
    }),
  )

const buildSecretConfig = (
  request: AlertDestinationCreateRequest,
): DestinationSecretConfig =>
  Match.value(request).pipe(
    Match.discriminatorsExhaustive("type")({
      slack: (r) => ({
        type: "slack" as const,
        webhookUrl: r.webhookUrl.trim(),
      }),
      pagerduty: (r) => ({
        type: "pagerduty" as const,
        integrationKey: r.integrationKey.trim(),
      }),
      webhook: (r) => ({
        type: "webhook" as const,
        url: r.url.trim(),
        signingSecret: normalizeOptionalString(r.signingSecret),
      }),
    }),
  )

const safeParsePublicConfig = (row: AlertDestinationRow): DestinationPublicConfig =>
  Option.getOrElse(
    Schema.decodeUnknownOption(PublicConfigFromJson)(row.configJson),
    () => ({ summary: "Invalid destination config", channelLabel: null }),
  )

const safeParseStringArray = (value: string): ReadonlyArray<string> =>
  Option.getOrElse(
    Schema.decodeUnknownOption(StringArrayFromJson)(value),
    () => [] as ReadonlyArray<string>,
  )

const compileRulePlan = (rule: {
  readonly signalType: AlertSignalType
  readonly serviceName: string | null
  readonly metricName: string | null
  readonly metricType: AlertMetricType | null
  readonly metricAggregation: AlertMetricAggregationValue | null
  readonly apdexThresholdMs: number | null
  readonly queryDataSource: string | null
  readonly queryAggregation: string | null
  readonly queryWhereClause: string | null
  readonly comparator: AlertComparator
  readonly windowMinutes: number
  readonly groupBy: AlertGroupBy | null
}): Effect.Effect<
  Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
  AlertValidationError
> =>
  Effect.gen(function* () {
  const bucketSeconds = Math.max(rule.windowMinutes * 60, 60)
  const baseTraceFilters = rule.serviceName == null
    ? undefined
    : { serviceName: rule.serviceName }

  const noDataBehavior: QueryEngineNoDataBehavior =
    rule.signalType === "throughput" && ["lt", "lte"].includes(rule.comparator)
      ? "zero"
      : "skip"

  const traceSignalMetrics: Record<string, string> = {
    error_rate: "error_rate",
    p95_latency: "p95_duration",
    p99_latency: "p99_duration",
    throughput: "count",
    apdex: "apdex",
  }

  /**
   * Resolve the rule's user-facing group_by tokens (e.g. ["service.name",
   * "attr.http.route"]) into the internal QuerySpec representation. Returns
   * null when there is no grouping (the spec then uses ["none"]).
   */
  const resolveRuleGroupBy = (
    source: "traces" | "logs" | "metrics",
  ): Effect.Effect<
    { tokens: ReadonlyArray<string>; attributeKeys: ReadonlyArray<string> } | null,
    AlertValidationError
  > => {
    if (rule.groupBy == null || rule.groupBy.length === 0) return Effect.succeed(null)
    const resolved = resolveGroupBy(source, rule.groupBy)
    if (resolved.warnings.length > 0) {
      return Effect.fail(
        makeValidationError(
          `Invalid groupBy for ${source} alert`,
          [...resolved.warnings],
        ),
      )
    }
    if (resolved.tokens.length === 0) {
      return Effect.fail(
        makeValidationError(`groupBy did not resolve to any usable dimension for ${source}`),
      )
    }
    if (source === "metrics" && resolved.attributeKeys.length > 1) {
      return Effect.fail(
        makeValidationError(
          "Metrics alerts support at most one attr.* groupBy dimension",
          [...resolved.attributeKeys.map((key) => `Unsupported additional metrics groupBy attribute: ${key}`)],
        ),
      )
    }
    return Effect.succeed({ tokens: resolved.tokens, attributeKeys: resolved.attributeKeys })
  }

  let query: QuerySpec
  let sampleCountStrategy: QueryEngineSampleCountStrategy

  const traceMetric = traceSignalMetrics[rule.signalType]
  if (traceMetric) {
    const groupResolved = yield* resolveRuleGroupBy("traces")
    const filters: Record<string, unknown> = { ...(baseTraceFilters ?? {}), rootSpansOnly: true }
    if (groupResolved && groupResolved.attributeKeys.length > 0) {
      filters.groupByAttributeKeys = [...groupResolved.attributeKeys]
    }
    query = decodeQuerySpecSync({
      kind: "timeseries",
      source: "traces",
      metric: traceMetric,
      groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
      bucketSeconds,
      ...(rule.signalType === "apdex" ? { apdexThresholdMs: rule.apdexThresholdMs ?? 500 } : {}),
      filters,
    })
    sampleCountStrategy = "trace_count"
  } else if (rule.signalType === "metric") {
    if (rule.metricName == null || rule.metricType == null || rule.metricAggregation == null) {
      return yield* Effect.fail(
        makeValidationError("metric alerts require metricName, metricType, and metricAggregation"),
      )
    }
    const groupResolved = yield* resolveRuleGroupBy("metrics")
    const filters: Record<string, unknown> = {
      metricName: rule.metricName,
      metricType: rule.metricType,
      ...(rule.serviceName == null ? {} : { serviceName: rule.serviceName }),
    }
    if (groupResolved && groupResolved.attributeKeys.length > 0) {
      // Metrics group-by-attribute is single-key today; pick the first.
      filters.groupByAttributeKey = groupResolved.attributeKeys[0]
    }
    query = decodeQuerySpecSync({
      kind: "timeseries",
      source: "metrics",
      metric: rule.metricAggregation,
      groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
      bucketSeconds,
      filters,
    })
    sampleCountStrategy = "metric_data_points"
  } else if (rule.signalType === "query") {
    if (rule.queryDataSource == null || rule.queryAggregation == null) {
      return yield* Effect.fail(
        makeValidationError("query alerts require queryDataSource and queryAggregation"),
      )
    }
    const filterSet = buildAlertQueryFilterSet({
      queryDataSource: rule.queryDataSource as AlertQueryDataSource,
      serviceName: rule.serviceName,
      metricName: rule.metricName,
      metricType: rule.metricType,
      queryWhereClause: rule.queryWhereClause,
    })

    if (filterSet == null) {
      return yield* Effect.fail(
        makeValidationError("metrics query alerts require metricName and metricType"),
      )
    }

    if (filterSet.source === "traces") {
      const groupResolved = yield* resolveRuleGroupBy("traces")
      const filters: Record<string, unknown> = { ...(filterSet.filters ?? {}) }
      if (groupResolved && groupResolved.attributeKeys.length > 0) {
        filters.groupByAttributeKeys = [...groupResolved.attributeKeys]
      }
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: rule.queryAggregation,
        groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
        bucketSeconds,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      })
      sampleCountStrategy = "trace_count"
    } else if (filterSet.source === "logs") {
      const groupResolved = yield* resolveRuleGroupBy("logs")
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "logs",
        metric: "count",
        groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
        bucketSeconds,
        filters: filterSet.filters,
      })
      sampleCountStrategy = "log_count"
    } else {
      const groupResolved = yield* resolveRuleGroupBy("metrics")
      const filters: Record<string, unknown> = { ...(filterSet.filters ?? {}) }
      if (groupResolved && groupResolved.attributeKeys.length > 0) {
        filters.groupByAttributeKey = groupResolved.attributeKeys[0]
      }
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "metrics",
        metric: rule.queryAggregation,
        groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
        bucketSeconds,
        filters,
      })
      sampleCountStrategy = "metric_data_points"
    }
  } else {
    return yield* Effect.fail(makeValidationError(`Unsupported signal type: ${rule.signalType}`))
  }

  return yield* Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
    query,
    reducer: "identity",
    sampleCountStrategy,
    noDataBehavior,
  }).pipe(
    Effect.mapError(() => makeValidationError("Failed to compile alert rule plan")),
  )
})

const QuerySpecFromJson = Schema.fromJsonString(QuerySpec)

const parseCompiledPlan = (
  row: Pick<
    AlertRuleRow,
    "querySpecJson" | "reducer" | "sampleCountStrategy" | "noDataBehavior"
  >,
): Effect.Effect<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> =>
  Schema.decodeUnknownEffect(QuerySpecFromJson)(row.querySpecJson).pipe(
    Effect.flatMap((query) =>
      Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
        query,
        reducer: row.reducer,
        sampleCountStrategy: row.sampleCountStrategy,
        noDataBehavior: row.noDataBehavior,
      }),
    ),
    Effect.mapError(() => makeValidationError("Stored compiled alert plan is invalid")),
  )

const rowToDestinationDocument = (
  row: AlertDestinationRow,
  publicConfig: DestinationPublicConfig,
) =>
  new AlertDestinationDocument({
    id: decodeAlertDestinationIdSync(row.id),
    name: row.name,
    type: decodeAlertDestinationTypeSync(row.type),
    enabled: row.enabled === 1,
    summary: publicConfig.summary,
    channelLabel: publicConfig.channelLabel,
    lastTestedAt: toIso(row.lastTestedAt),
    lastTestError: row.lastTestError,
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
  })

const serviceNamesFromRow = (row: AlertRuleRow): ReadonlyArray<string> =>
  row.serviceNamesJson
    ? safeParseStringArray(row.serviceNamesJson)
    : []

const excludeServiceNamesFromRow = (row: AlertRuleRow): ReadonlyArray<string> =>
  row.excludeServiceNamesJson
    ? safeParseStringArray(row.excludeServiceNamesJson)
    : []

const rowToRuleDocument = (row: AlertRuleRow, destinationIds: ReadonlyArray<string>) => {
  const serviceNames = serviceNamesFromRow(row)
  return new AlertRuleDocument({
    id: decodeAlertRuleIdSync(row.id),
    name: row.name,
    enabled: row.enabled === 1,
    severity: decodeAlertSeveritySync(row.severity),
    serviceNames: [...serviceNames],
    excludeServiceNames: [...excludeServiceNamesFromRow(row)],
    groupBy: parseStoredGroupBy(row.groupBy),
    signalType: decodeAlertSignalTypeSync(row.signalType),
    comparator: decodeAlertComparatorSync(row.comparator),
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    minimumSampleCount: row.minimumSampleCount,
    consecutiveBreachesRequired: row.consecutiveBreachesRequired,
    consecutiveHealthyRequired: row.consecutiveHealthyRequired,
    renotifyIntervalMinutes: row.renotifyIntervalMinutes,
    metricName: row.metricName,
    metricType: row.metricType != null ? decodeAlertMetricTypeSync(row.metricType) : null,
    metricAggregation:
      row.metricAggregation != null ? decodeAlertMetricAggregationSync(row.metricAggregation) : null,
    apdexThresholdMs: row.apdexThresholdMs,
    queryDataSource: row.queryDataSource != null ? decodeAlertQueryDataSourceSync(row.queryDataSource) : null,
    queryAggregation: row.queryAggregation != null ? decodeAlertQueryAggregationSync(row.queryAggregation) : null,
    queryWhereClause: row.queryWhereClause ?? null,
    destinationIds: destinationIds.map((id) => decodeAlertDestinationIdSync(id)),
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  })
}

const rowToIncidentDocument = (row: AlertIncidentRow) =>
  new AlertIncidentDocument({
    id: decodeAlertIncidentIdSync(row.id),
    ruleId: decodeAlertRuleIdSync(row.ruleId),
    ruleName: row.ruleName,
    groupKey: row.groupKey,
    signalType: decodeAlertSignalTypeSync(row.signalType),
    severity: decodeAlertSeveritySync(row.severity),
    status: decodeAlertIncidentStatusSync(row.status),
    comparator: decodeAlertComparatorSync(row.comparator),
    threshold: row.threshold,
    firstTriggeredAt: decodeIsoDateTimeStringSync(
      new Date(row.firstTriggeredAt).toISOString(),
    ),
    lastTriggeredAt: decodeIsoDateTimeStringSync(
      new Date(row.lastTriggeredAt).toISOString(),
    ),
    resolvedAt: toIso(row.resolvedAt),
    lastObservedValue: row.lastObservedValue,
    lastSampleCount: row.lastSampleCount,
    dedupeKey: row.dedupeKey,
    lastDeliveredEventType: row.lastDeliveredEventType != null ? decodeAlertEventTypeSync(row.lastDeliveredEventType) : null,
    lastNotifiedAt: toIso(row.lastNotifiedAt),
  })

// Formatting helpers imported from AlertDeliveryDispatch

export interface AlertsServiceShape {
  readonly listDestinations: (
    orgId: OrgId,
  ) => Effect.Effect<AlertDestinationsListResponse, AlertPersistenceError>
  readonly createDestination: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    request: AlertDestinationCreateRequest,
  ) => Effect.Effect<
    AlertDestinationDocument,
    AlertForbiddenError | AlertValidationError | AlertPersistenceError
  >
  readonly updateDestination: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    destinationId: AlertDestinationDocument["id"],
    request: AlertDestinationUpdateRequest,
  ) => Effect.Effect<
    AlertDestinationDocument,
    | AlertForbiddenError
    | AlertValidationError
    | AlertPersistenceError
    | AlertNotFoundError
  >
  readonly deleteDestination: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
    destinationId: AlertDestinationDocument["id"],
  ) => Effect.Effect<
    AlertDestinationDeleteResponse,
    | AlertForbiddenError
    | AlertPersistenceError
    | AlertNotFoundError
    | AlertDestinationInUseError
  >
  readonly testDestination: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    destinationId: AlertDestinationDocument["id"],
  ) => Effect.Effect<
    AlertDestinationTestResponse,
    | AlertForbiddenError
    | AlertPersistenceError
    | AlertNotFoundError
    | AlertDeliveryError
    | AlertValidationError
  >
  readonly listRules: (
    orgId: OrgId,
  ) => Effect.Effect<AlertRulesListResponse, AlertPersistenceError>
  readonly createRule: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    request: AlertRuleUpsertRequest,
  ) => Effect.Effect<
    AlertRuleDocument,
    | AlertForbiddenError
    | AlertValidationError
    | AlertPersistenceError
    | AlertNotFoundError
  >
  readonly updateRule: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    ruleId: AlertRuleDocument["id"],
    request: AlertRuleUpsertRequest,
  ) => Effect.Effect<
    AlertRuleDocument,
    | AlertForbiddenError
    | AlertValidationError
    | AlertPersistenceError
    | AlertNotFoundError
  >
  readonly deleteRule: (
    orgId: OrgId,
    roles: ReadonlyArray<RoleName>,
    ruleId: AlertRuleDocument["id"],
  ) => Effect.Effect<
    AlertRuleDeleteResponse,
    AlertForbiddenError | AlertPersistenceError | AlertNotFoundError
  >
  readonly testRule: (
    orgId: OrgId,
    userId: UserId,
    roles: ReadonlyArray<RoleName>,
    request: AlertRuleUpsertRequest,
    sendNotification?: boolean,
  ) => Effect.Effect<
    AlertEvaluationResult,
    | AlertForbiddenError
    | AlertValidationError
    | AlertPersistenceError
    | AlertNotFoundError
    | AlertDeliveryError
  >
  readonly listIncidents: (
    orgId: OrgId,
  ) => Effect.Effect<AlertIncidentsListResponse, AlertPersistenceError>
  readonly listDeliveryEvents: (
    orgId: OrgId,
  ) => Effect.Effect<AlertDeliveryEventsListResponse, AlertPersistenceError>
  readonly runSchedulerTick: () => Effect.Effect<
    {
      readonly evaluatedCount: number
      readonly processedCount: number
      readonly evaluationFailureCount: number
      readonly deliveryFailureCount: number
    },
    AlertPersistenceError | AlertDeliveryError | AlertValidationError | AlertNotFoundError
  >
}

export class AlertsService extends Context.Service<AlertsService, AlertsServiceShape>()(
  "AlertsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const env = yield* Env
      const queryEngine = yield* QueryEngineService
      const runtime = yield* AlertRuntime
      const encryptionKey = yield* parseEncryptionKey(
        Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      )
      const now = () => runtime.now()
      const makeUuid = () => runtime.makeUuid()
      const deliveryTimeoutMs = () => runtime.deliveryTimeoutMs()
      const workerId = makeUuid()

      const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
        database.execute(fn).pipe(Effect.mapError(makePersistenceError))

      const requireAdmin = Effect.fn("AlertsService.requireAdmin")(function* (
        roles: ReadonlyArray<RoleName>,
      ) {
        if (isAdmin(roles)) return
        return yield* Effect.fail(
          new AlertForbiddenError({
            message: "Only org admins can manage alerts",
            ...(roles.length > 0 ? { roles: [...roles] } : {}),
          }),
        )
      })

      const requireDestinationRow = Effect.fn("AlertsService.requireDestinationRow")(function* (
        orgId: OrgId,
        destinationId: AlertDestinationDocument["id"],
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                eq(alertDestinations.id, destinationId),
              ),
            )
            .limit(1),
        )
        if (rows[0]) return rows[0]
        return yield* Effect.fail(
          new AlertNotFoundError({
            message: "Alert destination not found",
            resourceType: "destination",
            resourceId: destinationId,
          }),
        )
      })

      const hydrateDestination = Effect.fn("AlertsService.hydrateDestination")(function* (
        row: AlertDestinationRow,
      ) {
        const publicConfig = yield* parsePublicConfig(row)
        const secretJson = yield* decryptSecret(row, encryptionKey)
        const secretConfig = yield* parseSecretConfig(secretJson)
        return {
          row,
          publicConfig,
          secretConfig,
          document: rowToDestinationDocument(row, publicConfig),
        } as const
      })

      const requireRuleRow = Effect.fn("AlertsService.requireRuleRow")(function* (
        orgId: OrgId,
        ruleId: AlertRuleDocument["id"],
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertRules)
            .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
            .limit(1),
        )
        if (rows[0]) return rows[0]
        return yield* Effect.fail(
          new AlertNotFoundError({
            message: "Alert rule not found",
            resourceType: "rule",
            resourceId: ruleId,
          }),
        )
      })

      const parseDestinationIds = (value: string): Effect.Effect<ReadonlyArray<AlertDestinationId>, AlertValidationError> =>
        Schema.decodeUnknownEffect(DestinationIdArrayFromJson)(value).pipe(
          Effect.mapError(() => makeValidationError("Stored rule destinations are invalid")),
        )

      const normalizeRuleRow = Effect.fn("AlertsService.normalizeRuleRow")(function* (
        row: AlertRuleRow,
      ): Effect.fn.Return<NormalizedRule, AlertValidationError> {
        const serviceNames = serviceNamesFromRow(row)
        return {
          id: decodeAlertRuleIdSync(row.id),
          name: row.name,
          enabled: row.enabled === 1,
          severity: decodeAlertSeveritySync(row.severity),
          serviceName: serviceNames.length === 1 ? serviceNames[0] : null,
          serviceNames,
          excludeServiceNames: excludeServiceNamesFromRow(row),
          groupBy: parseStoredGroupBy(row.groupBy),
          signalType: decodeAlertSignalTypeSync(row.signalType),
          comparator: decodeAlertComparatorSync(row.comparator),
          threshold: row.threshold,
          windowMinutes: row.windowMinutes,
          minimumSampleCount: row.minimumSampleCount,
          consecutiveBreachesRequired: row.consecutiveBreachesRequired,
          consecutiveHealthyRequired: row.consecutiveHealthyRequired,
          renotifyIntervalMinutes: row.renotifyIntervalMinutes,
          metricName: row.metricName,
          metricType: row.metricType != null ? decodeAlertMetricTypeSync(row.metricType) : null,
          metricAggregation:
            row.metricAggregation != null ? decodeAlertMetricAggregationSync(row.metricAggregation) : null,
          apdexThresholdMs: row.apdexThresholdMs,
          queryDataSource: row.queryDataSource ?? null,
          queryAggregation: row.queryAggregation != null ? decodeAlertQueryAggregationSync(row.queryAggregation) : null,
          queryWhereClause: row.queryWhereClause ?? null,
          destinationIds: yield* parseDestinationIds(row.destinationIdsJson),
          compiledPlan: yield* parseCompiledPlan(row),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      })

      const normalizeRule = Effect.fn("AlertsService.normalizeRule")(function* (
        request: AlertRuleUpsertRequest,
      ): Effect.fn.Return<NormalizedRule, AlertValidationError> {
        const name = request.name.trim()
        const serviceNames = request.serviceNames && request.serviceNames.length > 0
          ? request.serviceNames.map((s) => s.trim()).filter((s) => s.length > 0)
          : []
        const serviceName = serviceNames.length === 1 ? serviceNames[0] : null
        const excludeServiceNames = request.excludeServiceNames
          ? request.excludeServiceNames.map((s) => s.trim()).filter((s) => s.length > 0)
          : []
        const metricName = normalizeOptionalString(request.metricName)
        const destinationIds = request.destinationIds

        const details: string[] = []
        if (name.length === 0) details.push("name is required")
        if (destinationIds.length === 0) {
          details.push("at least one destination must be selected")
        }
        if (request.threshold == null || !Number.isFinite(request.threshold)) {
          details.push("threshold must be a finite number")
        }
        if (request.signalType === "metric") {
          if (!metricName) details.push("metricName is required for metric alerts")
          if (!request.metricType) details.push("metricType is required for metric alerts")
          if (!request.metricAggregation) {
            details.push("metricAggregation is required for metric alerts")
          }
        }
        if (request.signalType === "query") {
          if (!request.queryDataSource) details.push("queryDataSource is required for query alerts")
          if (!request.queryAggregation) details.push("queryAggregation is required for query alerts")
          if (request.queryDataSource === "metrics") {
            if (!metricName) details.push("metricName is required for metrics query alerts")
            if (!request.metricType) details.push("metricType is required for metrics query alerts")
          }
        }
        const allowsMetricFields = request.signalType === "metric" ||
          (request.signalType === "query" && request.queryDataSource === "metrics")
        if (!allowsMetricFields && request.metricType) {
          details.push("metricType is only supported for metric or query alerts")
        }
        if (!allowsMetricFields && metricName) {
          details.push("metricName is only supported for metric or query alerts")
        }
        if (request.signalType !== "metric" && request.metricAggregation) {
          details.push("metricAggregation is only supported for metric alerts")
        }
        const groupBy = request.groupBy ?? null
        if (groupBy != null && serviceNames.length > 0) {
          details.push("groupBy is only supported when no service is specified")
        }
        if (excludeServiceNames.length > 0 && serviceNames.length > 0) {
          details.push("excludeServiceNames is only supported when no specific services are selected")
        }
        if (excludeServiceNames.length > 0 && !isServiceGroupBy(groupBy)) {
          details.push("excludeServiceNames requires groupBy=[\"service.name\"]")
        }

        if (details.length > 0) {
          return yield* Effect.fail(
            makeValidationError("Invalid alert rule", details),
          )
        }

        const normalizedBase = {
          id: decodeAlertRuleIdSync(makeUuid()),
          name,
          enabled: request.enabled ?? true,
          severity: request.severity,
          serviceName,
          serviceNames,
          excludeServiceNames,
          groupBy,
          signalType: request.signalType,
          comparator: request.comparator,
          threshold: request.threshold,
          windowMinutes: request.windowMinutes,
          minimumSampleCount: request.minimumSampleCount ?? 0,
          consecutiveBreachesRequired: request.consecutiveBreachesRequired ?? 2,
          consecutiveHealthyRequired: request.consecutiveHealthyRequired ?? 2,
          renotifyIntervalMinutes: request.renotifyIntervalMinutes ?? 30,
          metricName,
          metricType: request.metricType ?? null,
          metricAggregation: request.metricAggregation ?? null,
          apdexThresholdMs: request.apdexThresholdMs ?? (request.signalType === "apdex" ? 500 : null),
          queryDataSource: request.queryDataSource ?? null,
          queryAggregation: request.queryAggregation ?? null,
          queryWhereClause: request.queryWhereClause ?? null,
          destinationIds,
          createdAt: now(),
          updatedAt: now(),
        }
        const compiledPlan = yield* compileRulePlan(normalizedBase)

        return {
          ...normalizedBase,
          compiledPlan,
        }
      })

      const requireDestinationIds = Effect.fn("AlertsService.requireDestinationIds")(function* (
        orgId: OrgId,
        destinationIds: ReadonlyArray<AlertDestinationId>,
      ) {
        if (destinationIds.length === 0) return

        const rows = yield* dbExecute((db) =>
          db
            .select({ id: alertDestinations.id })
            .from(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                inArray(alertDestinations.id, [...destinationIds]),
              ),
            ),
        )

        const existingIds = new Set(rows.map((row) => row.id))
        const missing = destinationIds.filter((id) => !existingIds.has(id))
        if (missing.length > 0) {
          return yield* Effect.fail(
            makeValidationError("Unknown destination IDs", missing),
          )
        }
      })

      const systemTenant = (orgId: OrgId): TenantContext => ({
        orgId,
        userId: decodeUserIdSync("system-alerting"),
        roles: [decodeRoleNameSync("root")],
        authMode: "self_hosted",
      })

      const catchQueryEngineErrors = <A, R>(effect: Effect.Effect<A, QueryEngineValidationError | QueryEngineExecutionError | QueryEngineTimeoutError, R>) =>
        effect.pipe(
          Effect.catchTags({
            "@maple/http/errors/QueryEngineValidationError": (e) => Effect.fail(makeValidationError(e.message, e.details)),
            "@maple/http/errors/QueryEngineExecutionError": (e) => Effect.fail(makeDeliveryError(e.message)),
            "@maple/http/errors/QueryEngineTimeoutError": (e) => Effect.fail(makeDeliveryError(e.message ?? "Alert evaluation timed out")),
          }),
        )

      /**
       * Evaluate the alert rule and return one outcome per group. For
       * ungrouped rules the array always has length 1 with `groupKey = "all"`.
       * For grouped rules every distinct value (or composite value, when
       * multiple dimensions are picked) becomes its own entry that is
       * processed and dedup'd independently downstream.
       */
      const evaluateRule = Effect.fn("AlertsService.evaluateRule")(function* (
        orgId: OrgId,
        rule: NormalizedRule,
      ): Effect.fn.Return<
        ReadonlyArray<{ evaluation: EvaluatedRule; groupKey: string }>,
        AlertValidationError | AlertDeliveryError
      > {
        const endMs = now()
        const startMs = endMs - rule.windowMinutes * 60_000
        const observations = yield* queryEngine.evaluate(systemTenant(orgId), {
          startTime: toTinybirdDateTime(startMs),
          endTime: toTinybirdDateTime(endMs),
          query: rule.compiledPlan.query,
          reducer: rule.compiledPlan.reducer,
          sampleCountStrategy: rule.compiledPlan.sampleCountStrategy,
        }).pipe(catchQueryEngineErrors)

        return observations.map((obs) => ({
          evaluation: applyEvaluationLogic(rule, obs),
          groupKey: obs.groupKey,
        }))
      })

      const applyEvaluationLogic = (
        rule: NormalizedRule,
        obs: Pick<GroupedAlertObservation, "value" | "sampleCount" | "hasData">,
        reasonOverride?: string,
      ): EvaluatedRule => {
        const noDataBehavior = rule.compiledPlan.noDataBehavior
        const sampleCount = obs.sampleCount
        const value = obs.hasData
          ? obs.value
          : noDataBehavior === "zero"
            ? 0
            : null

        if (!obs.hasData && noDataBehavior === "skip") {
          return {
            status: "skipped",
            value: null,
            sampleCount,
            threshold: rule.threshold,
            comparator: rule.comparator,
            reason:
              rule.signalType === "metric"
                ? "No metric data in the selected window"
                : "No data in the selected window",
          }
        }

        if (sampleCount < rule.minimumSampleCount) {
          return {
            status: "skipped",
            value,
            sampleCount,
            threshold: rule.threshold,
            comparator: rule.comparator,
            reason: `Sample count ${sampleCount} is below minimum ${rule.minimumSampleCount}`,
          }
        }

        if (value == null) {
          return {
            status: "skipped",
            value: null,
            sampleCount,
            threshold: rule.threshold,
            comparator: rule.comparator,
            reason: "Alert evaluation did not return a scalar value",
          }
        }

        return {
          status: compareThreshold(value, rule.comparator, rule.threshold)
            ? "breached"
            : "healthy",
          value,
          sampleCount,
          threshold: rule.threshold,
          comparator: rule.comparator,
          reason:
            reasonOverride ??
            `${rule.signalType} ${formatComparator(rule.comparator)} ${rule.threshold}`,
        }
      }

      const buildDeliveryKey = (
        incidentId: string,
        destinationId: string,
        eventType: AlertEventTypeValue,
        scheduledAt: number,
      ) => [incidentId, destinationId, eventType, scheduledAt].join(":")

      const insertDeliveryEventRecord = (
        db: DatabaseExecutor,
        orgId: OrgId,
        incidentId: AlertIncidentId | null,
        ruleId: AlertRuleId,
        destinationId: AlertDestinationId,
        eventType: AlertEventTypeValue,
        payload: Record<string, unknown>,
        scheduledAt: number,
        deliveryKey: string,
        attemptNumber: number,
      ) =>
        db.insert(alertDeliveryEvents).values({
          id: makeUuid(),
          orgId,
          incidentId,
          ruleId,
          destinationId,
          deliveryKey,
          eventType,
          attemptNumber,
          status: "queued",
          scheduledAt,
          claimedAt: null,
          claimExpiresAt: null,
          claimedBy: null,
          attemptedAt: null,
          providerMessage: null,
          providerReference: null,
          responseCode: null,
          errorMessage: null,
          payloadJson: JSON.stringify(payload),
          createdAt: scheduledAt,
          updatedAt: scheduledAt,
        }).onConflictDoNothing()

      const insertDeliveryEvent = Effect.fn("AlertsService.insertDeliveryEvent")(function* (
        orgId: OrgId,
        incidentId: AlertIncidentId | null,
        ruleId: AlertRuleId,
        destinationId: AlertDestinationId,
        eventType: AlertEventTypeValue,
        payload: Record<string, unknown>,
        scheduledAt: number,
        deliveryKey: string,
        attemptNumber: number,
      ) {
        yield* dbExecute((db) =>
          insertDeliveryEventRecord(
            db,
            orgId,
            incidentId,
            ruleId,
            destinationId,
            eventType,
            payload,
            scheduledAt,
            deliveryKey,
            attemptNumber,
          ),
        )
      })

      const markDestinationTest = Effect.fn("AlertsService.markDestinationTest")(function* (
        orgId: OrgId,
        destinationId: AlertDestinationId,
        errorMessage: string | null,
      ) {
        const timestamp = now()
        yield* dbExecute((db) =>
          db
            .update(alertDestinations)
            .set({
              lastTestedAt: timestamp,
              lastTestError: errorMessage,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                eq(alertDestinations.id, destinationId),
              ),
            ),
        )
      })

      const composeLinkUrl = (serviceLinkName: string | null) =>
        serviceLinkName
          ? `${env.MAPLE_APP_BASE_URL}/services/${encodeURIComponent(serviceLinkName)}`
          : `${env.MAPLE_APP_BASE_URL}/alerts`

      const resolveNotificationLinkUrl = (
        rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
        groupKey: string | null,
      ) =>
        composeLinkUrl(resolveServiceLinkName(rule, groupKey))

      const dispatchDelivery = (
        context: DispatchContext,
        payloadJson: string,
      ): Effect.Effect<DispatchResult, AlertDeliveryError> =>
        dispatchDeliveryImpl(
          context,
          payloadJson,
          runtime.fetch,
          deliveryTimeoutMs(),
          context.linkUrl,
        )

      const buildPayload = (context: DeliveryPayloadContext) => ({
        eventType: context.eventType,
        incidentId: context.incidentId,
        incidentStatus: context.incidentStatus,
        dedupeKey: context.dedupeKey,
        rule: {
          id: context.ruleId,
          name: context.ruleName,
          signalType: context.signalType,
          severity: context.severity,
          groupKey: context.groupKey,
          comparator: context.comparator,
          threshold: context.threshold,
          windowMinutes: context.windowMinutes,
        },
        observed: {
          value: context.value,
          sampleCount: context.sampleCount,
        },
        linkUrl: context.linkUrl,
        sentAt: new Date(now()).toISOString(),
      })

      const toDeliveryAttemptFailure = (error: unknown): DeliveryAttemptFailure => {
        if (error instanceof AlertValidationError) {
          return {
            message: error.message,
            kind: "payload",
            retryable: false,
          }
        }

        if (error instanceof AlertDeliveryError) {
          return {
            message: error.message,
            kind: error.message.includes("timed out") ? "timeout" : "transport",
            retryable: true,
          }
        }

        if (error instanceof AlertNotFoundError) {
          return {
            message: error.message,
            kind: "destination",
            retryable: false,
          }
        }

        return {
          message: error instanceof Error ? error.message : "Delivery failed",
          kind: "unknown",
          retryable: false,
        }
      }

      const sendImmediateNotification = Effect.fn(
        "AlertsService.sendImmediateNotification",
      )(function* (
        destinationRow: AlertDestinationRow,
        context: Omit<DispatchContext, "destination" | "publicConfig" | "secretConfig">,
      ) {
        const hydrated = yield* hydrateDestination(destinationRow)
        const fullContext: DispatchContext = {
          destination: hydrated.row,
          publicConfig: hydrated.publicConfig,
          secretConfig: hydrated.secretConfig,
          ...context,
        }
        const payload = buildPayload(fullContext)
        const payloadJson = JSON.stringify(payload)
        return yield* dispatchDelivery(fullContext, payloadJson)
      })

      const queueIncidentNotificationsOnDb = (
        db: DatabaseExecutor,
        orgId: OrgId,
        rule: NormalizedRule,
        incident: AlertIncidentRow,
        evaluation: EvaluatedRule,
        eventType: AlertEventTypeValue,
        scheduledAt: number,
      ) => {
        if (rule.destinationIds.length === 0) return Promise.resolve()

        return db
          .select({
            id: alertDestinations.id,
            enabled: alertDestinations.enabled,
          })
          .from(alertDestinations)
          .where(
            and(
              eq(alertDestinations.orgId, orgId),
              inArray(alertDestinations.id, [...rule.destinationIds]),
            ),
          )
          .then(async (rows) => {
            const destinations = new Map(rows.map((row) => [row.id, row]))
            const brandedIncidentId = decodeAlertIncidentIdSync(incident.id)
            const payload = buildPayload({
              eventType,
              incidentId: brandedIncidentId,
              incidentStatus: decodeAlertIncidentStatusSync(incident.status),
              dedupeKey: incident.dedupeKey,
              ruleId: rule.id,
              ruleName: rule.name,
              groupKey: incident.groupKey,
              signalType: rule.signalType,
              severity: rule.severity,
              comparator: rule.comparator,
              threshold: rule.threshold,
              windowMinutes: rule.windowMinutes,
              value: evaluation.value,
              sampleCount: evaluation.sampleCount,
              linkUrl: resolveNotificationLinkUrl(rule, incident.groupKey),
            })

            for (const destinationId of rule.destinationIds) {
              const destination = destinations.get(destinationId)
              if (!destination || destination.enabled !== 1) continue

              await insertDeliveryEventRecord(
                db,
                orgId,
                brandedIncidentId,
                rule.id,
                destinationId,
                eventType,
                payload,
                scheduledAt,
                buildDeliveryKey(incident.id, destinationId, eventType, scheduledAt),
                1,
              )
            }
          })
      }

      const computeRetryDelayMs = (attemptNumber: number) => {
        const base = Math.min(60_000 * Math.pow(2, attemptNumber - 1), 15 * 60_000)
        const jitter = Math.floor(Math.random() * 1_000)
        return base + jitter
      }

      const listDestinations = Effect.fn("AlertsService.listDestinations")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertDestinations)
            .where(eq(alertDestinations.orgId, orgId))
            .orderBy(desc(alertDestinations.updatedAt)),
        )

        const destinations = rows.map((row) =>
          rowToDestinationDocument(row, safeParsePublicConfig(row)),
        )

        return new AlertDestinationsListResponse({ destinations })
      })

      const createDestination = Effect.fn("AlertsService.createDestination")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        request: AlertDestinationCreateRequest,
      ) {
        yield* requireAdmin(roles)
        const destinationId = makeUuid()
        const publicConfig = buildPublicConfig(request)
        const secretConfig = buildSecretConfig(request)
        const encryptedSecret = yield* encryptSecret(
          JSON.stringify(secretConfig),
          encryptionKey,
        )
        const timestamp = now()

        const row = {
          id: destinationId,
          orgId,
          name: request.name.trim(),
          type: request.type,
          enabled: request.enabled === false ? 0 : 1,
          configJson: JSON.stringify(publicConfig),
          secretCiphertext: encryptedSecret.ciphertext,
          secretIv: encryptedSecret.iv,
          secretTag: encryptedSecret.tag,
          lastTestedAt: null,
          lastTestError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: userId,
          updatedBy: userId,
        }

        yield* dbExecute((db) =>
          db.insert(alertDestinations).values(row),
        )

        return rowToDestinationDocument(row, publicConfig)
      })

      const updateDestination = Effect.fn("AlertsService.updateDestination")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        destinationId: AlertDestinationDocument["id"],
        request: AlertDestinationUpdateRequest,
      ) {
        yield* requireAdmin(roles)
        const existing = yield* requireDestinationRow(orgId, destinationId)
        if (existing.type !== request.type) {
          return yield* Effect.fail(
            makeValidationError("Destination type cannot be changed"),
          )
        }

        const hydrated = yield* hydrateDestination(existing)
        let nextPublicConfig = hydrated.publicConfig
        let nextSecretConfig = hydrated.secretConfig

        switch (request.type) {
          case "slack":
            nextPublicConfig = {
              summary:
                normalizeOptionalString(request.channelLabel) ??
                hydrated.publicConfig.summary,
              channelLabel:
                normalizeOptionalString(request.channelLabel) ??
                hydrated.publicConfig.channelLabel,
            }
            nextSecretConfig = {
              type: "slack",
              webhookUrl:
                normalizeOptionalString(request.webhookUrl) ??
                (hydrated.secretConfig.type === "slack"
                  ? hydrated.secretConfig.webhookUrl
                  : ""),
            }
            break
          case "pagerduty":
            nextPublicConfig = hydrated.publicConfig
            nextSecretConfig = {
              type: "pagerduty",
              integrationKey:
                normalizeOptionalString(request.integrationKey) ??
                (hydrated.secretConfig.type === "pagerduty"
                  ? hydrated.secretConfig.integrationKey
                  : ""),
            }
            break
          case "webhook":
            nextPublicConfig = {
              summary:
                request.url != null && request.url.trim().length > 0
                  ? summarizeWebhookUrl(request.url)
                  : hydrated.publicConfig.summary,
              channelLabel: null,
            }
            nextSecretConfig = {
              type: "webhook",
              url:
                normalizeOptionalString(request.url) ??
                (hydrated.secretConfig.type === "webhook"
                  ? hydrated.secretConfig.url
                  : ""),
              signingSecret:
                request.signingSecret === undefined
                  ? hydrated.secretConfig.type === "webhook"
                    ? hydrated.secretConfig.signingSecret
                    : null
                  : normalizeOptionalString(request.signingSecret),
            }
            break
        }

        const encryptedSecret = yield* encryptSecret(
          JSON.stringify(nextSecretConfig),
          encryptionKey,
        )
        const timestamp = now()
        const nextName = normalizeOptionalString(request.name) ?? existing.name
        const nextEnabled =
          request.enabled === undefined ? existing.enabled : request.enabled ? 1 : 0

        yield* dbExecute((db) =>
          db
            .update(alertDestinations)
            .set({
              name: nextName,
              enabled: nextEnabled,
              configJson: JSON.stringify(nextPublicConfig),
              secretCiphertext: encryptedSecret.ciphertext,
              secretIv: encryptedSecret.iv,
              secretTag: encryptedSecret.tag,
              updatedAt: timestamp,
              updatedBy: userId,
            })
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                eq(alertDestinations.id, destinationId),
              ),
            ),
        )

        return rowToDestinationDocument(
          {
            ...existing,
            name: nextName,
            enabled: nextEnabled,
            configJson: JSON.stringify(nextPublicConfig),
            secretCiphertext: encryptedSecret.ciphertext,
            secretIv: encryptedSecret.iv,
            secretTag: encryptedSecret.tag,
            updatedAt: timestamp,
            updatedBy: userId,
          },
          nextPublicConfig,
        )
      })

      const deleteDestination = Effect.fn("AlertsService.deleteDestination")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
        destinationId: AlertDestinationDocument["id"],
      ) {
        yield* requireAdmin(roles)
        yield* requireDestinationRow(orgId, destinationId)
        const dependentRules = yield* dbExecute((db) =>
          db
            .select({
              id: alertRules.id,
              name: alertRules.name,
              destinationIdsJson: alertRules.destinationIdsJson,
            })
            .from(alertRules)
            .where(eq(alertRules.orgId, orgId)),
        ).pipe(
          Effect.map((rows) =>
            rows.filter((row) =>
              safeParseStringArray(row.destinationIdsJson).includes(destinationId),
            ),
          ),
        )

        if (dependentRules.length > 0) {
          const ruleIds = dependentRules.map((row) => decodeAlertRuleIdSync(row.id))
          const ruleNames = dependentRules.map((row) => row.name)
          return yield* Effect.fail(
            new AlertDestinationInUseError({
              message: `Destination is still used by alert rules: ${ruleNames.join(", ")}`,
              destinationId,
              ruleIds,
              ruleNames,
            }),
          )
        }

        yield* dbExecute((db) =>
          db
            .delete(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                eq(alertDestinations.id, destinationId),
              ),
            ),
        )
        return new AlertDestinationDeleteResponse({ id: destinationId })
      })

      const testDestination = Effect.fn("AlertsService.testDestination")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        destinationId: AlertDestinationDocument["id"],
      ) {
        yield* requireAdmin(roles)
        const row = yield* requireDestinationRow(orgId, destinationId)
        const result = yield* sendImmediateNotification(row, {
          deliveryKey: `${orgId}:${destinationId}:test`,
          ruleId: decodeAlertRuleIdSync(makeUuid()),
          ruleName: "Test alert",
          groupKey: null,
          signalType: "throughput",
          severity: "warning",
          comparator: "lt",
          threshold: 1,
          windowMinutes: 5,
          eventType: "test",
          incidentId: null,
          incidentStatus: "resolved",
          dedupeKey: `${orgId}:${destinationId}:test`,
          value: 0,
          sampleCount: 0,
          linkUrl: composeLinkUrl(null),
        }).pipe(
          Effect.tapError((error) => {
            const message =
              error instanceof AlertDeliveryError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : "Destination test failed"
            return markDestinationTest(orgId, destinationId, message)
          }),
          Effect.mapError((error) =>
            error instanceof AlertDeliveryError
              ? error
              : makeDeliveryError(
                  error instanceof Error ? error.message : "Destination test failed",
                  decodeAlertDestinationTypeSync(row.type),
                ),
          ),
        )

        yield* markDestinationTest(orgId, destinationId, null)
        return new AlertDestinationTestResponse({
          success: true,
          message: "Test notification sent",
        })
      })

      const upsertRuleRow = Effect.fn("AlertsService.upsertRuleRow")(function* (
        orgId: OrgId,
        userId: UserId,
        existingId: AlertRuleId | null,
        request: AlertRuleUpsertRequest,
      ) {
        const normalized = yield* normalizeRule(request)
        yield* requireDestinationIds(orgId, normalized.destinationIds)
        const ruleId = existingId ?? normalized.id
        const timestamp = now()

        const ruleFields = {
          name: normalized.name,
          enabled: normalized.enabled ? 1 : 0,
          severity: normalized.severity,
          serviceNamesJson: normalized.serviceNames.length > 0 ? JSON.stringify(normalized.serviceNames) : null,
          excludeServiceNamesJson: normalized.excludeServiceNames.length > 0 ? JSON.stringify(normalized.excludeServiceNames) : null,
          groupBy: normalized.groupBy != null ? JSON.stringify(normalized.groupBy) : null,
          signalType: normalized.signalType,
          comparator: normalized.comparator,
          threshold: normalized.threshold,
          windowMinutes: normalized.windowMinutes,
          minimumSampleCount: normalized.minimumSampleCount,
          consecutiveBreachesRequired: normalized.consecutiveBreachesRequired,
          consecutiveHealthyRequired: normalized.consecutiveHealthyRequired,
          renotifyIntervalMinutes: normalized.renotifyIntervalMinutes,
          metricName: normalized.metricName,
          metricType: normalized.metricType,
          metricAggregation: normalized.metricAggregation,
          apdexThresholdMs: normalized.apdexThresholdMs,
          queryDataSource: normalized.queryDataSource,
          queryAggregation: normalized.queryAggregation,
          queryWhereClause: normalized.queryWhereClause,
          destinationIdsJson: JSON.stringify(normalized.destinationIds),
          querySpecJson: JSON.stringify(normalized.compiledPlan.query),
          reducer: normalized.compiledPlan.reducer,
          sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
          noDataBehavior: normalized.compiledPlan.noDataBehavior,
          updatedAt: timestamp,
          updatedBy: userId,
        } as const

        if (existingId == null) {
          yield* dbExecute((db) =>
            db.insert(alertRules).values({
              id: ruleId,
              orgId,
              ...ruleFields,
              createdAt: timestamp,
              createdBy: userId,
            }),
          )
        } else {
          yield* dbExecute((db) =>
            db
              .update(alertRules)
              .set(ruleFields)
              .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, existingId))),
          )
        }

        const row = yield* requireRuleRow(orgId, decodeAlertRuleIdSync(ruleId))
        const destinationIds = safeParseStringArray(row.destinationIdsJson)
        return rowToRuleDocument(row, destinationIds)
      })

      const listRules = Effect.fn("AlertsService.listRules")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertRules)
            .where(eq(alertRules.orgId, orgId))
            .orderBy(desc(alertRules.updatedAt)),
        )

        const rules = rows.map((row) =>
          rowToRuleDocument(row, safeParseStringArray(row.destinationIdsJson)),
        )

        return new AlertRulesListResponse({ rules })
      })

      const createRule = Effect.fn("AlertsService.createRule")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        request: AlertRuleUpsertRequest,
      ) {
        yield* requireAdmin(roles)
        return yield* upsertRuleRow(orgId, userId, null, request)
      })

      const updateRule = Effect.fn("AlertsService.updateRule")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        ruleId: AlertRuleDocument["id"],
        request: AlertRuleUpsertRequest,
      ) {
        yield* requireAdmin(roles)
        const oldRow = yield* requireRuleRow(orgId, ruleId)
        const result = yield* upsertRuleRow(orgId, userId, ruleId, request)

        // Resolve stale incidents caused by the configuration change
        const oldNormalized = yield* normalizeRuleRow(oldRow)
        const newNormalized = yield* normalizeRule(request)

        if (oldNormalized.enabled && !newNormalized.enabled) {
          // Rule was disabled — resolve all open incidents
          yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { resolveAll: true })
        } else if (ruleStructureChanged(oldNormalized, newNormalized)) {
          // Evaluation mode changed — resolve all and let scheduler re-evaluate fresh
          yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { resolveAll: true })
        } else {
          // Check for services that fell out of scope
          const staleGroupKeys = computeStaleGroupKeys(oldNormalized, newNormalized)
          if (HashSet.size(staleGroupKeys) > 0) {
            yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { staleGroupKeys })
          }
        }

        return result
      })

      const deleteRule = Effect.fn("AlertsService.deleteRule")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
        ruleId: AlertRuleDocument["id"],
      ) {
        yield* requireAdmin(roles)
        yield* requireRuleRow(orgId, ruleId)
        yield* dbExecute((db) =>
          db.batch([
            db.delete(alertDeliveryEvents).where(and(eq(alertDeliveryEvents.orgId, orgId), eq(alertDeliveryEvents.ruleId, ruleId))),
            db.delete(alertIncidents).where(and(eq(alertIncidents.orgId, orgId), eq(alertIncidents.ruleId, ruleId))),
            db.delete(alertRuleStates).where(and(eq(alertRuleStates.orgId, orgId), eq(alertRuleStates.ruleId, ruleId))),
            db.delete(alertRules).where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId))),
          ]),
        )
        return new AlertRuleDeleteResponse({ id: ruleId })
      })

      const testRule = Effect.fn("AlertsService.testRule")(function* (
        orgId: OrgId,
        userId: UserId,
        roles: ReadonlyArray<RoleName>,
        request: AlertRuleUpsertRequest,
        sendNotification = false,
      ) {
        yield* requireAdmin(roles)
        const normalized = yield* normalizeRule(request)
        yield* requireDestinationIds(orgId, normalized.destinationIds)

        let evaluation: EvaluatedRule
        if (normalized.groupBy != null && normalized.serviceNames.length === 0) {
          const allResults = yield* evaluateRule(orgId, normalized)
          const excludeSet = new Set(normalized.excludeServiceNames)
          const results = allResults.filter((r) => !excludeSet.has(r.groupKey))
          const breached = results.find((r) => r.evaluation.status === "breached")
          evaluation = breached?.evaluation ?? results[0]?.evaluation ?? {
            status: "skipped" as const,
            value: null,
            sampleCount: 0,
            threshold: normalized.threshold,
            comparator: normalized.comparator,
            reason: "No groups found",
          }
        } else if (normalized.serviceNames.length > 1) {
          const results = yield* Effect.forEach(
            normalized.serviceNames,
            (svcName) =>
              Effect.gen(function* () {
                const perServicePlan = yield* compileRulePlan({ ...normalized, serviceName: svcName })
                const observations = yield* evaluateRule(orgId, { ...normalized, serviceName: svcName, compiledPlan: perServicePlan })
                return observations[0]?.evaluation ?? {
                  status: "skipped" as const,
                  value: null,
                  sampleCount: 0,
                  threshold: normalized.threshold,
                  comparator: normalized.comparator,
                  reason: "No data",
                }
              }),
            { concurrency: 5 },
          )
          evaluation = results.find((r) => r.status === "breached") ?? results[0] ?? {
            status: "skipped" as const,
            value: null,
            sampleCount: 0,
            threshold: normalized.threshold,
            comparator: normalized.comparator,
            reason: "No data",
          }
        } else {
          const observations = yield* evaluateRule(orgId, normalized)
          evaluation = observations[0]?.evaluation ?? {
            status: "skipped" as const,
            value: null,
            sampleCount: 0,
            threshold: normalized.threshold,
            comparator: normalized.comparator,
            reason: "No data",
          }
        }

        if (sendNotification) {
          const rows = yield* dbExecute((db) =>
            db
              .select()
              .from(alertDestinations)
              .where(
                and(
                  eq(alertDestinations.orgId, orgId),
                  inArray(alertDestinations.id, [...normalized.destinationIds]),
                ),
              ),
          )
          const byId = new Map(rows.map((row) => [row.id, row]))
          const enabledDestinations = normalized.destinationIds
            .map((id) => ({ id, row: byId.get(id) }))
            .filter((d): d is { id: AlertDestinationId; row: AlertDestinationRow } => d.row != null && d.row.enabled === 1)

          yield* Effect.forEach(
            enabledDestinations,
            ({ id: destinationId, row: destination }) =>
              sendImmediateNotification(destination, {
                deliveryKey: `${orgId}:${destinationId}:rule-test`,
                ruleId: decodeAlertRuleIdSync(makeUuid()),
                ruleName: normalized.name,
                groupKey: null,
                signalType: normalized.signalType,
                severity: normalized.severity,
                comparator: normalized.comparator,
                threshold: normalized.threshold,
                windowMinutes: normalized.windowMinutes,
                eventType: "test",
                incidentId: null,
                incidentStatus: "resolved",
                dedupeKey: `${orgId}:${destinationId}:rule-test`,
                value: evaluation.value,
                sampleCount: evaluation.sampleCount,
                linkUrl: resolveNotificationLinkUrl(normalized, null),
              }),
            { concurrency: "unbounded" },
          )
        }

        return new AlertEvaluationResult(evaluation)
      })

      const listIncidents = Effect.fn("AlertsService.listIncidents")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertIncidents)
            .where(eq(alertIncidents.orgId, orgId))
            .orderBy(desc(alertIncidents.status), desc(alertIncidents.lastTriggeredAt))
            .limit(100),
        )
        return new AlertIncidentsListResponse({
          incidents: rows.map(rowToIncidentDocument),
        })
      })

      const listDeliveryEvents = Effect.fn("AlertsService.listDeliveryEvents")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertDeliveryEvents)
            .where(eq(alertDeliveryEvents.orgId, orgId))
            .orderBy(desc(alertDeliveryEvents.createdAt))
            .limit(100),
        )

        const destinationRows = yield* dbExecute((db) =>
          db
            .select({
              id: alertDestinations.id,
              name: alertDestinations.name,
              type: alertDestinations.type,
            })
            .from(alertDestinations)
            .where(eq(alertDestinations.orgId, orgId)),
        )
        const destinationMap = new Map(
          destinationRows.map((row) => [row.id, row]),
        )

        const events = rows.map((row) => {
          const destination = destinationMap.get(row.destinationId)
          return new AlertDeliveryEventDocument({
            id: decodeAlertDeliveryEventIdSync(row.id),
            incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
            ruleId: decodeAlertRuleIdSync(row.ruleId),
            destinationId: decodeAlertDestinationIdSync(row.destinationId),
            destinationName: destination?.name ?? "Deleted destination",
            destinationType:
              destination?.type != null ? decodeAlertDestinationTypeSync(destination.type) : decodeAlertDestinationTypeSync("webhook"),
            deliveryKey: row.deliveryKey,
            eventType: decodeAlertEventTypeSync(row.eventType),
            attemptNumber: row.attemptNumber,
            status: decodeAlertDeliveryStatusSync(row.status),
            scheduledAt: decodeIsoDateTimeStringSync(
              new Date(row.scheduledAt).toISOString(),
            ),
            attemptedAt: toIso(row.attemptedAt),
            providerMessage: row.providerMessage,
            providerReference: row.providerReference,
            responseCode: row.responseCode,
            errorMessage: row.errorMessage,
          })
        })

        return new AlertDeliveryEventsListResponse({ events })
      })

      const claimableDeliveryWhere = (currentTime: number) =>
        or(
          and(
            eq(alertDeliveryEvents.status, "queued"),
            sql`${alertDeliveryEvents.scheduledAt} <= ${currentTime}`,
          ),
          and(
            eq(alertDeliveryEvents.status, "processing"),
            sql`${alertDeliveryEvents.claimExpiresAt} IS NOT NULL`,
            sql`${alertDeliveryEvents.claimExpiresAt} <= ${currentTime}`,
          ),
        )

      const claimDeliveryEvent = (deliveryEventId: string, currentTime: number) =>
        dbExecute((db) =>
          db
            .update(alertDeliveryEvents)
            .set({
              status: "processing",
              claimedAt: currentTime,
              claimExpiresAt: currentTime + DELIVERY_LEASE_TTL_MS,
              claimedBy: workerId,
              updatedAt: currentTime,
            })
            .where(
              and(
                eq(alertDeliveryEvents.id, deliveryEventId),
                claimableDeliveryWhere(currentTime),
              ),
            ),
        )

      const finalizeClaimedDelivery = (
        deliveryEventId: string,
        currentTime: number,
        fields: Partial<AlertDeliveryEventRow> & {
          readonly status: "success" | "failed"
        },
      ) =>
        dbExecute((db) =>
          db
            .update(alertDeliveryEvents)
            .set({
              ...fields,
              claimedAt: null,
              claimExpiresAt: null,
              claimedBy: null,
              updatedAt: currentTime,
            })
            .where(
              and(
                eq(alertDeliveryEvents.id, deliveryEventId),
                eq(alertDeliveryEvents.status, "processing"),
                eq(alertDeliveryEvents.claimedBy, workerId),
              ),
            ),
        )

      const recordDeliveryFailure = (
        row: AlertDeliveryEventRow,
        currentTime: number,
        failure: DeliveryAttemptFailure,
      ) =>
        Effect.gen(function* () {
          yield* finalizeClaimedDelivery(row.id, currentTime, {
            status: "failed",
            attemptedAt: currentTime,
            errorMessage: failure.message,
          })
          yield* Effect.logWarning("Alert delivery attempt failed").pipe(
            Effect.annotateLogs({
              workerId,
              deliveryKey: row.deliveryKey,
              attemptNumber: row.attemptNumber,
              destinationId: row.destinationId,
              failureKind: failure.kind,
              errorMessage: failure.message,
            }),
          )
        })

      const processQueuedDeliveries = Effect.fn(
        "AlertsService.processQueuedDeliveries",
      )(function* () {
        const currentTime = now()
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertDeliveryEvents)
            .where(claimableDeliveryWhere(currentTime))
            .orderBy(asc(alertDeliveryEvents.scheduledAt)),
        )

        if (rows.length === 0) {
          return {
            processedCount: 0,
            failureCount: 0,
          }
        }

        const uniqueDestinationIds = [...new Set(rows.map((r) => r.destinationId))]
        const uniqueRuleIds = [...new Set(rows.map((r) => r.ruleId))]
        const uniqueIncidentIds = [...new Set(rows.filter((r) => r.incidentId != null).map((r) => r.incidentId!))]

        const [allDestinations, allRules, allIncidents] = yield* Effect.all([
          dbExecute((db) =>
            db.select().from(alertDestinations).where(inArray(alertDestinations.id, uniqueDestinationIds)),
          ),
          dbExecute((db) =>
            db.select().from(alertRules).where(inArray(alertRules.id, uniqueRuleIds)),
          ),
          uniqueIncidentIds.length > 0
            ? dbExecute((db) =>
                db.select().from(alertIncidents).where(inArray(alertIncidents.id, uniqueIncidentIds)),
              )
            : Effect.succeed([] as AlertIncidentRow[]),
        ], { concurrency: "unbounded" })

        const destinationMap = new Map(allDestinations.map((r) => [r.id, r]))
        const ruleMap = new Map(allRules.map((r) => [r.id, r]))
        const incidentMap = new Map(allIncidents.map((r) => [r.id, r]))

        let processedCount = 0
        let failureCount = 0

        const processOneDelivery = Effect.fn("AlertsService.processOneDelivery")(function* (
          row: AlertDeliveryEventRow,
        ) {
          const claimed = yield* claimDeliveryEvent(row.id, currentTime)
          if (claimed.rowsAffected === 0) return

          processedCount += 1
          yield* Metric.update(AlertingMetrics.deliveriesAttemptedTotal, 1)

          const destinationRow = destinationMap.get(row.destinationId)
          if (!destinationRow) {
            failureCount += 1
            yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
            yield* recordDeliveryFailure(row, currentTime, { message: "Destination not found", kind: "destination", retryable: false })
            return
          }

          if (destinationRow.enabled !== 1) {
            failureCount += 1
            yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
            yield* recordDeliveryFailure(row, currentTime, { message: "Destination disabled", kind: "destination", retryable: false })
            return
          }

          const payload = yield* parseDeliveryPayload(row.payloadJson)
          const hydrated = yield* hydrateDestination(destinationRow)
          const incidentRow: AlertIncidentRow | null = row.incidentId != null
            ? incidentMap.get(row.incidentId) ?? null
            : null
          const ruleRow = ruleMap.get(row.ruleId) ?? null
          const payloadRule = payload.rule
          const ruleServiceNames = ruleRow ? serviceNamesFromRow(ruleRow) : []
          const ruleGroupBy = ruleRow ? parseStoredGroupBy(ruleRow.groupBy) : null
          const groupKey = incidentRow?.groupKey ?? payloadRule?.groupKey ?? null

          const deliveryStart = now()
          const result = yield* dispatchDelivery(
            {
              deliveryKey: row.deliveryKey,
              destination: hydrated.row,
              publicConfig: hydrated.publicConfig,
              secretConfig: hydrated.secretConfig,
              ruleId: decodeAlertRuleIdSync(row.ruleId),
              ruleName: ruleRow?.name ?? String(payloadRule?.name ?? "Alert"),
              groupKey,
              signalType: decodeAlertSignalTypeSync(incidentRow?.signalType ?? payloadRule?.signalType ?? "throughput"),
              severity: decodeAlertSeveritySync(incidentRow?.severity ?? payloadRule?.severity ?? "warning"),
              comparator: decodeAlertComparatorSync(incidentRow?.comparator ?? payloadRule?.comparator ?? "gt"),
              threshold: incidentRow?.threshold ?? payloadRule?.threshold ?? 0,
              windowMinutes: ruleRow?.windowMinutes ?? payloadRule?.windowMinutes ?? 5,
              eventType: decodeAlertEventTypeSync(row.eventType),
              incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
              incidentStatus: decodeAlertIncidentStatusSync(incidentRow?.status ?? "resolved"),
              dedupeKey: incidentRow?.dedupeKey ?? String(payload.dedupeKey ?? row.deliveryKey),
              value: payload.observed?.value ?? null,
              sampleCount: payload.observed?.sampleCount ?? null,
              linkUrl: resolveNotificationLinkUrl({ serviceNames: ruleServiceNames, groupBy: ruleGroupBy }, groupKey),
            },
            row.payloadJson,
          )
          yield* Metric.update(AlertingMetrics.deliveryAttemptDurationMs, now() - deliveryStart)
          yield* Metric.update(AlertingMetrics.deliveriesSucceededTotal, 1)

          yield* finalizeClaimedDelivery(row.id, currentTime, {
            status: "success",
            attemptedAt: currentTime,
            providerMessage: result.providerMessage,
            providerReference: result.providerReference,
            responseCode: result.responseCode,
            errorMessage: null,
          })

          if (row.incidentId) {
            yield* dbExecute((db) =>
              db
                .update(alertIncidents)
                .set({
                  lastDeliveredEventType: row.eventType,
                  lastNotifiedAt: currentTime,
                  updatedAt: currentTime,
                })
                .where(eq(alertIncidents.id, row.incidentId!)),
            )
          }

          yield* Effect.logInfo("Alert delivery attempt succeeded").pipe(
            Effect.annotateLogs({
              workerId,
              deliveryKey: row.deliveryKey,
              attemptNumber: row.attemptNumber,
              destinationId: row.destinationId,
              responseCode: result.responseCode,
            }),
          )
        })

        for (const row of rows) {
          yield* processOneDelivery(row).pipe(
            Effect.catch((error) => {
              const failure = toDeliveryAttemptFailure(error)
              failureCount += 1
              return Effect.gen(function* () {
                yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
                yield* finalizeClaimedDelivery(row.id, currentTime, {
                  status: "failed",
                  attemptedAt: currentTime,
                  errorMessage: failure.message,
                })

                if (failure.retryable && row.attemptNumber < MAX_DELIVERY_ATTEMPTS) {
                  yield* insertDeliveryEvent(
                    row.orgId as OrgId,
                    row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
                    decodeAlertRuleIdSync(row.ruleId),
                    decodeAlertDestinationIdSync(row.destinationId),
                    decodeAlertEventTypeSync(row.eventType),
                    {} as Record<string, unknown>,
                    currentTime + computeRetryDelayMs(row.attemptNumber),
                    row.deliveryKey,
                    row.attemptNumber + 1,
                  )
                }

                yield* Effect.logWarning("Alert delivery attempt failed").pipe(
                  Effect.annotateLogs({
                    workerId,
                    deliveryKey: row.deliveryKey,
                    attemptNumber: row.attemptNumber,
                    destinationId: row.destinationId,
                    failureKind: failure.kind,
                    errorMessage: failure.message,
                    willRetry:
                      failure.retryable && row.attemptNumber < MAX_DELIVERY_ATTEMPTS,
                  }),
                )
              })
            }),
          )
        }

        return {
          processedCount,
          failureCount,
        }
      })

      const processEvaluation = Effect.fn("AlertsService.processEvaluation")(function* (
        row: AlertRuleRow,
        normalized: NormalizedRule,
        evaluation: EvaluatedRule,
        groupKey: string,
        timestamp: number,
      ) {
        const stateConflictTarget: [typeof alertRuleStates.orgId, typeof alertRuleStates.ruleId, typeof alertRuleStates.groupKey] = [alertRuleStates.orgId, alertRuleStates.ruleId, alertRuleStates.groupKey]

        let incidentAction = "none" as string
        // Serialized per rule via the claim lock at runSchedulerTick (SCHEDULER_LOCK_TTL_MS
        // CAS on alertRules.lastScheduledAt). All writes below are idempotent on retry:
        // state upsert via onConflictDoUpdate, incident insert keyed on unique incidentKey,
        // delivery events via onConflictDoNothing on deliveryKey.
        yield* dbExecute(async (db) => {
          const state =
            (
              await db
                .select()
                .from(alertRuleStates)
                .where(
                  and(
                    eq(alertRuleStates.orgId, row.orgId),
                    eq(alertRuleStates.ruleId, row.id),
                    eq(alertRuleStates.groupKey, groupKey),
                  ),
                )
                .limit(1)
            )[0] ?? null

          // Look up the open incident for this group via the unique
          // (orgId, ruleId, status, groupKey) combination. The legacy
          // serviceName-based filter is gone — composite group keys make
          // serviceName ambiguous, and we now persist groupKey directly.
          const openIncident =
            (
              await db
                .select()
                .from(alertIncidents)
                .where(
                  and(
                    eq(alertIncidents.orgId, row.orgId),
                    eq(alertIncidents.ruleId, row.id),
                    eq(alertIncidents.status, "open"),
                    eq(alertIncidents.groupKey, groupKey),
                  ),
                )
                .limit(1)
            )[0] ?? null

          const upsertState = (fields: {
            consecutiveBreaches: number
            consecutiveHealthy: number
            lastStatus: string
            lastValue: number | null
            lastSampleCount: number
          }) =>
            db
              .insert(alertRuleStates)
              .values({
                orgId: row.orgId,
                ruleId: row.id,
                groupKey,
                ...fields,
                lastEvaluatedAt: timestamp,
                lastError: null,
                updatedAt: timestamp,
              })
              .onConflictDoUpdate({
                target: stateConflictTarget,
                set: {
                  ...fields,
                  lastEvaluatedAt: timestamp,
                  lastError: null,
                  updatedAt: timestamp,
                },
              })

          if (evaluation.status === "skipped") {
            await upsertState({
              consecutiveBreaches: state?.consecutiveBreaches ?? 0,
              consecutiveHealthy: state?.consecutiveHealthy ?? 0,
              lastStatus: evaluation.status,
              lastValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
            })
            return
          }

          const consecutiveBreaches =
            evaluation.status === "breached"
              ? (state?.consecutiveBreaches ?? 0) + 1
              : 0
          const consecutiveHealthy =
            evaluation.status === "healthy"
              ? (state?.consecutiveHealthy ?? 0) + 1
              : 0

          await upsertState({
            consecutiveBreaches,
            consecutiveHealthy,
            lastStatus: evaluation.status,
            lastValue: evaluation.value,
            lastSampleCount: evaluation.sampleCount,
          })

          if (
            evaluation.status === "breached" &&
            openIncident == null &&
            consecutiveBreaches >= normalized.consecutiveBreachesRequired
          ) {
            const incidentId = makeUuid()
            const incidentKey = `${row.orgId}:${row.id}:${groupKey}`
            const incident: AlertIncidentRow = {
              id: incidentId,
              orgId: row.orgId,
              ruleId: row.id,
              incidentKey,
              ruleName: row.name,
              groupKey,
              signalType: normalized.signalType,
              severity: normalized.severity,
              status: "open",
              comparator: normalized.comparator,
              threshold: normalized.threshold,
              firstTriggeredAt: timestamp,
              lastTriggeredAt: timestamp,
              resolvedAt: null,
              lastObservedValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
              lastEvaluatedAt: timestamp,
              dedupeKey: incidentKey,
              lastDeliveredEventType: null,
              lastNotifiedAt: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }

            await db.insert(alertIncidents).values(incident)
            await queueIncidentNotificationsOnDb(
              db,
              row.orgId as OrgId,
              normalized,
              incident,
              evaluation,
              "trigger",
              timestamp,
            )
            incidentAction = "opened"
            return
          }

          if (evaluation.status === "breached" && openIncident != null) {
            const refreshedIncident = {
              ...openIncident,
              lastTriggeredAt: timestamp,
              lastObservedValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
              lastEvaluatedAt: timestamp,
              updatedAt: timestamp,
            }

            await db
              .update(alertIncidents)
              .set({
                lastTriggeredAt: timestamp,
                lastObservedValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, openIncident.id))

            const renotifyDueAt =
              (openIncident.lastNotifiedAt ?? openIncident.firstTriggeredAt) +
              normalized.renotifyIntervalMinutes * 60_000
            if (renotifyDueAt <= timestamp) {
              await queueIncidentNotificationsOnDb(
                db,
                row.orgId as OrgId,
                normalized,
                refreshedIncident,
                evaluation,
                "renotify",
                timestamp,
              )
            }
            return
          }

          if (
            evaluation.status === "healthy" &&
            openIncident != null &&
            consecutiveHealthy >= normalized.consecutiveHealthyRequired
          ) {
            const resolvedIncident = {
              ...openIncident,
              status: "resolved" as const,
              resolvedAt: timestamp,
              lastObservedValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
              lastEvaluatedAt: timestamp,
              updatedAt: timestamp,
            }

            await db
              .update(alertIncidents)
              .set({
                status: "resolved",
                resolvedAt: timestamp,
                lastObservedValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, openIncident.id))

            await queueIncidentNotificationsOnDb(
              db,
              row.orgId as OrgId,
              normalized,
              resolvedIncident,
              evaluation,
              "resolve",
              timestamp,
            )
            incidentAction = "resolved"
          }
        })
        if (incidentAction === "opened") yield* Metric.update(AlertingMetrics.incidentsOpenedTotal, 1)
        if (incidentAction === "resolved") yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, 1)
      })

      /* -------------------------------------------------------------------------- */
      /*  Stale incident resolution                                               */
      /* -------------------------------------------------------------------------- */

      const computeStaleGroupKeys = (
        oldRule: NormalizedRule,
        newRule: NormalizedRule,
      ): HashSet.HashSet<string> => {
        const removedServices = HashSet.difference(
          HashSet.fromIterable(oldRule.serviceNames),
          HashSet.fromIterable(newRule.serviceNames),
        )
        const newlyExcluded = HashSet.difference(
          HashSet.fromIterable(newRule.excludeServiceNames),
          HashSet.fromIterable(oldRule.excludeServiceNames),
        )
        return HashSet.union(removedServices, newlyExcluded)
      }

      const groupByEqual = (
        a: AlertGroupBy | null,
        b: AlertGroupBy | null,
      ): boolean => {
        if (a == null || b == null) return a == null && b == null
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return false
        }
        return true
      }

      const ruleStructureChanged = (
        oldRule: NormalizedRule,
        newRule: NormalizedRule,
      ): boolean => {
        if (!groupByEqual(oldRule.groupBy, newRule.groupBy)) return true
        if (oldRule.signalType !== newRule.signalType) return true
        const mode = (r: NormalizedRule) =>
          r.groupBy != null ? "grouped"
            : r.serviceNames.length > 1 ? "multi"
            : "single"
        return mode(oldRule) !== mode(newRule)
      }

      const makeSyntheticResolveEvaluation = (normalized: NormalizedRule, reason: string): EvaluatedRule => ({
        status: "healthy",
        value: null,
        sampleCount: 0,
        threshold: normalized.threshold,
        comparator: normalized.comparator,
        reason,
      })

      const resolveStaleIncidents = Effect.fn("AlertsService.resolveStaleIncidents")(function* (
        orgId: OrgId,
        ruleId: AlertRuleId,
        normalized: NormalizedRule,
        opts: {
          readonly staleGroupKeys?: HashSet.HashSet<string>
          readonly resolveAll?: boolean
        },
      ) {
        const openIncidents = yield* dbExecute((db) =>
          db
            .select()
            .from(alertIncidents)
            .where(
              and(
                eq(alertIncidents.orgId, orgId),
                eq(alertIncidents.ruleId, ruleId),
                eq(alertIncidents.status, "open"),
              ),
            ),
        )

        const toResolve = opts.resolveAll
          ? openIncidents
          : Arr.filter(openIncidents, (i) =>
            i.groupKey != null && (opts.staleGroupKeys
              ? HashSet.has(opts.staleGroupKeys, i.groupKey)
              : false),
          )

        if (toResolve.length === 0) return

        const timestamp = now()
        const syntheticEvaluation = makeSyntheticResolveEvaluation(
          normalized,
          "Auto-resolved: rule configuration changed",
        )
        const staleGroupKeys = Arr.map(toResolve, (i) => i.groupKey ?? "__total__")

        // Serialized per rule via the claim lock + idempotent writes
        // (incident status update converges; delivery events onConflictDoNothing).
        yield* dbExecute(async (db) => {
          for (const incident of toResolve) {
            const resolvedIncident = {
              ...incident,
              status: "resolved" as const,
              resolvedAt: timestamp,
              updatedAt: timestamp,
            }

            await db
              .update(alertIncidents)
              .set({
                status: "resolved",
                resolvedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, incident.id))

            await queueIncidentNotificationsOnDb(
              db,
              orgId,
              normalized,
              resolvedIncident,
              syntheticEvaluation,
              "resolve",
              timestamp,
            )
          }

          if (opts.resolveAll) {
            await db
              .delete(alertRuleStates)
              .where(
                and(
                  eq(alertRuleStates.orgId, orgId),
                  eq(alertRuleStates.ruleId, ruleId),
                ),
              )
          } else if (staleGroupKeys.length > 0) {
            await db
              .delete(alertRuleStates)
              .where(
                and(
                  eq(alertRuleStates.orgId, orgId),
                  eq(alertRuleStates.ruleId, ruleId),
                  inArray(alertRuleStates.groupKey, staleGroupKeys),
                ),
              )
          }
        })

        yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, toResolve.length)
        yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, toResolve.length)
      })

      const resolveOrphanedGroupIncidents = Effect.fn(
        "AlertsService.resolveOrphanedGroupIncidents",
      )(function* (
        orgId: OrgId,
        ruleId: AlertRuleId,
        normalized: NormalizedRule,
        evaluatedGroups: HashSet.HashSet<string>,
        timestamp: number,
      ) {
        const openIncidents = yield* dbExecute((db) =>
          db
            .select()
            .from(alertIncidents)
            .where(
              and(
                eq(alertIncidents.orgId, orgId),
                eq(alertIncidents.ruleId, ruleId),
                eq(alertIncidents.status, "open"),
              ),
            ),
        )

        const orphaned = Arr.filter(openIncidents, (i) =>
          !HashSet.has(evaluatedGroups, i.groupKey ?? "__total__"),
        )

        if (orphaned.length === 0) return

        const syntheticEvaluation = makeSyntheticResolveEvaluation(
          normalized,
          "Auto-resolved: group no longer appears in evaluation results",
        )

        // Serialized per rule via claim lock + idempotent writes.
        yield* Effect.forEach(orphaned, (incident) => {
          const groupKey = incident.groupKey ?? "__total__"
          return dbExecute(async (db) => {
            await db
              .update(alertIncidents)
              .set({
                status: "resolved",
                resolvedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, incident.id))

            await queueIncidentNotificationsOnDb(
              db,
              orgId,
              normalized,
              { ...incident, status: "resolved", resolvedAt: timestamp, updatedAt: timestamp },
              syntheticEvaluation,
              "resolve",
              timestamp,
            )

            await db
              .delete(alertRuleStates)
              .where(
                and(
                  eq(alertRuleStates.orgId, orgId),
                  eq(alertRuleStates.ruleId, ruleId),
                  eq(alertRuleStates.groupKey, groupKey),
                ),
              )
          })
        })

        yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, orphaned.length)
        yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, orphaned.length)
      })

      const SCHEDULER_LOCK_TTL_MS = 30_000

      const claimRule = (ruleId: AlertRuleId, timestamp: number) =>
        dbExecute((db) =>
          db
            .update(alertRules)
            .set({ lastScheduledAt: timestamp })
            .where(
              and(
                eq(alertRules.id, ruleId),
                sql`(${alertRules.lastScheduledAt} IS NULL OR ${alertRules.lastScheduledAt} < ${timestamp - SCHEDULER_LOCK_TTL_MS})`,
              ),
            ),
        )

      const recordEvaluationStatus = (evaluation: EvaluatedRule) => {
        switch (evaluation.status) {
          case "breached": return Metric.update(AlertingMetrics.rulesBreachedTotal, 1)
          case "healthy": return Metric.update(AlertingMetrics.rulesHealthyTotal, 1)
          case "skipped": return Metric.update(AlertingMetrics.rulesSkippedTotal, 1)
        }
      }

      const runSchedulerTick = Effect.fn("AlertsService.runSchedulerTick")(function* () {
        const tickStart = now()
        const rows = yield* dbExecute((db) =>
          db
            .select()
            .from(alertRules)
            .where(eq(alertRules.enabled, 1))
            .orderBy(asc(alertRules.updatedAt)),
        )
        yield* Metric.update(AlertingMetrics.activeRulesGauge, rows.length)

        let evaluationFailureCount = 0

        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const timestamp = now()
              const brandedRuleId = decodeAlertRuleIdSync(row.id)
              const claimed = yield* claimRule(brandedRuleId, timestamp)
              if (claimed.rowsAffected === 0) return

              yield* Effect.gen(function* () {
                const ruleStart = now()
                const normalized = yield* normalizeRuleRow(row)

                if (normalized.groupBy != null && normalized.serviceNames.length === 0) {
                  const results = yield* evaluateRule(row.orgId as OrgId, normalized)
                  const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
                  const eligible = Arr.filter(results, (r) => !HashSet.has(excludeSet, r.groupKey))

                  yield* Effect.forEach(eligible, ({ evaluation, groupKey }) =>
                    Effect.gen(function* () {
                      yield* recordEvaluationStatus(evaluation)
                      yield* processEvaluation(row, normalized, evaluation, groupKey, timestamp)
                    }))

                  const evaluatedGroups = HashSet.fromIterable(Arr.map(eligible, (r) => r.groupKey))
                  yield* resolveOrphanedGroupIncidents(
                    row.orgId as OrgId,
                    normalized.id,
                    normalized,
                    evaluatedGroups,
                    timestamp,
                  )
                  yield* Metric.update(AlertingMetrics.ruleEvaluationDurationMs, now() - ruleStart)
                  return
                }

                if (normalized.serviceNames.length > 1) {
                  yield* Effect.forEach(normalized.serviceNames, (svcName) =>
                    Effect.gen(function* () {
                      const perServicePlan = yield* compileRulePlan({
                        ...normalized,
                        serviceName: svcName,
                      })
                      const perService = {
                        ...normalized,
                        serviceName: svcName,
                        compiledPlan: perServicePlan,
                      }
                      const observations = yield* evaluateRule(row.orgId as OrgId, perService)
                      const evaluation = observations[0]?.evaluation
                      if (evaluation == null) return
                      yield* recordEvaluationStatus(evaluation)
                      yield* processEvaluation(row, normalized, evaluation, svcName, timestamp)
                    }))

                  yield* resolveOrphanedGroupIncidents(
                    row.orgId as OrgId,
                    normalized.id,
                    normalized,
                    HashSet.fromIterable(normalized.serviceNames),
                    timestamp,
                  )
                  yield* Metric.update(AlertingMetrics.ruleEvaluationDurationMs, now() - ruleStart)
                  return
                }

                const observations = yield* evaluateRule(row.orgId as OrgId, normalized)
                const evaluation = observations[0]?.evaluation
                if (evaluation != null) {
                  yield* recordEvaluationStatus(evaluation)
                  yield* processEvaluation(
                    row,
                    normalized,
                    evaluation,
                    "__total__",
                    timestamp,
                  )
                }
                yield* Metric.update(AlertingMetrics.ruleEvaluationDurationMs, now() - ruleStart)
              }).pipe(
                Effect.catch((error) => {
                  evaluationFailureCount += 1
                  return Effect.gen(function* () {
                    yield* Metric.update(AlertingMetrics.evaluationFailuresTotal, 1)
                    yield* Effect.logError("Alert rule evaluation failed").pipe(
                      Effect.annotateLogs({
                        workerId,
                        ruleId: row.id,
                        orgId: row.orgId,
                        failureCategory:
                          error instanceof AlertValidationError
                            ? "validation"
                            : error instanceof AlertDeliveryError
                              ? "evaluation"
                              : "unknown",
                        errorMessage:
                          error instanceof Error ? error.message : "Alert rule evaluation failed",
                      }),
                    )
                  })
                }),
              )
            }),
          { concurrency: 5 },
        )

        // Resolve stale incidents for disabled rules
        const disabledRulesWithOpenIncidents = yield* dbExecute((db) =>
          db
            .selectDistinct({ ruleId: alertIncidents.ruleId, orgId: alertIncidents.orgId })
            .from(alertIncidents)
            .innerJoin(alertRules, eq(alertIncidents.ruleId, alertRules.id))
            .where(
              and(
                eq(alertIncidents.status, "open"),
                eq(alertRules.enabled, 0),
              ),
            ),
        )
        yield* Effect.forEach(disabledRulesWithOpenIncidents, ({ ruleId, orgId }) =>
          Effect.gen(function* () {
            const ruleRow = (yield* dbExecute((db) =>
              db.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1),
            ))[0]
            if (!ruleRow) return
            const normalized = yield* normalizeRuleRow(ruleRow)
            yield* resolveStaleIncidents(orgId as OrgId, normalized.id, normalized, { resolveAll: true })
          }))

        const deliveryResult = yield* processQueuedDeliveries()
        yield* Metric.update(AlertingMetrics.rulesEvaluatedTotal, rows.length)
        yield* Metric.update(AlertingMetrics.tickDurationMs, now() - tickStart)
        return {
          evaluatedCount: rows.length,
          processedCount: deliveryResult.processedCount,
          evaluationFailureCount,
          deliveryFailureCount: deliveryResult.failureCount,
        }
      })

      return {
        listDestinations,
        createDestination,
        updateDestination,
        deleteDestination,
        testDestination,
        listRules,
        createRule,
        updateRule,
        deleteRule,
        testRule,
        listIncidents,
        listDeliveryEvents,
        runSchedulerTick,
      } satisfies AlertsServiceShape
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
