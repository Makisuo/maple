import { createHmac, randomUUID } from "node:crypto"
import {
  CompiledAlertQueryPlan,
  type QueryEngineNoDataBehavior,
  type QueryEngineSampleCountStrategy,
  QuerySpec,
} from "@maple/query-engine"
import {
  AlertDeliveryError,
  AlertDeliveryEventDocument,
  AlertDeliveryEventsListResponse,
  AlertDeliveryStatus,
  AlertDestinationDeleteResponse,
  AlertDestinationDocument,
  AlertDestinationTestResponse,
  AlertDestinationsListResponse,
  AlertEventType,
  AlertEvaluationResult,
  AlertForbiddenError,
  AlertIncidentDocument,
  AlertIncidentsListResponse,
  AlertIncidentStatus,
  AlertMetricAggregation,
  AlertNotFoundError,
  AlertPersistenceError,
  AlertRuleDeleteResponse,
  AlertRuleDocument,
  AlertRulesListResponse,
  AlertValidationError,
  type AlertComparator,
  type AlertDestinationCreateRequest,
  type AlertDestinationType,
  type AlertDestinationUpdateRequest,
  type AlertEventType as AlertEventTypeValue,
  type AlertMetricAggregation as AlertMetricAggregationValue,
  type AlertMetricType,
  type AlertRuleUpsertRequest,
  type AlertSeverity,
  type AlertSignalType,
  type AlertGroupBy,
  type OrgId,
  QueryEngineExecutionError,
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
  type AlertRuleStateRow,
} from "@maple/db"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  ServiceMap,
} from "effect"
import type { TenantContext } from "./AuthService"
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  parseBase64Aes256GcmKey,
  type EncryptedValue,
} from "./Crypto"
import { Database } from "./DatabaseLive"
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
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly severity: AlertSeverity
  readonly serviceName: string | null
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
  readonly destinationIds: ReadonlyArray<string>
  readonly compiledPlan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>
  readonly createdAt: number
  readonly updatedAt: number
  readonly createdBy: string
  readonly updatedBy: string
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
  readonly destination: AlertDestinationRow
  readonly destinationDoc: AlertDestinationDocument
  readonly publicConfig: DestinationPublicConfig
  readonly secretConfig: DestinationSecretConfig
  readonly ruleId: string
  readonly ruleName: string
  readonly serviceName: string | null
  readonly signalType: AlertSignalType
  readonly severity: AlertSeverity
  readonly comparator: AlertComparator
  readonly threshold: number
  readonly eventType: AlertEventTypeValue
  readonly incidentId: string | null
  readonly incidentStatus: Schema.Schema.Type<typeof AlertIncidentStatus>
  readonly dedupeKey: string
  readonly windowMinutes: number
  readonly value: number | null
  readonly sampleCount: number | null
}

interface DispatchResult {
  readonly providerMessage: string | null
  readonly providerReference: string | null
  readonly responseCode: number | null
}

const MAX_DELIVERY_ATTEMPTS = 5

const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(
  AlertDestinationDocument.fields.id,
)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(
  AlertIncidentDocument.fields.id,
)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(
  AlertDeliveryEventDocument.fields.id,
)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)
const decodeCompiledAlertQueryPlanSync = Schema.decodeUnknownSync(
  CompiledAlertQueryPlan,
)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(
  AlertDestinationDocument.fields.createdAt,
)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
type IsoDateTimeValue = Schema.Schema.Type<
  typeof AlertDestinationDocument.fields.createdAt
>

const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]

const now = () => Date.now()

const toIso = (value: number | null | undefined): IsoDateTimeValue | null =>
  value == null ? null : decodeIsoDateTimeStringSync(new Date(value).toISOString())

const toTinybirdDateTime = (epochMs: number) =>
  new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

const compareThreshold = (
  value: number,
  comparator: AlertComparator,
  threshold: number,
) => {
  switch (comparator) {
    case "gt":
      return value > threshold
    case "gte":
      return value >= threshold
    case "lt":
      return value < threshold
    case "lte":
      return value <= threshold
  }
}

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

const parseJson = <T>(value: string, onError: string): Effect.Effect<T, AlertValidationError> =>
  Effect.try({
    try: () => JSON.parse(value) as T,
    catch: () => makeValidationError(onError),
  })

const summarizeWebhookUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    return `POST ${parsed.host}`
  } catch {
    return "Webhook endpoint"
  }
}

const buildPublicConfig = (
  request: AlertDestinationCreateRequest,
): DestinationPublicConfig => {
  switch (request.type) {
    case "slack":
      return {
        summary: request.channelLabel?.trim() || "Slack incoming webhook",
        channelLabel: normalizeOptionalString(request.channelLabel),
      }
    case "pagerduty":
      return {
        summary: "PagerDuty Events API v2",
        channelLabel: null,
      }
    case "webhook":
      return {
        summary: summarizeWebhookUrl(request.url),
        channelLabel: null,
      }
  }
}

const buildSecretConfig = (
  request: AlertDestinationCreateRequest,
): DestinationSecretConfig => {
  switch (request.type) {
    case "slack":
      return {
        type: "slack",
        webhookUrl: request.webhookUrl.trim(),
      }
    case "pagerduty":
      return {
        type: "pagerduty",
        integrationKey: request.integrationKey.trim(),
      }
    case "webhook":
      return {
        type: "webhook",
        url: request.url.trim(),
        signingSecret: normalizeOptionalString(request.signingSecret),
      }
  }
}

const parsePublicConfig = (row: AlertDestinationRow) =>
  parseJson<DestinationPublicConfig>(
    row.configJson,
    "Stored destination config is invalid",
  )

const safeParsePublicConfig = (row: AlertDestinationRow): DestinationPublicConfig => {
  try {
    return JSON.parse(row.configJson) as DestinationPublicConfig
  } catch {
    return {
      summary: "Invalid destination config",
      channelLabel: null,
    }
  }
}

const safeParseDestinationIds = (value: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

const compileRulePlan = (rule: {
  readonly signalType: AlertSignalType
  readonly serviceName: string | null
  readonly metricName: string | null
  readonly metricType: AlertMetricType | null
  readonly metricAggregation: AlertMetricAggregationValue | null
  readonly apdexThresholdMs: number | null
  readonly comparator: AlertComparator
  readonly windowMinutes: number
}): Effect.Effect<
  Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
  AlertValidationError
> => {
  const bucketSeconds = Math.max(rule.windowMinutes * 60, 60)
  const baseTraceFilters = rule.serviceName == null
    ? undefined
    : { serviceName: rule.serviceName }

  const noDataBehavior: QueryEngineNoDataBehavior =
    rule.signalType === "throughput" && ["lt", "lte"].includes(rule.comparator)
      ? "zero"
      : "skip"

  let query: QuerySpec
  let sampleCountStrategy: QueryEngineSampleCountStrategy

  switch (rule.signalType) {
    case "error_rate":
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: "error_rate",
        groupBy: ["none"],
        bucketSeconds,
        filters: baseTraceFilters,
      })
      sampleCountStrategy = "trace_count"
      break
    case "p95_latency":
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: "p95_duration",
        groupBy: ["none"],
        bucketSeconds,
        filters: baseTraceFilters,
      })
      sampleCountStrategy = "trace_count"
      break
    case "p99_latency":
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: "p99_duration",
        groupBy: ["none"],
        bucketSeconds,
        filters: baseTraceFilters,
      })
      sampleCountStrategy = "trace_count"
      break
    case "throughput":
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: "count",
        groupBy: ["none"],
        bucketSeconds,
        filters: baseTraceFilters,
      })
      sampleCountStrategy = "trace_count"
      break
    case "apdex":
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "traces",
        metric: "apdex",
        groupBy: ["none"],
        bucketSeconds,
        apdexThresholdMs: rule.apdexThresholdMs ?? 500,
        filters: {
          ...(baseTraceFilters ?? {}),
          rootSpansOnly: true,
        },
      })
      sampleCountStrategy = "trace_count"
      break
    case "metric":
      if (rule.metricName == null || rule.metricType == null || rule.metricAggregation == null) {
        return Effect.fail(
          makeValidationError("metric alerts require metricName, metricType, and metricAggregation"),
        )
      }
      query = decodeQuerySpecSync({
        kind: "timeseries",
        source: "metrics",
        metric: rule.metricAggregation,
        groupBy: ["none"],
        bucketSeconds,
        filters: {
          metricName: rule.metricName,
          metricType: rule.metricType,
          ...(rule.serviceName == null ? {} : { serviceName: rule.serviceName }),
        },
      })
      sampleCountStrategy = "metric_data_points"
      break
  }

  return Effect.try({
    try: () =>
      decodeCompiledAlertQueryPlanSync({
        query,
        reducer: "identity",
        sampleCountStrategy,
        noDataBehavior,
      }),
    catch: () => makeValidationError("Failed to compile alert rule plan"),
  })
}

const parseCompiledPlan = (
  row: Pick<
    AlertRuleRow,
    "querySpecJson" | "reducer" | "sampleCountStrategy" | "noDataBehavior"
  >,
): Effect.Effect<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> =>
  Effect.try({
    try: () =>
      decodeCompiledAlertQueryPlanSync({
        query: JSON.parse(row.querySpecJson),
        reducer: row.reducer,
        sampleCountStrategy: row.sampleCountStrategy,
        noDataBehavior: row.noDataBehavior,
      }),
    catch: () => makeValidationError("Stored compiled alert plan is invalid"),
  })

const rowToDestinationDocument = (
  row: AlertDestinationRow,
  publicConfig: DestinationPublicConfig,
) =>
  new AlertDestinationDocument({
    id: decodeAlertDestinationIdSync(row.id),
    name: row.name,
    type: row.type as AlertDestinationType,
    enabled: row.enabled === 1,
    summary: publicConfig.summary,
    channelLabel: publicConfig.channelLabel,
    lastTestedAt: toIso(row.lastTestedAt),
    lastTestError: row.lastTestError,
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
  })

const rowToRuleDocument = (row: AlertRuleRow, destinationIds: ReadonlyArray<string>) =>
  new AlertRuleDocument({
    id: decodeAlertRuleIdSync(row.id),
    name: row.name,
    enabled: row.enabled === 1,
    severity: row.severity as AlertSeverity,
    serviceName: row.serviceName,
    groupBy: (row.groupBy as AlertGroupBy | null) ?? null,
    signalType: row.signalType as AlertSignalType,
    comparator: row.comparator as AlertComparator,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    minimumSampleCount: row.minimumSampleCount,
    consecutiveBreachesRequired: row.consecutiveBreachesRequired,
    consecutiveHealthyRequired: row.consecutiveHealthyRequired,
    renotifyIntervalMinutes: row.renotifyIntervalMinutes,
    metricName: row.metricName,
    metricType: (row.metricType as AlertMetricType | null) ?? null,
    metricAggregation:
      (row.metricAggregation as AlertMetricAggregationValue | null) ?? null,
    apdexThresholdMs: row.apdexThresholdMs,
    destinationIds: destinationIds.map((id) => decodeAlertDestinationIdSync(id)),
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  })

const rowToIncidentDocument = (row: AlertIncidentRow) =>
  new AlertIncidentDocument({
    id: decodeAlertIncidentIdSync(row.id),
    ruleId: decodeAlertRuleIdSync(row.ruleId),
    ruleName: row.ruleName,
    serviceName: row.serviceName,
    signalType: row.signalType as AlertSignalType,
    severity: row.severity as AlertSeverity,
    status: row.status as Schema.Schema.Type<typeof AlertIncidentStatus>,
    comparator: row.comparator as AlertComparator,
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
    lastDeliveredEventType: (row.lastDeliveredEventType as AlertEventTypeValue | null) ?? null,
    lastNotifiedAt: toIso(row.lastNotifiedAt),
  })

const formatComparator = (value: AlertComparator) => {
  switch (value) {
    case "gt":
      return ">"
    case "gte":
      return ">="
    case "lt":
      return "<"
    case "lte":
      return "<="
  }
}

const formatSignalLabel = (signal: string) => {
  const labels: Record<string, string> = {
    error_rate: "Error Rate",
    p95_latency: "P95 Latency",
    p99_latency: "P99 Latency",
    apdex: "Apdex",
    throughput: "Throughput",
    metric: "Metric",
  }
  return labels[signal] ?? signal
}

const eventTypeEmoji = (type: string) => {
  const map: Record<string, string> = {
    trigger: "\u{1F6A8}",
    resolve: "\u2705",
    renotify: "\u{1F514}",
    test: "\u{1F9EA}",
  }
  return map[type] ?? "\u{1F4E2}"
}

const formatEventTypeLabel = (type: string) => {
  const map: Record<string, string> = {
    trigger: "Triggered",
    resolve: "Resolved",
    renotify: "Re-notification",
    test: "Test",
  }
  return map[type] ?? type
}

const formatSlackValue = (
  value: number | null,
  signalType: string,
): string => {
  if (value == null) return "n/a"
  switch (signalType) {
    case "error_rate":
      return `${round(value)}%`
    case "p95_latency":
    case "p99_latency":
      return `${round(value)}ms`
    case "apdex":
      return `${round(value, 3)}`
    case "throughput":
      return `${round(value)} rpm`
    default:
      return `${round(value)}`
  }
}

const formatSlackThreshold = (
  threshold: number,
  signalType: string,
): string => {
  switch (signalType) {
    case "error_rate":
      return `${round(threshold)}%`
    case "p95_latency":
    case "p99_latency":
      return `${round(threshold)}ms`
    case "apdex":
      return `${round(threshold, 3)}`
    case "throughput":
      return `${round(threshold)} rpm`
    default:
      return `${round(threshold)}`
  }
}

const round = (value: number, decimals = 2): string => {
  const factor = 10 ** decimals
  return (Math.round(value * factor) / factor).toString()
}

const formatWindow = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`
  const hours = minutes / 60
  return hours % 1 === 0 ? `${hours}h` : `${minutes}m`
}

const slackAttachmentColor = (
  eventType: string,
  severity: string,
): string => {
  if (eventType === "resolve") return "#2eb67d"
  if (eventType === "test") return "#36c5f0"
  if (severity === "critical") return "#e01e5a"
  return "#ecb22e" // warning
}

let alertFetchImpl: typeof fetch = fetch

export const __testables = {
  setFetchImpl: (impl: typeof fetch) => {
    alertFetchImpl = impl
  },
  reset: () => {
    alertFetchImpl = fetch
  },
}

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
    AlertForbiddenError | AlertPersistenceError | AlertNotFoundError
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
    { readonly evaluatedCount: number; readonly processedCount: number },
    AlertPersistenceError | AlertDeliveryError | AlertValidationError | AlertNotFoundError
  >
}

export class AlertsService extends ServiceMap.Service<AlertsService, AlertsServiceShape>()(
  "AlertsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const env = yield* Env
      const queryEngine = yield* QueryEngineService
      const encryptionKey = yield* parseEncryptionKey(
        Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      )

      const requireAdmin = Effect.fn("AlertsService.requireAdmin")(function* (
        roles: ReadonlyArray<RoleName>,
      ) {
        if (isAdmin(roles)) return
        return yield* Effect.fail(
          new AlertForbiddenError({
            message: "Only org admins can manage alerts",
            roles: roles.length > 0 ? [...roles] : undefined,
          }),
        )
      })

      const selectDestinationRow = Effect.fn("AlertsService.selectDestinationRow")(function* (
        orgId: OrgId,
        destinationId: AlertDestinationDocument["id"],
      ) {
        const rows = yield* database.execute((db) =>
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
        ).pipe(Effect.mapError(makePersistenceError))

        return Option.fromNullishOr(rows[0])
      })

      const requireDestinationRow = Effect.fn("AlertsService.requireDestinationRow")(function* (
        orgId: OrgId,
        destinationId: AlertDestinationDocument["id"],
      ) {
        const row = yield* selectDestinationRow(orgId, destinationId)
        if (Option.isSome(row)) return row.value
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
        const secretConfig = yield* parseJson<DestinationSecretConfig>(
          secretJson,
          "Stored destination secret is invalid",
        )
        return {
          row,
          publicConfig,
          secretConfig,
          document: rowToDestinationDocument(row, publicConfig),
        } as const
      })

      const selectRuleRow = Effect.fn("AlertsService.selectRuleRow")(function* (
        orgId: OrgId,
        ruleId: AlertRuleDocument["id"],
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertRules)
            .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
            .limit(1),
        ).pipe(Effect.mapError(makePersistenceError))

        return Option.fromNullishOr(rows[0])
      })

      const requireRuleRow = Effect.fn("AlertsService.requireRuleRow")(function* (
        orgId: OrgId,
        ruleId: AlertRuleDocument["id"],
      ) {
        const row = yield* selectRuleRow(orgId, ruleId)
        if (Option.isSome(row)) return row.value
        return yield* Effect.fail(
          new AlertNotFoundError({
            message: "Alert rule not found",
            resourceType: "rule",
            resourceId: ruleId,
          }),
        )
      })

      const parseDestinationIds = (value: string) =>
        parseJson<ReadonlyArray<string>>(value, "Stored rule destinations are invalid")

      const normalizeRuleRow = Effect.fn("AlertsService.normalizeRuleRow")(function* (
        row: AlertRuleRow,
      ): Effect.fn.Return<NormalizedRule, AlertValidationError> {
        return {
          id: row.id,
          name: row.name,
          enabled: row.enabled === 1,
          severity: row.severity as AlertSeverity,
          serviceName: row.serviceName,
          groupBy: (row.groupBy as AlertGroupBy | null) ?? null,
          signalType: row.signalType as AlertSignalType,
          comparator: row.comparator as AlertComparator,
          threshold: row.threshold,
          windowMinutes: row.windowMinutes,
          minimumSampleCount: row.minimumSampleCount,
          consecutiveBreachesRequired: row.consecutiveBreachesRequired,
          consecutiveHealthyRequired: row.consecutiveHealthyRequired,
          renotifyIntervalMinutes: row.renotifyIntervalMinutes,
          metricName: row.metricName,
          metricType: (row.metricType as AlertMetricType | null) ?? null,
          metricAggregation:
            (row.metricAggregation as AlertMetricAggregationValue | null) ?? null,
          apdexThresholdMs: row.apdexThresholdMs,
          destinationIds: yield* parseDestinationIds(row.destinationIdsJson),
          compiledPlan: yield* parseCompiledPlan(row),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          createdBy: row.createdBy,
          updatedBy: row.updatedBy,
        }
      })

      const normalizeRule = Effect.fn("AlertsService.normalizeRule")(function* (
        request: AlertRuleUpsertRequest,
      ): Effect.fn.Return<NormalizedRule, AlertValidationError> {
        const name = request.name.trim()
        const serviceName = normalizeOptionalString(request.serviceName)
        const metricName = normalizeOptionalString(request.metricName)
        const destinationIds = request.destinationIds.map((id) => id as string)

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
        if (request.signalType !== "metric" && request.metricType) {
          details.push("metricType is only supported for metric alerts")
        }
        if (request.signalType !== "metric" && metricName) {
          details.push("metricName is only supported for metric alerts")
        }
        if (request.signalType !== "metric" && request.metricAggregation) {
          details.push("metricAggregation is only supported for metric alerts")
        }
        const groupBy = request.groupBy ?? null
        if (groupBy != null && serviceName != null) {
          details.push("groupBy is only supported when no service is specified")
        }

        if (details.length > 0) {
          return yield* Effect.fail(
            makeValidationError("Invalid alert rule", details),
          )
        }

        const normalizedBase = {
          id: randomUUID(),
          name,
          enabled: request.enabled ?? true,
          severity: request.severity,
          serviceName,
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
          destinationIds,
          createdAt: now(),
          updatedAt: now(),
          createdBy: "system",
          updatedBy: "system",
        }
        const compiledPlan = yield* compileRulePlan(normalizedBase)

        return {
          ...normalizedBase,
          compiledPlan,
        }
      })

      const requireDestinationIds = Effect.fn("AlertsService.requireDestinationIds")(function* (
        orgId: OrgId,
        destinationIds: ReadonlyArray<string>,
      ) {
        if (destinationIds.length === 0) return

        const rows = yield* database.execute((db) =>
          db
            .select({ id: alertDestinations.id })
            .from(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                inArray(alertDestinations.id, [...destinationIds]),
              ),
            ),
        ).pipe(Effect.mapError(makePersistenceError))

        const existingIds = new Set(rows.map((row) => row.id))
        const missing = destinationIds.filter((id) => !existingIds.has(id))
        if (missing.length > 0) {
          return yield* Effect.fail(
            makeValidationError("Unknown destination IDs", missing),
          )
        }
      })

      const evaluateRule = Effect.fn("AlertsService.evaluateRule")(function* (
        orgId: OrgId,
        rule: NormalizedRule,
      ): Effect.fn.Return<EvaluatedRule, AlertValidationError | AlertDeliveryError> {
        const tenant: TenantContext = {
          orgId,
          userId: decodeUserIdSync("system-alerting"),
          roles: [decodeRoleNameSync("root")],
          authMode: "self_hosted",
        }
        const endMs = now()
        const startMs = endMs - rule.windowMinutes * 60_000
        const evaluated = yield* queryEngine.evaluate(tenant, {
          startTime: toTinybirdDateTime(startMs),
          endTime: toTinybirdDateTime(endMs),
          query: rule.compiledPlan.query,
          reducer: rule.compiledPlan.reducer,
          sampleCountStrategy: rule.compiledPlan.sampleCountStrategy,
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof QueryEngineValidationError) {
              return makeValidationError(error.message, error.details)
            }
            if (error instanceof QueryEngineExecutionError) {
              return makeDeliveryError(error.message)
            }
            return makeDeliveryError("Alert evaluation failed")
          }),
        )

        const noDataBehavior = rule.compiledPlan.noDataBehavior
        const sampleCount = evaluated.sampleCount
        const value = evaluated.hasData
          ? evaluated.value
          : noDataBehavior === "zero"
            ? 0
            : null

        if (!evaluated.hasData && noDataBehavior === "skip") {
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
            evaluated.reason ??
            `${rule.signalType} ${formatComparator(rule.comparator)} ${rule.threshold}`,
        }
      })

      const applyEvaluationLogic = (
        rule: NormalizedRule,
        obs: GroupedAlertObservation,
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
          reason: `${rule.signalType} ${formatComparator(rule.comparator)} ${rule.threshold}`,
        }
      }

      const evaluateGroupedRule = Effect.fn("AlertsService.evaluateGroupedRule")(function* (
        orgId: OrgId,
        rule: NormalizedRule,
      ): Effect.fn.Return<
        Array<{ evaluation: EvaluatedRule; groupKey: string }>,
        AlertValidationError | AlertDeliveryError
      > {
        const tenant: TenantContext = {
          orgId,
          userId: decodeUserIdSync("system-alerting"),
          roles: [decodeRoleNameSync("root")],
          authMode: "self_hosted",
        }
        const endMs = now()
        const startMs = endMs - rule.windowMinutes * 60_000
        const groupedResults = yield* queryEngine.evaluateGrouped(tenant, {
          startTime: toTinybirdDateTime(startMs),
          endTime: toTinybirdDateTime(endMs),
          query: rule.compiledPlan.query,
          reducer: rule.compiledPlan.reducer,
          sampleCountStrategy: rule.compiledPlan.sampleCountStrategy,
        }, rule.groupBy as "service").pipe(
          Effect.mapError((error) => {
            if (error instanceof QueryEngineValidationError) {
              return makeValidationError(error.message, error.details)
            }
            if (error instanceof QueryEngineExecutionError) {
              return makeDeliveryError(error.message)
            }
            return makeDeliveryError("Grouped alert evaluation failed")
          }),
        )

        return groupedResults.map((obs) => ({
          evaluation: applyEvaluationLogic(rule, obs),
          groupKey: obs.groupKey,
        }))
      })

      const insertDeliveryEvent = Effect.fn("AlertsService.insertDeliveryEvent")(function* (
        orgId: OrgId,
        incidentId: string | null,
        ruleId: string,
        destinationId: string,
        eventType: AlertEventTypeValue,
        payload: Record<string, unknown>,
        scheduledAt: number,
        deliveryKey: string,
        attemptNumber: number,
      ) {
        const id = randomUUID()
        yield* database.execute((db) =>
          db.insert(alertDeliveryEvents).values({
            id,
            orgId,
            incidentId,
            ruleId,
            destinationId,
            deliveryKey,
            eventType,
            attemptNumber,
            status: "queued",
            scheduledAt,
            attemptedAt: null,
            providerMessage: null,
            providerReference: null,
            responseCode: null,
            errorMessage: null,
            payloadJson: JSON.stringify(payload),
            createdAt: scheduledAt,
            updatedAt: scheduledAt,
          }),
        ).pipe(Effect.mapError(makePersistenceError))
      })

      const markDestinationTest = Effect.fn("AlertsService.markDestinationTest")(function* (
        orgId: OrgId,
        destinationId: string,
        errorMessage: string | null,
      ) {
        const timestamp = now()
        yield* database.execute((db) =>
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
        ).pipe(Effect.mapError(makePersistenceError))
      })

      const composeLinkUrl = (serviceName: string | null) =>
        serviceName
          ? `${env.MAPLE_APP_BASE_URL}/services/${encodeURIComponent(serviceName)}`
          : `${env.MAPLE_APP_BASE_URL}/alerts`

      const dispatchDelivery = Effect.fn("AlertsService.dispatchDelivery")(function* (
        context: DispatchContext,
        payloadJson: string,
      ): Effect.fn.Return<DispatchResult, AlertDeliveryError> {
        switch (context.secretConfig.type) {
          case "slack": {
            const webhookUrl = context.secretConfig.webhookUrl
            const response = yield* Effect.tryPromise({
              try: () =>
                alertFetchImpl(webhookUrl, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    text: `${context.ruleName}: ${formatEventTypeLabel(context.eventType)}`,
                    attachments: [
                      {
                        color: slackAttachmentColor(
                          context.eventType,
                          context.severity,
                        ),
                        blocks: [
                          {
                            type: "header",
                            text: {
                              type: "plain_text",
                              text: `${eventTypeEmoji(context.eventType)} ${context.ruleName} — ${formatEventTypeLabel(context.eventType)}`,
                              emoji: true,
                            },
                          },
                          {
                            type: "section",
                            fields: [
                              {
                                type: "mrkdwn",
                                text: `*Severity*\n${context.severity}`,
                              },
                              {
                                type: "mrkdwn",
                                text: `*Signal*\n${formatSignalLabel(context.signalType)}`,
                              },
                              {
                                type: "mrkdwn",
                                text: `*Service*\n${context.serviceName ?? "All services"}`,
                              },
                              {
                                type: "mrkdwn",
                                text: `*Observed*\n${formatSlackValue(context.value, context.signalType)} ${formatComparator(context.comparator)} ${formatSlackThreshold(context.threshold, context.signalType)}`,
                              },
                              {
                                type: "mrkdwn",
                                text: `*Window*\n${formatWindow(context.windowMinutes)}`,
                              },
                            ],
                          },
                          { type: "divider" },
                          {
                            type: "actions",
                            elements: [
                              {
                                type: "button",
                                text: {
                                  type: "plain_text",
                                  text: "Open in Maple",
                                  emoji: true,
                                },
                                url: composeLinkUrl(context.serviceName),
                                ...(context.eventType !== "resolve" && {
                                  style: "danger",
                                }),
                              },
                            ],
                          },
                          {
                            type: "context",
                            elements: [
                              {
                                type: "mrkdwn",
                                text: "\u{1F341} Maple Alerts",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  }),
                }),
              catch: (error) =>
                makeDeliveryError(
                  error instanceof Error ? error.message : "Slack delivery failed",
                  "slack",
                ),
            })
            if (!response.ok) {
              return yield* Effect.fail(
                makeDeliveryError(
                  `Slack delivery failed with ${response.status}`,
                  "slack",
                ),
              )
            }
            return {
              providerMessage: "Delivered to Slack",
              providerReference: null,
              responseCode: response.status,
            }
          }
          case "pagerduty": {
            const integrationKey = context.secretConfig.integrationKey
            const body = {
              routing_key: integrationKey,
              event_action: context.eventType === "resolve" ? "resolve" : "trigger",
              dedup_key: context.dedupeKey,
              payload: {
                summary: `${context.ruleName} ${context.eventType}`,
                source: context.serviceName ?? "maple",
                severity: context.severity === "critical" ? "critical" : "warning",
                custom_details: {
                  ruleName: context.ruleName,
                  signalType: context.signalType,
                  value: context.value,
                  threshold: context.threshold,
                  comparator: context.comparator,
                  serviceName: context.serviceName,
                  linkUrl: composeLinkUrl(context.serviceName),
                },
              },
              links: [
                {
                  href: composeLinkUrl(context.serviceName),
                  text: "Open in Maple",
                },
              ],
            }
            const response = yield* Effect.tryPromise({
              try: () =>
                alertFetchImpl("https://events.pagerduty.com/v2/enqueue", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                }),
              catch: (error) =>
                makeDeliveryError(
                  error instanceof Error ? error.message : "PagerDuty delivery failed",
                  "pagerduty",
                ),
            })
            if (!response.ok) {
              return yield* Effect.fail(
                makeDeliveryError(
                  `PagerDuty delivery failed with ${response.status}`,
                  "pagerduty",
                ),
              )
            }
            return {
              providerMessage: "Delivered to PagerDuty",
              providerReference: context.dedupeKey,
              responseCode: response.status,
            }
          }
          case "webhook": {
            const targetUrl = context.secretConfig.url
            const signingSecret = context.secretConfig.signingSecret
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "x-maple-event-type": context.eventType,
              "x-maple-delivery-key": context.dedupeKey,
            }
            if (signingSecret) {
              const signature = createHmac("sha256", signingSecret)
                .update(payloadJson)
                .digest("hex")
              headers["x-maple-signature"] = signature
            }
            const response = yield* Effect.tryPromise({
              try: () =>
                alertFetchImpl(targetUrl, {
                  method: "POST",
                  headers,
                  body: payloadJson,
                }),
              catch: (error) =>
                makeDeliveryError(
                  error instanceof Error ? error.message : "Webhook delivery failed",
                  "webhook",
                ),
            })
            if (!response.ok) {
              return yield* Effect.fail(
                makeDeliveryError(
                  `Webhook delivery failed with ${response.status}`,
                  "webhook",
                ),
              )
            }
            return {
              providerMessage: "Delivered to webhook",
              providerReference: context.dedupeKey,
              responseCode: response.status,
            }
          }
        }
      })

      const buildPayload = (context: DispatchContext) => ({
        eventType: context.eventType,
        incidentId: context.incidentId,
        incidentStatus: context.incidentStatus,
        dedupeKey: context.dedupeKey,
        rule: {
          id: context.ruleId,
          name: context.ruleName,
          signalType: context.signalType,
          severity: context.severity,
          serviceName: context.serviceName,
          comparator: context.comparator,
          threshold: context.threshold,
          windowMinutes: context.windowMinutes,
        },
        observed: {
          value: context.value,
          sampleCount: context.sampleCount,
        },
        linkUrl: composeLinkUrl(context.serviceName),
        sentAt: new Date().toISOString(),
      })

      const sendImmediateNotification = Effect.fn(
        "AlertsService.sendImmediateNotification",
      )(function* (
        destinationRow: AlertDestinationRow,
        context: Omit<DispatchContext, "destination" | "destinationDoc" | "publicConfig" | "secretConfig">,
      ) {
        const hydrated = yield* hydrateDestination(destinationRow)
        const fullContext: DispatchContext = {
          destination: hydrated.row,
          destinationDoc: hydrated.document,
          publicConfig: hydrated.publicConfig,
          secretConfig: hydrated.secretConfig,
          ...context,
        }
        const payload = buildPayload(fullContext)
        const payloadJson = JSON.stringify(payload)
        return yield* dispatchDelivery(fullContext, payloadJson)
      })

      const queueIncidentNotifications = Effect.fn(
        "AlertsService.queueIncidentNotifications",
      )(function* (
        orgId: OrgId,
        rule: NormalizedRule,
        incident: AlertIncidentRow,
        evaluation: EvaluatedRule,
        eventType: AlertEventTypeValue,
      ) {
        if (rule.destinationIds.length === 0) return
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                inArray(alertDestinations.id, [...rule.destinationIds]),
              ),
            ),
        ).pipe(Effect.mapError(makePersistenceError))

        const destinations = new Map(rows.map((row) => [row.id, row]))
        const scheduledAt = now()

        for (const destinationId of rule.destinationIds) {
          const destination = destinations.get(destinationId)
          if (!destination || destination.enabled !== 1) continue
          const publicConfig = yield* parsePublicConfig(destination)
          const secretConfig = yield* parseJson<DestinationSecretConfig>(
            yield* decryptSecret(destination, encryptionKey),
            "Stored destination secret is invalid",
          )
          const deliveryKey = [
            incident.id,
            destinationId,
            eventType,
            scheduledAt,
          ].join(":")
          yield* insertDeliveryEvent(
            orgId,
            incident.id,
            rule.id,
            destinationId,
            eventType,
            buildPayload({
              destination,
              destinationDoc: rowToDestinationDocument(destination, publicConfig),
              publicConfig,
              secretConfig,
              ruleId: rule.id,
              ruleName: rule.name,
              serviceName: rule.serviceName,
              signalType: rule.signalType,
              severity: rule.severity,
              comparator: rule.comparator,
              threshold: rule.threshold,
              windowMinutes: rule.windowMinutes,
              eventType,
              incidentId: incident.id,
              incidentStatus: incident.status as Schema.Schema.Type<
                typeof AlertIncidentStatus
              >,
              dedupeKey: incident.dedupeKey,
              value: evaluation.value,
              sampleCount: evaluation.sampleCount,
            }),
            scheduledAt,
            deliveryKey,
            1,
          )
        }
      })

      const computeRetryDelayMs = (attemptNumber: number) => {
        const base = Math.min(60_000 * Math.pow(2, attemptNumber - 1), 15 * 60_000)
        const jitter = Math.floor(Math.random() * 1_000)
        return base + jitter
      }

      const listDestinations = Effect.fn("AlertsService.listDestinations")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertDestinations)
            .where(eq(alertDestinations.orgId, orgId))
            .orderBy(desc(alertDestinations.updatedAt)),
        ).pipe(Effect.mapError(makePersistenceError))

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
        const destinationId = randomUUID()
        const publicConfig = buildPublicConfig(request)
        const secretConfig = buildSecretConfig(request)
        const encryptedSecret = yield* encryptSecret(
          JSON.stringify(secretConfig),
          encryptionKey,
        )
        const timestamp = now()

        yield* database.execute((db) =>
          db.insert(alertDestinations).values({
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
          }),
        ).pipe(Effect.mapError(makePersistenceError))

        return rowToDestinationDocument(
          {
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
          },
          publicConfig,
        )
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

        yield* database.execute((db) =>
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
        ).pipe(Effect.mapError(makePersistenceError))

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
        yield* database.execute((db) =>
          db
            .delete(alertDestinations)
            .where(
              and(
                eq(alertDestinations.orgId, orgId),
                eq(alertDestinations.id, destinationId),
              ),
            ),
        ).pipe(Effect.mapError(makePersistenceError))
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
          ruleId: randomUUID(),
          ruleName: "Test alert",
          serviceName: null,
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
        }).pipe(Effect.exit)

        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          const message =
            error instanceof AlertDeliveryError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Destination test failed"
          yield* markDestinationTest(orgId, destinationId, message)
          return yield* Effect.fail(
            error instanceof AlertDeliveryError
              ? error
              : makeDeliveryError(message, row.type as AlertDestinationType),
          )
        }

        yield* markDestinationTest(orgId, destinationId, null)
        return new AlertDestinationTestResponse({
          success: true,
          message: "Test notification sent",
        })
      })

      const upsertRuleRow = Effect.fn("AlertsService.upsertRuleRow")(function* (
        orgId: OrgId,
        userId: UserId,
        existingId: string | null,
        request: AlertRuleUpsertRequest,
      ) {
        const normalized = yield* normalizeRule(request)
        yield* requireDestinationIds(orgId, normalized.destinationIds)
        const ruleId = existingId ?? normalized.id
        const timestamp = now()

        if (existingId == null) {
          yield* database.execute((db) =>
            db.insert(alertRules).values({
              id: ruleId,
              orgId,
              name: normalized.name,
              enabled: normalized.enabled ? 1 : 0,
              severity: normalized.severity,
              serviceName: normalized.serviceName,
              groupBy: normalized.groupBy,
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
              destinationIdsJson: JSON.stringify(normalized.destinationIds),
              querySpecJson: JSON.stringify(normalized.compiledPlan.query),
              reducer: normalized.compiledPlan.reducer,
              sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
              noDataBehavior: normalized.compiledPlan.noDataBehavior,
              createdAt: timestamp,
              updatedAt: timestamp,
              createdBy: userId,
              updatedBy: userId,
            }),
          ).pipe(Effect.mapError(makePersistenceError))
        } else {
          yield* database.execute((db) =>
            db
              .update(alertRules)
              .set({
                name: normalized.name,
                enabled: normalized.enabled ? 1 : 0,
                severity: normalized.severity,
                serviceName: normalized.serviceName,
                groupBy: normalized.groupBy,
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
                destinationIdsJson: JSON.stringify(normalized.destinationIds),
                querySpecJson: JSON.stringify(normalized.compiledPlan.query),
                reducer: normalized.compiledPlan.reducer,
                sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
                noDataBehavior: normalized.compiledPlan.noDataBehavior,
                updatedAt: timestamp,
                updatedBy: userId,
              })
              .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, existingId))),
          ).pipe(Effect.mapError(makePersistenceError))
        }

        const row = yield* requireRuleRow(orgId, decodeAlertRuleIdSync(ruleId))
        const destinationIds = safeParseDestinationIds(row.destinationIdsJson)
        return rowToRuleDocument(row, destinationIds)
      })

      const listRules = Effect.fn("AlertsService.listRules")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertRules)
            .where(eq(alertRules.orgId, orgId))
            .orderBy(desc(alertRules.updatedAt)),
        ).pipe(Effect.mapError(makePersistenceError))

        const rules = rows.map((row) =>
          rowToRuleDocument(row, safeParseDestinationIds(row.destinationIdsJson)),
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
        yield* requireRuleRow(orgId, ruleId)
        return yield* upsertRuleRow(orgId, userId, ruleId, request)
      })

      const deleteRule = Effect.fn("AlertsService.deleteRule")(function* (
        orgId: OrgId,
        roles: ReadonlyArray<RoleName>,
        ruleId: AlertRuleDocument["id"],
      ) {
        yield* requireAdmin(roles)
        yield* requireRuleRow(orgId, ruleId)
        yield* database.execute((db) =>
          db.delete(alertRules).where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId))),
        ).pipe(Effect.mapError(makePersistenceError))
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
        if (normalized.groupBy != null && normalized.serviceName == null) {
          const results = yield* evaluateGroupedRule(orgId, normalized)
          const breached = results.find((r) => r.evaluation.status === "breached")
          evaluation = breached?.evaluation ?? results[0]?.evaluation ?? {
            status: "skipped" as const,
            value: null,
            sampleCount: 0,
            threshold: normalized.threshold,
            comparator: normalized.comparator,
            reason: "No services found",
          }
        } else {
          evaluation = yield* evaluateRule(orgId, normalized)
        }

        if (sendNotification) {
          const rows = yield* database.execute((db) =>
            db
              .select()
              .from(alertDestinations)
              .where(eq(alertDestinations.orgId, orgId)),
          ).pipe(Effect.mapError(makePersistenceError))
          const byId = new Map(rows.map((row) => [row.id, row]))
          for (const destinationId of normalized.destinationIds) {
            const destination = byId.get(destinationId)
            if (!destination || destination.enabled !== 1) continue
            yield* sendImmediateNotification(destination, {
              ruleId: randomUUID(),
              ruleName: normalized.name,
              serviceName: normalized.serviceName,
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
            })
          }
        }

        return new AlertEvaluationResult(evaluation)
      })

      const listIncidents = Effect.fn("AlertsService.listIncidents")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertIncidents)
            .where(eq(alertIncidents.orgId, orgId))
            .orderBy(desc(alertIncidents.status), desc(alertIncidents.lastTriggeredAt)),
        ).pipe(Effect.mapError(makePersistenceError))
        return new AlertIncidentsListResponse({
          incidents: rows.map(rowToIncidentDocument),
        })
      })

      const listDeliveryEvents = Effect.fn("AlertsService.listDeliveryEvents")(function* (
        orgId: OrgId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertDeliveryEvents)
            .where(eq(alertDeliveryEvents.orgId, orgId))
            .orderBy(desc(alertDeliveryEvents.createdAt)),
        ).pipe(Effect.mapError(makePersistenceError))

        const destinationRows = yield* database.execute((db) =>
          db
            .select({
              id: alertDestinations.id,
              name: alertDestinations.name,
              type: alertDestinations.type,
            })
            .from(alertDestinations)
            .where(eq(alertDestinations.orgId, orgId)),
        ).pipe(Effect.mapError(makePersistenceError))
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
              (destination?.type as AlertDestinationType | undefined) ?? "webhook",
            deliveryKey: row.deliveryKey,
            eventType: row.eventType as AlertEventTypeValue,
            attemptNumber: row.attemptNumber,
            status: row.status as Schema.Schema.Type<typeof AlertDeliveryStatus>,
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

      const processQueuedDeliveries = Effect.fn(
        "AlertsService.processQueuedDeliveries",
      )(function* () {
        const currentTime = now()
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertDeliveryEvents)
            .where(
              and(
                eq(alertDeliveryEvents.status, "queued"),
                sql`${alertDeliveryEvents.scheduledAt} <= ${currentTime}`,
              ),
            )
            .orderBy(asc(alertDeliveryEvents.scheduledAt)),
        ).pipe(Effect.mapError(makePersistenceError))

        let processed = 0

        for (const row of rows) {
          processed += 1
          const destinationRow = yield* requireDestinationRow(
            row.orgId as OrgId,
            decodeAlertDestinationIdSync(row.destinationId),
          ).pipe(
            Effect.catchTag("AlertNotFoundError", (error) =>
              Effect.fail(makeDeliveryError(error.message)),
            ),
          )

          if (destinationRow.enabled !== 1) {
            yield* database.execute((db) =>
              db
                .update(alertDeliveryEvents)
                .set({
                  status: "failed",
                  attemptedAt: currentTime,
                  errorMessage: "Destination disabled",
                  updatedAt: currentTime,
                })
                .where(eq(alertDeliveryEvents.id, row.id)),
            ).pipe(Effect.mapError(makePersistenceError))
            continue
          }

          let incidentRow: AlertIncidentRow | null = null
          if (row.incidentId != null) {
            incidentRow =
              (
                yield* database.execute((db) =>
                  db
                    .select()
                    .from(alertIncidents)
                    .where(eq(alertIncidents.id, row.incidentId!))
                    .limit(1),
                ).pipe(Effect.mapError(makePersistenceError))
              )[0] ?? null
          }

          const ruleRow =
            (
              yield* database.execute((db) =>
                db
                  .select()
                  .from(alertRules)
                  .where(eq(alertRules.id, row.ruleId))
                  .limit(1),
              ).pipe(Effect.mapError(makePersistenceError))
            )[0] ?? null

          const hydrated = yield* hydrateDestination(destinationRow)
          const payload = yield* parseJson<Record<string, unknown>>(
            row.payloadJson,
            "Stored delivery payload is invalid",
          )

          const deliveryResult = yield* dispatchDelivery(
            {
              destination: hydrated.row,
              destinationDoc: hydrated.document,
              publicConfig: hydrated.publicConfig,
              secretConfig: hydrated.secretConfig,
              ruleId: row.ruleId,
              ruleName:
                ruleRow?.name ??
                String((payload.rule as Record<string, unknown> | undefined)?.name ?? "Alert"),
              serviceName:
                incidentRow?.serviceName ??
                ((payload.rule as Record<string, unknown> | undefined)
                  ?.serviceName as string | null | undefined) ??
                null,
              signalType:
                (incidentRow?.signalType as AlertSignalType | undefined) ??
                ((payload.rule as Record<string, unknown> | undefined)
                  ?.signalType as AlertSignalType | undefined) ??
                "throughput",
              severity:
                (incidentRow?.severity as AlertSeverity | undefined) ??
                ((payload.rule as Record<string, unknown> | undefined)
                  ?.severity as AlertSeverity | undefined) ??
                "warning",
              comparator:
                (incidentRow?.comparator as AlertComparator | undefined) ??
                ((payload.rule as Record<string, unknown> | undefined)
                  ?.comparator as AlertComparator | undefined) ??
                "gt",
              threshold:
                incidentRow?.threshold ??
                Number(
                  (payload.rule as Record<string, unknown> | undefined)?.threshold ?? 0,
                ),
              windowMinutes:
                ruleRow?.windowMinutes ??
                Number(
                  (payload.rule as Record<string, unknown> | undefined)?.windowMinutes ?? 5,
                ),
              eventType: row.eventType as AlertEventTypeValue,
              incidentId: row.incidentId,
              incidentStatus:
                (incidentRow?.status as Schema.Schema.Type<
                  typeof AlertIncidentStatus
                > | null) ?? "resolved",
              dedupeKey:
                incidentRow?.dedupeKey ??
                String(payload.dedupeKey ?? row.deliveryKey),
              value:
                ((payload.observed as Record<string, unknown> | undefined)
                  ?.value as number | null | undefined) ?? null,
              sampleCount:
                ((payload.observed as Record<string, unknown> | undefined)
                  ?.sampleCount as number | null | undefined) ?? null,
            },
            row.payloadJson,
          ).pipe(Effect.exit)

          if (Exit.isSuccess(deliveryResult)) {
            const result = deliveryResult.value
            yield* database.execute((db) =>
              db
                .update(alertDeliveryEvents)
                .set({
                  status: "success",
                  attemptedAt: currentTime,
                  providerMessage: result.providerMessage,
                  providerReference: result.providerReference,
                  responseCode: result.responseCode,
                  errorMessage: null,
                  updatedAt: currentTime,
                })
                .where(eq(alertDeliveryEvents.id, row.id)),
            ).pipe(Effect.mapError(makePersistenceError))

            if (row.incidentId) {
              yield* database.execute((db) =>
                db
                  .update(alertIncidents)
                  .set({
                    lastDeliveredEventType: row.eventType,
                    lastNotifiedAt: currentTime,
                    updatedAt: currentTime,
                  })
                  .where(eq(alertIncidents.id, row.incidentId!)),
              ).pipe(Effect.mapError(makePersistenceError))
            }
          } else {
            const error = Cause.squash(deliveryResult.cause)
            const message =
              error instanceof AlertDeliveryError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : "Delivery failed"
            yield* database.execute((db) =>
              db
                .update(alertDeliveryEvents)
                .set({
                  status: "failed",
                  attemptedAt: currentTime,
                  errorMessage: message,
                  updatedAt: currentTime,
                })
                .where(eq(alertDeliveryEvents.id, row.id)),
            ).pipe(Effect.mapError(makePersistenceError))

            if (row.attemptNumber < MAX_DELIVERY_ATTEMPTS) {
              yield* insertDeliveryEvent(
                row.orgId as OrgId,
                row.incidentId,
                row.ruleId,
                row.destinationId,
                row.eventType as AlertEventTypeValue,
                yield* parseJson<Record<string, unknown>>(
                  row.payloadJson,
                  "Stored delivery payload is invalid",
                ),
                currentTime + computeRetryDelayMs(row.attemptNumber),
                row.deliveryKey,
                row.attemptNumber + 1,
              )
            }
          }
        }

        return processed
      })

      const processEvaluation = Effect.fn("AlertsService.processEvaluation")(function* (
        row: AlertRuleRow,
        normalized: NormalizedRule,
        evaluation: EvaluatedRule,
        groupKey: string,
        serviceName: string | null,
        timestamp: number,
      ) {
        const stateConflictTarget: [typeof alertRuleStates.orgId, typeof alertRuleStates.ruleId, typeof alertRuleStates.groupKey] = [alertRuleStates.orgId, alertRuleStates.ruleId, alertRuleStates.groupKey]

        const state =
          (
            yield* database.execute((db) =>
              db
                .select()
                .from(alertRuleStates)
                .where(
                  and(
                    eq(alertRuleStates.orgId, row.orgId),
                    eq(alertRuleStates.ruleId, row.id),
                    eq(alertRuleStates.groupKey, groupKey),
                  ),
                )
                .limit(1),
            ).pipe(Effect.mapError(makePersistenceError))
          )[0] ?? null

        const incidentServiceFilter = serviceName != null
          ? eq(alertIncidents.serviceName, serviceName)
          : sql`${alertIncidents.serviceName} IS NULL`

        const openIncident =
          (
            yield* database.execute((db) =>
              db
                .select()
                .from(alertIncidents)
                .where(
                  and(
                    eq(alertIncidents.orgId, row.orgId),
                    eq(alertIncidents.ruleId, row.id),
                    eq(alertIncidents.status, "open"),
                    incidentServiceFilter,
                  ),
                )
                .limit(1),
            ).pipe(Effect.mapError(makePersistenceError))
          )[0] ?? null

        if (evaluation.status === "skipped") {
          yield* database.execute((db) =>
            db
              .insert(alertRuleStates)
              .values({
                orgId: row.orgId,
                ruleId: row.id,
                groupKey,
                consecutiveBreaches: state?.consecutiveBreaches ?? 0,
                consecutiveHealthy: state?.consecutiveHealthy ?? 0,
                lastStatus: evaluation.status,
                lastValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                lastError: null,
                updatedAt: timestamp,
              })
              .onConflictDoUpdate({
                target: stateConflictTarget,
                set: {
                  lastStatus: evaluation.status,
                  lastValue: evaluation.value,
                  lastSampleCount: evaluation.sampleCount,
                  lastEvaluatedAt: timestamp,
                  lastError: null,
                  updatedAt: timestamp,
                },
              }),
          ).pipe(Effect.mapError(makePersistenceError))
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

        yield* database.execute((db) =>
          db
            .insert(alertRuleStates)
            .values({
              orgId: row.orgId,
              ruleId: row.id,
              groupKey,
              consecutiveBreaches,
              consecutiveHealthy,
              lastStatus: evaluation.status,
              lastValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
              lastEvaluatedAt: timestamp,
              lastError: null,
              updatedAt: timestamp,
            })
            .onConflictDoUpdate({
              target: stateConflictTarget,
              set: {
                consecutiveBreaches,
                consecutiveHealthy,
                lastStatus: evaluation.status,
                lastValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                lastError: null,
                updatedAt: timestamp,
              },
            }),
        ).pipe(Effect.mapError(makePersistenceError))

        if (
          evaluation.status === "breached" &&
          openIncident == null &&
          consecutiveBreaches >= normalized.consecutiveBreachesRequired
        ) {
          const incidentId = randomUUID()
          const incidentKey = `${row.orgId}:${row.id}:${groupKey}`
          const incident: AlertIncidentRow = {
            id: incidentId,
            orgId: row.orgId,
            ruleId: row.id,
            incidentKey,
            ruleName: row.name,
            serviceName,
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
          yield* database.execute((db) =>
            db.insert(alertIncidents).values(incident),
          ).pipe(Effect.mapError(makePersistenceError))
          yield* queueIncidentNotifications(
            row.orgId as OrgId,
            normalized,
            incident,
            evaluation,
            "trigger",
          )
          return
        }

        if (evaluation.status === "breached" && openIncident != null) {
          yield* database.execute((db) =>
            db
              .update(alertIncidents)
              .set({
                lastTriggeredAt: timestamp,
                lastObservedValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, openIncident.id)),
          ).pipe(Effect.mapError(makePersistenceError))

          const renotifyDueAt =
            (openIncident.lastNotifiedAt ?? openIncident.firstTriggeredAt) +
            normalized.renotifyIntervalMinutes * 60_000
          if (renotifyDueAt <= timestamp) {
            const refreshedIncident = {
              ...openIncident,
              lastTriggeredAt: timestamp,
              lastObservedValue: evaluation.value,
              lastSampleCount: evaluation.sampleCount,
              lastEvaluatedAt: timestamp,
              updatedAt: timestamp,
            }
            yield* queueIncidentNotifications(
              row.orgId as OrgId,
              normalized,
              refreshedIncident,
              evaluation,
              "renotify",
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
            status: "resolved",
            resolvedAt: timestamp,
            lastObservedValue: evaluation.value,
            lastSampleCount: evaluation.sampleCount,
            lastEvaluatedAt: timestamp,
            updatedAt: timestamp,
          }
          yield* database.execute((db) =>
            db
              .update(alertIncidents)
              .set({
                status: "resolved",
                resolvedAt: timestamp,
                lastObservedValue: evaluation.value,
                lastSampleCount: evaluation.sampleCount,
                lastEvaluatedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(alertIncidents.id, openIncident.id)),
          ).pipe(Effect.mapError(makePersistenceError))
          yield* queueIncidentNotifications(
            row.orgId as OrgId,
            normalized,
            resolvedIncident,
            evaluation,
            "resolve",
          )
        }
      })

      const runSchedulerTick = Effect.fn("AlertsService.runSchedulerTick")(function* () {
        const rows = yield* database.execute((db) =>
          db
            .select()
            .from(alertRules)
            .where(eq(alertRules.enabled, 1))
            .orderBy(asc(alertRules.updatedAt)),
        ).pipe(Effect.mapError(makePersistenceError))

        let evaluatedCount = 0

        for (const row of rows) {
          evaluatedCount += 1
          const normalized = yield* normalizeRuleRow(row)
          const timestamp = now()

          if (normalized.groupBy != null && normalized.serviceName == null) {
            const results = yield* evaluateGroupedRule(row.orgId as OrgId, normalized)
            for (const { evaluation, groupKey } of results) {
              yield* processEvaluation(row, normalized, evaluation, groupKey, groupKey, timestamp)
            }
          } else {
            const evaluation = yield* evaluateRule(row.orgId as OrgId, normalized)
            yield* processEvaluation(row, normalized, evaluation, "__total__", normalized.serviceName, timestamp)
          }
        }

        const processedCount = yield* processQueuedDeliveries()
        return { evaluatedCount, processedCount }
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
  static readonly Live = Layer.effect(this, this.make)
  static readonly Default = this.Live
}
