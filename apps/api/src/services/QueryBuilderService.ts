import {
  type BreakdownItem,
  type MetricType,
  QueryBuilderExecuteResponse,
  QueryBuilderFieldValuesResponse,
  QueryBuilderMetadataResponse,
  QueryBuilderPlanResponse,
  type QueryBuilderRequest,
  type QueryBuilderScalarValue,
  QueryEngineExecuteResponse,
  type QueryBuilderFilterNode,
} from "@maple/domain"
import {
  QueryEngineExecutionError,
  QueryEngineValidationError,
} from "@maple/domain/http"
import { Effect, Layer, ServiceMap } from "effect"
import type { TenantContext } from "./AuthService"
import { TinybirdService } from "./TinybirdService"

type BuilderSignal = "traces" | "logs" | "metrics"
type BuilderKind = "timeseries" | "breakdown"
type PlannerClassification = "sync_fast" | "sync_bounded"
type PlannerReasonCode =
  | "fast_path_eligible"
  | "dynamic_field_scan"
  | "boolean_expression"
  | "percentile_large_range"
  | "series_limit_applied"
  | "bucket_limit_applied"
  | "unsupported_field"
  | "unsupported_metric"
  | "invalid_query"
  | "slow_path_confirmation_required"
type BuilderFieldOrigin =
  | "intrinsic"
  | "span_attribute"
  | "resource_attribute"
  | "log_attribute"
  | "metric_attribute"

interface TimeRangeBounds {
  readonly startMs: number
  readonly endMs: number
  readonly rangeSeconds: number
}

interface QueryBuilderServiceShape {
  readonly metadata: (
    tenant: TenantContext,
    input: {
      signal: BuilderSignal
      startTime?: string
      endTime?: string
      limit?: number
    },
  ) => Effect.Effect<QueryBuilderMetadataResponse, QueryEngineValidationError | QueryEngineExecutionError>
  readonly fieldValues: (
    tenant: TenantContext,
    input: {
      signal: BuilderSignal
      field: string
      startTime?: string
      endTime?: string
      query?: string
      limit?: number
    },
  ) => Effect.Effect<QueryBuilderFieldValuesResponse, QueryEngineValidationError | QueryEngineExecutionError>
  readonly plan: (
    tenant: TenantContext,
    input: {
      startTime: string
      endTime: string
      query: QueryBuilderRequest
    },
  ) => Effect.Effect<QueryBuilderPlanResponse, QueryEngineValidationError | QueryEngineExecutionError>
  readonly execute: (
    tenant: TenantContext,
    input: {
      startTime: string
      endTime: string
      query: QueryBuilderRequest
    },
  ) => Effect.Effect<QueryBuilderExecuteResponse, QueryEngineValidationError | QueryEngineExecutionError>
}

interface FieldDefinition {
  readonly signal: BuilderSignal
  readonly path: string
  readonly label: string
  readonly type: "string" | "number" | "boolean"
  readonly origin:
    | "intrinsic"
    | "span_attribute"
    | "resource_attribute"
    | "log_attribute"
    | "metric_attribute"
  readonly filterable: boolean
  readonly groupable: boolean
  readonly aggregatable: boolean
  readonly fastPath: boolean
  readonly aliases?: readonly string[]
}

interface ResolvedField {
  readonly definition: FieldDefinition
  readonly expression: string
  readonly fastCompatible: boolean
}

interface QueryContext {
  readonly signal: BuilderSignal
  readonly kind: BuilderKind
  readonly bucketSeconds: number | null
  readonly executionPath: string
  readonly metricType: MetricType | null
}

interface ExecutionPlan {
  readonly classification: PlannerClassification
  readonly executionPath: string
  readonly normalizedQuery: QueryBuilderRequest
  readonly estimatedBuckets: number
  readonly estimatedSeriesLimit: number
  readonly warnings: ReadonlyArray<{ code: PlannerReasonCode; message: string }>
}

interface SqlPlan {
  readonly sql: string
  readonly valueField: "value"
  readonly resultKind: BuilderKind
}

const MAX_RANGE_SECONDS = 60 * 60 * 24 * 31
const MAX_BUCKETS = 240
const TARGET_BUCKETS = 120
const MAX_GROUP_LIMIT = 50
const DEFAULT_GROUP_LIMIT = 10
const DEFAULT_FIELD_LIMIT = 200
const DEFAULT_VALUE_LIMIT = 50
const DEFAULT_PLANNER_CACHE_TTL_MS = 30_000
const DEFAULT_RESULT_CACHE_TTL_MS = 120_000
const NEWEST_DATA_CACHE_BYPASS_MS = 2 * 60 * 1000

const tracesMetrics = new Set([
  "count",
  "avg_duration",
  "p50_duration",
  "p95_duration",
  "p99_duration",
  "error_rate",
])
const metricsMetrics = new Set(["avg", "sum", "min", "max", "count"])

const TRACE_FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    signal: "traces",
    path: "service.name",
    label: "service.name",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
    aliases: ["service"],
  },
  {
    signal: "traces",
    path: "span.name",
    label: "span.name",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
    aliases: ["span"],
  },
  {
    signal: "traces",
    path: "status.code",
    label: "status.code",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
    aliases: ["status"],
  },
  {
    signal: "traces",
    path: "http.method",
    label: "http.method",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
  },
  {
    signal: "traces",
    path: "http.route",
    label: "http.route",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
  },
  {
    signal: "traces",
    path: "peer.service",
    label: "peer.service",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
  },
  {
    signal: "traces",
    path: "deployment.environment",
    label: "deployment.environment",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
    aliases: ["env", "environment"],
  },
  {
    signal: "traces",
    path: "deployment.commit_sha",
    label: "deployment.commit_sha",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: true,
    aliases: ["commit_sha"],
  },
  {
    signal: "traces",
    path: "root_only",
    label: "root_only",
    type: "boolean",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: true,
    aliases: ["root.only"],
  },
]

const LOG_FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    signal: "logs",
    path: "service.name",
    label: "service.name",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: false,
    aliases: ["service"],
  },
  {
    signal: "logs",
    path: "severity",
    label: "severity",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: false,
  },
  {
    signal: "logs",
    path: "body",
    label: "body",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: false,
  },
  {
    signal: "logs",
    path: "trace.id",
    label: "trace.id",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: false,
  },
  {
    signal: "logs",
    path: "span.id",
    label: "span.id",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: false,
  },
]

const METRIC_FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    signal: "metrics",
    path: "service.name",
    label: "service.name",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: true,
    aggregatable: false,
    fastPath: false,
    aliases: ["service"],
  },
  {
    signal: "metrics",
    path: "metric.name",
    label: "metric.name",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: false,
  },
  {
    signal: "metrics",
    path: "metric.type",
    label: "metric.type",
    type: "string",
    origin: "intrinsic",
    filterable: true,
    groupable: false,
    aggregatable: false,
    fastPath: false,
  },
]

const FIELD_DEFINITIONS: Record<BuilderSignal, FieldDefinition[]> = {
  traces: TRACE_FIELD_DEFINITIONS,
  logs: LOG_FIELD_DEFINITIONS,
  metrics: METRIC_FIELD_DEFINITIONS,
}

const plannerCache = new Map<string, { expiresAt: number; value: QueryBuilderPlanResponse }>()
const resultCache = new Map<string, { expiresAt: number; value: QueryBuilderExecuteResponse }>()

const toEpochMs = (value: string): number => new Date(value.replace(" ", "T") + "Z").getTime()

function escapeSqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
}

function quoteScalar(value: QueryBuilderScalarValue): string {
  if (typeof value === "string") return escapeSqlString(value)
  if (typeof value === "boolean") return value ? "1" : "0"
  return Number.isFinite(value) ? String(value) : "0"
}

function normalizeFieldPath(signal: BuilderSignal, raw: string): string {
  const normalized = raw.trim().toLowerCase()
  const definition = FIELD_DEFINITIONS[signal].find(
    (field) => field.path === normalized || field.aliases?.includes(normalized),
  )

  if (definition) {
    return definition.path
  }

  return normalized
}

function computeAutoBucketSeconds(startMs: number, endMs: number): number {
  const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
  const raw = Math.ceil(rangeSeconds / TARGET_BUCKETS)
  if (raw <= 60) return 60
  if (raw <= 300) return 300
  if (raw <= 900) return 900
  if (raw <= 3600) return 3600
  if (raw <= 14_400) return 14_400
  return 86_400
}

function getRangeBounds(startTime: string, endTime: string): TimeRangeBounds {
  const startMs = toEpochMs(startTime)
  const endMs = toEpochMs(endTime)

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new QueryEngineValidationError({
      message: "Invalid time range",
      details: ["startTime and endTime must be valid datetime strings"],
    })
  }

  if (endMs <= startMs) {
    throw new QueryEngineValidationError({
      message: "Invalid time range",
      details: ["endTime must be greater than startTime"],
    })
  }

  const rangeSeconds = (endMs - startMs) / 1000
  if (rangeSeconds > MAX_RANGE_SECONDS) {
    throw new QueryEngineValidationError({
      message: "Time range too large",
      details: [`Maximum supported range is ${MAX_RANGE_SECONDS} seconds`],
    })
  }

  return { startMs, endMs, rangeSeconds }
}

function buildMetadataItems(
  signal: BuilderSignal,
  extraPaths: Array<{ path: string; origin: BuilderFieldOrigin }>,
) {
  const base = FIELD_DEFINITIONS[signal].map((field) => ({
    signal: field.signal,
    path: field.path,
    label: field.label,
    type: field.type,
    origin: field.origin,
    capability: {
      filterable: field.filterable,
      groupable: field.groupable,
      aggregatable: field.aggregatable,
      fastPath: field.fastPath,
    },
  }))

  const seen = new Set(base.map((field) => field.path))
  for (const item of extraPaths) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    base.push({
      signal,
      path: item.path,
      label: item.path,
      type: "string",
      origin: item.origin,
      capability: {
        filterable: true,
        groupable: true,
        aggregatable: false,
        fastPath: false,
      },
    })
  }

  return base.sort((left, right) => left.path.localeCompare(right.path))
}

function buildTimeFilter(column: string, startTime?: string, endTime?: string): string {
  const clauses: string[] = []
  if (startTime) clauses.push(`${column} >= toDateTime(${escapeSqlString(startTime)})`)
  if (endTime) clauses.push(`${column} <= toDateTime(${escapeSqlString(endTime)})`)
  return clauses.join(" AND ")
}

function extractFieldPaths(node: QueryBuilderFilterNode | undefined): string[] {
  if (!node) return []
  if (node.kind === "comparison" || node.kind === "exists") return [node.field]
  return node.clauses.flatMap((clause) => extractFieldPaths(clause))
}

function hasOrGroup(node: QueryBuilderFilterNode | undefined): boolean {
  if (!node) return false
  if (node.kind !== "group") return false
  if (node.operator === "OR") return true
  return node.clauses.some((clause) => hasOrGroup(clause))
}

function resolveTraceField(path: string, executionPath: string): ResolvedField | null {
  const normalized = normalizeFieldPath("traces", path)
  const definition =
    TRACE_FIELD_DEFINITIONS.find((field) => field.path === normalized) ??
    (normalized.startsWith("attr.")
      ? {
          signal: "traces",
          path: normalized,
          label: normalized,
          type: "string",
          origin: "span_attribute" as const,
          filterable: true,
          groupable: true,
          aggregatable: false,
          fastPath: false,
        }
      : normalized.startsWith("resource.")
        ? {
            signal: "traces",
            path: normalized,
            label: normalized,
            type: "string",
            origin: "resource_attribute" as const,
            filterable: true,
            groupable: true,
            aggregatable: false,
            fastPath: false,
          }
        : null)

  if (!definition) return null

  const rawExpressions: Record<string, string> = {
    "service.name": "ServiceName",
    "span.name": "SpanName",
    "status.code": "StatusCode",
    "http.method":
      executionPath === "traces_rollup" || executionPath === "traces_spans"
        ? "HttpMethod"
        : "if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method'])",
    "http.route":
      executionPath === "traces_rollup" || executionPath === "traces_spans"
        ? "HttpRoute"
        : "if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target']))",
    "peer.service":
      executionPath === "traces_rollup" || executionPath === "traces_spans"
        ? "PeerService"
        : "SpanAttributes['peer.service']",
    "deployment.environment":
      executionPath === "traces_rollup" || executionPath === "traces_spans"
        ? "DeploymentEnv"
        : "ResourceAttributes['deployment.environment']",
    "deployment.commit_sha":
      executionPath === "traces_rollup" || executionPath === "traces_spans"
        ? "CommitSha"
        : "ResourceAttributes['deployment.commit_sha']",
    root_only:
      executionPath === "traces_rollup"
        ? "IsRoot = 1"
        : "ParentSpanId = ''",
  }

  const expression =
    normalized.startsWith("attr.")
      ? executionPath === "traces_raw"
        ? `SpanAttributes[${escapeSqlString(normalized.slice(5))}]`
        : ""
      : normalized.startsWith("resource.")
        ? executionPath === "traces_raw"
          ? `ResourceAttributes[${escapeSqlString(normalized.slice(9))}]`
          : ""
        : rawExpressions[normalized] ?? ""

  if (!expression) return null

  return {
    definition,
    expression,
    fastCompatible: definition.fastPath,
  }
}

function resolveLogsField(path: string): ResolvedField | null {
  const normalized = normalizeFieldPath("logs", path)
  const definition =
    LOG_FIELD_DEFINITIONS.find((field) => field.path === normalized) ??
    (normalized.startsWith("attr.")
      ? {
          signal: "logs",
          path: normalized,
          label: normalized,
          type: "string",
          origin: "log_attribute" as const,
          filterable: true,
          groupable: true,
          aggregatable: false,
          fastPath: false,
        }
      : normalized.startsWith("resource.")
        ? {
            signal: "logs",
            path: normalized,
            label: normalized,
            type: "string",
            origin: "resource_attribute" as const,
            filterable: true,
            groupable: true,
            aggregatable: false,
            fastPath: false,
          }
        : null)

  if (!definition) return null

  const expression =
    normalized === "service.name"
      ? "ServiceName"
      : normalized === "severity"
        ? "SeverityText"
        : normalized === "body"
          ? "Body"
          : normalized === "trace.id"
            ? "TraceId"
            : normalized === "span.id"
              ? "SpanId"
              : normalized.startsWith("attr.")
                ? `LogAttributes[${escapeSqlString(normalized.slice(5))}]`
                : normalized.startsWith("resource.")
                  ? `ResourceAttributes[${escapeSqlString(normalized.slice(9))}]`
                  : ""

  if (!expression) return null

  return {
    definition,
    expression,
    fastCompatible: false,
  }
}

function resolveMetricsField(path: string): ResolvedField | null {
  const normalized = normalizeFieldPath("metrics", path)
  const definition =
    METRIC_FIELD_DEFINITIONS.find((field) => field.path === normalized) ??
    (normalized.startsWith("attr.")
      ? {
          signal: "metrics",
          path: normalized,
          label: normalized,
          type: "string",
          origin: "metric_attribute" as const,
          filterable: true,
          groupable: true,
          aggregatable: false,
          fastPath: false,
        }
      : normalized.startsWith("resource.")
        ? {
            signal: "metrics",
            path: normalized,
            label: normalized,
            type: "string",
            origin: "resource_attribute" as const,
            filterable: true,
            groupable: true,
            aggregatable: false,
            fastPath: false,
          }
        : null)

  if (!definition) return null

  const expression =
    normalized === "service.name"
      ? "ServiceName"
      : normalized === "metric.name"
        ? "MetricName"
        : normalized === "metric.type"
          ? "metricType"
          : normalized.startsWith("attr.")
            ? `Attributes[${escapeSqlString(normalized.slice(5))}]`
            : normalized.startsWith("resource.")
              ? `ResourceAttributes[${escapeSqlString(normalized.slice(9))}]`
              : ""

  if (!expression) return null

  return {
    definition,
    expression,
    fastCompatible: false,
  }
}

function resolveField(
  signal: BuilderSignal,
  path: string,
  executionPath: string,
): ResolvedField | null {
  if (signal === "traces") return resolveTraceField(path, executionPath)
  if (signal === "logs") return resolveLogsField(path)
  return resolveMetricsField(path)
}

function compileFilterNode(
  signal: BuilderSignal,
  node: QueryBuilderFilterNode,
  executionPath: string,
): string {
  if (node.kind === "group") {
    if (node.clauses.length === 0) return "1 = 1"
    return `(${node.clauses
      .map((clause) => compileFilterNode(signal, clause, executionPath))
      .join(` ${node.operator} `)})`
  }

  const field = resolveField(signal, node.field, executionPath)
  if (!field || !field.definition.filterable) {
    throw new QueryEngineValidationError({
      message: "Unsupported query field",
      details: [`Unknown or unsupported field: ${node.field}`],
    })
  }

  if (node.kind === "exists") {
    return node.negated
      ? `(${field.expression} = '' OR ${field.expression} IS NULL)`
      : `(${field.expression} != '' AND ${field.expression} IS NOT NULL)`
  }

  const operator = node.operator
  if ((operator === "IN" || operator === "NOT IN") && !Array.isArray(node.value)) {
    throw new QueryEngineValidationError({
      message: "Invalid query",
      details: [`${operator} requires a list value for ${node.field}`],
    })
  }

  if ((operator === "CONTAINS" || operator === "NOT CONTAINS") && typeof node.value !== "string") {
    throw new QueryEngineValidationError({
      message: "Invalid query",
      details: [`${operator} requires a string value for ${node.field}`],
    })
  }

  if (operator === "IN" || operator === "NOT IN") {
    const values = (node.value as ReadonlyArray<QueryBuilderScalarValue>).map(quoteScalar)
    return `${field.expression} ${operator === "IN" ? "IN" : "NOT IN"} (${values.join(", ")})`
  }

  if (operator === "CONTAINS" || operator === "NOT CONTAINS") {
    const pattern = String(node.value)
    return `${field.expression} ${operator === "CONTAINS" ? "ILIKE" : "NOT ILIKE"} ${escapeSqlString(`%${pattern}%`)}`
  }

  return `${field.expression} ${operator} ${quoteScalar(
    node.value as QueryBuilderScalarValue,
  )}`
}

function buildMetricsTable(metricType: MetricType): string {
  switch (metricType) {
    case "sum":
      return "metrics_sum"
    case "gauge":
      return "metrics_gauge"
    case "histogram":
      return "metrics_histogram"
    case "exponential_histogram":
      return "metrics_exponential_histogram"
  }
}

function buildMetricValueExpression(metric: string, metricType: MetricType): string {
  if (metricType === "sum" || metricType === "gauge") {
    if (metric === "avg") return "avg(Value)"
    if (metric === "sum") return "sum(Value)"
    if (metric === "min") return "min(Value)"
    if (metric === "max") return "max(Value)"
    return "count()"
  }

  if (metric === "avg") return "if(sum(Count) > 0, sum(Sum) / sum(Count), 0)"
  if (metric === "sum") return "sum(Sum)"
  if (metric === "min") return "min(Min)"
  if (metric === "max") return "max(Max)"
  return "sum(Count)"
}

function buildTraceMetricExpression(metric: string, executionPath: string): string {
  if (executionPath === "traces_rollup") {
    if (metric === "count") return "sum(SpanCount)"
    if (metric === "avg_duration") {
      return "if(sum(DurationCount) > 0, sum(DurationSum) / sum(DurationCount) / 1000000, 0)"
    }
    if (metric === "error_rate") {
      return "if(sum(SpanCount) > 0, sum(ErrorCount) * 100.0 / sum(SpanCount), 0)"
    }
  }

  if (metric === "count") return "count()"
  if (metric === "avg_duration") return "avg(Duration) / 1000000"
  if (metric === "p50_duration") return "quantile(0.5)(Duration) / 1000000"
  if (metric === "p95_duration") return "quantile(0.95)(Duration) / 1000000"
  if (metric === "p99_duration") return "quantile(0.99)(Duration) / 1000000"
  return "if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)"
}

function buildQuerySql(
  query: QueryBuilderRequest,
  plan: ExecutionPlan,
  range: TimeRangeBounds,
): SqlPlan {
  const bucketSeconds =
    query.kind === "timeseries"
      ? query.bucketSeconds ?? computeAutoBucketSeconds(range.startMs, range.endMs)
      : null
  const groupBy = query.groupBy?.[0]?.trim() || ""
  const limit = query.limit ?? DEFAULT_GROUP_LIMIT

  if (query.signal === "traces") {
    const table =
      plan.executionPath === "traces_rollup"
        ? "trace_query_rollup_1m"
        : plan.executionPath === "traces_spans"
          ? "trace_query_spans"
          : "traces"
    const timestampColumn = plan.executionPath === "traces_rollup" ? "Bucket" : "Timestamp"
    const whereClauses = [
      `OrgId = ${escapeSqlString("__ORG_ID__")}`,
      `${timestampColumn} >= toDateTime(${escapeSqlString("__START_TIME__")})`,
      `${timestampColumn} <= toDateTime(${escapeSqlString("__END_TIME__")})`,
    ]

    if (query.filters) {
      whereClauses.push(compileFilterNode("traces", query.filters, plan.executionPath))
    }

    const metricExpression = buildTraceMetricExpression(query.metric, plan.executionPath)

    if (query.kind === "breakdown") {
      const resolvedGroup = resolveField("traces", groupBy || "service.name", plan.executionPath)
      if (!resolvedGroup?.definition.groupable) {
        throw new QueryEngineValidationError({
          message: "Invalid group by",
          details: [`Unsupported trace group by: ${groupBy}`],
        })
      }

      const havingSql = query.having
        ? `HAVING ${compileHavingNode(query.having)}`
        : ""
      const orderBy = resolveOrderBy(query.orderBy, "value")

      return {
        sql: `
          SELECT
            ${resolvedGroup.expression} AS name,
            ${metricExpression} AS value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY name
          ${havingSql}
          ORDER BY ${orderBy}
          LIMIT ${limit}
        `,
        valueField: "value",
        resultKind: "breakdown",
      }
    }

    const bucketExpr = `toStartOfInterval(${timestampColumn}, INTERVAL ${bucketSeconds ?? 60} SECOND)`
    if (!groupBy || groupBy === "none") {
      return {
        sql: `
          SELECT
            ${bucketExpr} AS bucket,
            'all' AS groupName,
            ${metricExpression} AS value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY bucket
          ORDER BY bucket ASC
        `,
        valueField: "value",
        resultKind: "timeseries",
      }
    }

    const resolvedGroup = resolveField("traces", groupBy, plan.executionPath)
    if (!resolvedGroup?.definition.groupable) {
      throw new QueryEngineValidationError({
        message: "Invalid group by",
        details: [`Unsupported trace group by: ${groupBy}`],
      })
    }

    const topOrderBy = resolveOrderBy(query.orderBy, "group_value")
    const havingSql = query.having ? `HAVING ${compileHavingNode(query.having)}` : ""

    return {
      sql: `
        WITH top_groups AS (
          SELECT
            ${resolvedGroup.expression} AS group_name,
            ${metricExpression} AS group_value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY group_name
          ${havingSql}
          ORDER BY ${topOrderBy}
          LIMIT ${limit}
        )
        SELECT
          ${bucketExpr} AS bucket,
          ${resolvedGroup.expression} AS groupName,
          ${metricExpression} AS value
        FROM ${table}
        WHERE ${whereClauses.join("\n          AND ")}
          AND ${resolvedGroup.expression} IN (SELECT group_name FROM top_groups)
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
      `,
      valueField: "value",
      resultKind: "timeseries",
    }
  }

  if (query.signal === "logs") {
    const table = "logs"
    const whereClauses = [
      `OrgId = ${escapeSqlString("__ORG_ID__")}`,
      `Timestamp >= toDateTime(${escapeSqlString("__START_TIME__")})`,
      `Timestamp <= toDateTime(${escapeSqlString("__END_TIME__")})`,
    ]
    if (query.filters) whereClauses.push(compileFilterNode("logs", query.filters, "logs_raw"))

    if (query.kind === "breakdown") {
      const resolvedGroup = resolveField("logs", groupBy || "service.name", "logs_raw")
      if (!resolvedGroup?.definition.groupable) {
        throw new QueryEngineValidationError({
          message: "Invalid group by",
          details: [`Unsupported logs group by: ${groupBy}`],
        })
      }
      const havingSql = query.having ? `HAVING ${compileHavingNode(query.having)}` : ""

      return {
        sql: `
          SELECT
            ${resolvedGroup.expression} AS name,
            count() AS value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY name
          ${havingSql}
          ORDER BY ${resolveOrderBy(query.orderBy, "value")}
          LIMIT ${limit}
        `,
        valueField: "value",
        resultKind: "breakdown",
      }
    }

    const bucketExpr = `toStartOfInterval(Timestamp, INTERVAL ${bucketSeconds ?? 60} SECOND)`
    if (!groupBy || groupBy === "none") {
      return {
        sql: `
          SELECT
            ${bucketExpr} AS bucket,
            'all' AS groupName,
            count() AS value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY bucket
          ORDER BY bucket ASC
        `,
        valueField: "value",
        resultKind: "timeseries",
      }
    }

    const resolvedGroup = resolveField("logs", groupBy, "logs_raw")
    if (!resolvedGroup?.definition.groupable) {
      throw new QueryEngineValidationError({
        message: "Invalid group by",
        details: [`Unsupported logs group by: ${groupBy}`],
      })
    }

    return {
      sql: `
        WITH top_groups AS (
          SELECT
            ${resolvedGroup.expression} AS group_name,
            count() AS group_value
          FROM ${table}
          WHERE ${whereClauses.join("\n            AND ")}
          GROUP BY group_name
          ORDER BY ${resolveOrderBy(query.orderBy, "group_value")}
          LIMIT ${limit}
        )
        SELECT
          ${bucketExpr} AS bucket,
          ${resolvedGroup.expression} AS groupName,
          count() AS value
        FROM ${table}
        WHERE ${whereClauses.join("\n          AND ")}
          AND ${resolvedGroup.expression} IN (SELECT group_name FROM top_groups)
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
      `,
      valueField: "value",
      resultKind: "timeseries",
    }
  }

  const metricType = query.metricType
  if (!metricType || !query.metricName) {
    throw new QueryEngineValidationError({
      message: "Invalid metrics query",
      details: ["Metrics queries require metricName and metricType"],
    })
  }
  const table = buildMetricsTable(metricType)
  const metricExpression = buildMetricValueExpression(query.metric, metricType)
  const whereClauses = [
    `OrgId = ${escapeSqlString("__ORG_ID__")}`,
    `TimeUnix >= toDateTime(${escapeSqlString("__START_TIME__")})`,
    `TimeUnix <= toDateTime(${escapeSqlString("__END_TIME__")})`,
    `MetricName = ${escapeSqlString(query.metricName)}`,
  ]
  if (query.filters) whereClauses.push(compileFilterNode("metrics", query.filters, "metrics_raw"))

  if (query.kind === "breakdown") {
    const resolvedGroup = resolveField("metrics", groupBy || "service.name", "metrics_raw")
    if (!resolvedGroup?.definition.groupable) {
      throw new QueryEngineValidationError({
        message: "Invalid group by",
        details: [`Unsupported metrics group by: ${groupBy}`],
      })
    }
    const havingSql = query.having ? `HAVING ${compileHavingNode(query.having)}` : ""

    return {
      sql: `
        SELECT
          ${resolvedGroup.expression} AS name,
          ${metricExpression} AS value
        FROM ${table}
        WHERE ${whereClauses.join("\n          AND ")}
        GROUP BY name
        ${havingSql}
        ORDER BY ${resolveOrderBy(query.orderBy, "value")}
        LIMIT ${limit}
      `,
      valueField: "value",
      resultKind: "breakdown",
    }
  }

  const bucketExpr = `toStartOfInterval(TimeUnix, INTERVAL ${bucketSeconds ?? 60} SECOND)`
  if (!groupBy || groupBy === "none") {
    return {
      sql: `
        SELECT
          ${bucketExpr} AS bucket,
          'all' AS groupName,
          ${metricExpression} AS value
        FROM ${table}
        WHERE ${whereClauses.join("\n          AND ")}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      valueField: "value",
      resultKind: "timeseries",
    }
  }

  const resolvedGroup = resolveField("metrics", groupBy, "metrics_raw")
  if (!resolvedGroup?.definition.groupable) {
    throw new QueryEngineValidationError({
      message: "Invalid group by",
      details: [`Unsupported metrics group by: ${groupBy}`],
    })
  }

  return {
    sql: `
      WITH top_groups AS (
        SELECT
          ${resolvedGroup.expression} AS group_name,
          ${metricExpression} AS group_value
        FROM ${table}
        WHERE ${whereClauses.join("\n          AND ")}
        GROUP BY group_name
        ORDER BY ${resolveOrderBy(query.orderBy, "group_value")}
        LIMIT ${limit}
      )
      SELECT
        ${bucketExpr} AS bucket,
        ${resolvedGroup.expression} AS groupName,
        ${metricExpression} AS value
      FROM ${table}
      WHERE ${whereClauses.join("\n        AND ")}
        AND ${resolvedGroup.expression} IN (SELECT group_name FROM top_groups)
      GROUP BY bucket, groupName
      ORDER BY bucket ASC, groupName ASC
    `,
    valueField: "value",
    resultKind: "timeseries",
  }
}

function compileHavingNode(node: QueryBuilderFilterNode): string {
  if (node.kind === "group") {
    return `(${node.clauses.map(compileHavingNode).join(` ${node.operator} `)})`
  }

  if (node.kind === "exists") {
    throw new QueryEngineValidationError({
      message: "Invalid having clause",
      details: ["HAVING supports only comparison expressions on value"],
    })
  }

  if (normalizeFieldPath("metrics", node.field) !== "value" && node.field.toLowerCase() !== "value") {
    throw new QueryEngineValidationError({
      message: "Invalid having clause",
      details: [`Unsupported HAVING field: ${node.field}`],
    })
  }

  if ((node.operator === "IN" || node.operator === "NOT IN") && Array.isArray(node.value)) {
    const values = node.value.map(quoteScalar)
    return `value ${node.operator === "IN" ? "IN" : "NOT IN"} (${values.join(", ")})`
  }

  if (node.operator === "CONTAINS" || node.operator === "NOT CONTAINS") {
    throw new QueryEngineValidationError({
      message: "Invalid having clause",
      details: ["HAVING does not support CONTAINS operators"],
    })
  }

  return `value ${node.operator} ${quoteScalar(node.value as QueryBuilderScalarValue)}`
}

function resolveOrderBy(orderBy: QueryBuilderRequest["orderBy"], valueAlias: string): string {
  if (!orderBy) {
    return `${valueAlias} DESC`
  }

  const field = orderBy.field.trim().toLowerCase()
  const direction = String(orderBy.direction).toUpperCase() === "ASC" ? "ASC" : "DESC"
  if (field === "name" || field === "group" || field === "group_name") {
    return `group_name ${direction}`
  }

  if (field === "value" || field === valueAlias.toLowerCase()) {
    return `${valueAlias} ${direction}`
  }

  return `${valueAlias} ${direction}`
}

function substituteSqlTemplate(
  sql: string,
  tenant: TenantContext,
  input: { startTime: string; endTime: string },
): string {
  return sql
    .replaceAll(escapeSqlString("__ORG_ID__"), escapeSqlString(tenant.orgId))
    .replaceAll(escapeSqlString("__START_TIME__"), escapeSqlString(input.startTime))
    .replaceAll(escapeSqlString("__END_TIME__"), escapeSqlString(input.endTime))
}

function buildTimeseriesResult(
  signal: BuilderSignal,
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryEngineExecuteResponse["result"] {
  const buckets = new Map<string, Record<string, number>>()

  for (const row of rows) {
    const bucket = String(row.bucket ?? "")
    const groupName = String(row.groupName ?? "all")
    const value = Number(row.value ?? 0)
    const bucketEntry = buckets.get(bucket) ?? {}
    bucketEntry[groupName] = Number.isFinite(value) ? value : 0
    buckets.set(bucket, bucketEntry)
  }

  return {
    kind: "timeseries",
    source: signal,
    data: [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, series]) => ({ bucket, series })),
  }
}

function buildBreakdownResult(
  signal: BuilderSignal,
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryEngineExecuteResponse["result"] {
  return {
    kind: "breakdown",
    source: signal,
    data: rows.map(
      (row) =>
        ({
          name: String(row.name ?? ""),
          value: Number(row.value ?? 0),
        }) satisfies BreakdownItem,
    ),
  }
}

function stableCacheKey(prefix: string, tenant: TenantContext, value: unknown): string {
  return `${prefix}:${tenant.orgId}:${JSON.stringify(value)}`
}

function getCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function setCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T, ttlMs: number): void {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  })
}

function countGroupLimit(query: QueryBuilderRequest): number {
  return query.groupBy?.length && query.groupBy[0] && query.groupBy[0].trim().toLowerCase() !== "none"
    ? query.limit ?? DEFAULT_GROUP_LIMIT
    : 1
}

function normalizeQuery(query: QueryBuilderRequest, range: TimeRangeBounds): QueryBuilderRequest {
  const bucketSeconds =
    query.kind === "timeseries"
      ? query.bucketSeconds ?? computeAutoBucketSeconds(range.startMs, range.endMs)
      : undefined

  return {
    ...query,
    groupBy:
      query.groupBy?.map((field) => normalizeFieldPath(query.signal, field)).filter(Boolean) ?? [],
    bucketSeconds,
    limit: query.limit ?? (query.kind === "breakdown" || query.groupBy?.length ? DEFAULT_GROUP_LIMIT : undefined),
  }
}

function buildPlan(
  query: QueryBuilderRequest,
  range: TimeRangeBounds,
): ExecutionPlan {
  const normalized = normalizeQuery(query, range)
  const bucketSeconds =
    normalized.kind === "timeseries"
      ? normalized.bucketSeconds ?? computeAutoBucketSeconds(range.startMs, range.endMs)
      : 0
  const estimatedBuckets =
    normalized.kind === "timeseries"
      ? Math.ceil(range.rangeSeconds / Math.max(bucketSeconds, 1))
      : 1
  const estimatedSeriesLimit = countGroupLimit(normalized)
  const warnings: Array<{ code: PlannerReasonCode; message: string }> = []

  if (normalized.groupBy && normalized.groupBy.length > 1) {
    throw new QueryEngineValidationError({
      message: "Invalid query",
      details: ["v1 supports at most one group-by field"],
    })
  }

  if (estimatedBuckets > MAX_BUCKETS) {
    throw new QueryEngineValidationError({
      message: "Timeseries query too expensive",
      details: [`Requested ${estimatedBuckets} buckets, maximum is ${MAX_BUCKETS}`],
    })
  }

  if (estimatedSeriesLimit > MAX_GROUP_LIMIT) {
    throw new QueryEngineValidationError({
      message: "Grouped query too expensive",
      details: [`Maximum supported limit is ${MAX_GROUP_LIMIT}`],
    })
  }

  if (normalized.signal === "traces" && !tracesMetrics.has(normalized.metric)) {
    throw new QueryEngineValidationError({
      message: "Unsupported traces metric",
      details: [normalized.metric],
    })
  }

  if (normalized.signal === "logs" && normalized.metric !== "count") {
    throw new QueryEngineValidationError({
      message: "Unsupported logs metric",
      details: [normalized.metric],
    })
  }

  if (normalized.signal === "metrics") {
    if (!metricsMetrics.has(normalized.metric)) {
      throw new QueryEngineValidationError({
        message: "Unsupported metrics metric",
        details: [normalized.metric],
      })
    }
    if (!normalized.metricName || !normalized.metricType) {
      throw new QueryEngineValidationError({
        message: "Invalid metrics query",
        details: ["metricName and metricType are required"],
      })
    }
  }

  const filterFields = [
    ...extractFieldPaths(normalized.filters),
    ...(normalized.groupBy ?? []),
  ]

  const usesDynamicField = filterFields.some(
    (field) =>
      normalizeFieldPath(normalized.signal, field).startsWith("attr.") ||
      normalizeFieldPath(normalized.signal, field).startsWith("resource."),
  )

  const usesOr = hasOrGroup(normalized.filters) || hasOrGroup(normalized.having)

  if (
    normalized.signal === "traces" &&
    ["p50_duration", "p95_duration", "p99_duration"].includes(normalized.metric) &&
    range.rangeSeconds > 7 * 24 * 60 * 60 &&
    !extractFieldPaths(normalized.filters).includes("service.name")
  ) {
    throw new QueryEngineValidationError({
      message: "Percentile query too expensive",
      details: ["Percentile trace queries over 7d require a service.name filter"],
    })
  }

  let classification: PlannerClassification = "sync_bounded"
  let executionPath = normalized.signal === "traces" ? "traces_raw" : `${normalized.signal}_raw`

  if (normalized.signal === "traces") {
    const fastOnly = filterFields.every((field) => {
      const resolved = resolveField("traces", field, "traces_spans")
      return Boolean(resolved?.definition.fastPath)
    })

    if (!usesDynamicField && !usesOr && fastOnly) {
      classification = "sync_fast"
      executionPath =
        normalized.metric === "count" ||
        normalized.metric === "avg_duration" ||
        normalized.metric === "error_rate"
          ? "traces_rollup"
          : "traces_spans"
      warnings.push({
        code: "fast_path_eligible",
        message: `Trace query routed to ${executionPath}`,
      })
    } else {
      warnings.push({
        code: usesDynamicField ? "dynamic_field_scan" : "boolean_expression",
        message: usesDynamicField
          ? "Query uses dynamic fields and will run on the bounded raw trace path"
          : "Query uses boolean grouping and will run on the bounded raw trace path",
      })
    }
  } else {
    warnings.push({
      code: "dynamic_field_scan",
      message: "Logs and metrics use the bounded raw path in v1",
    })
  }

  if (estimatedSeriesLimit > DEFAULT_GROUP_LIMIT) {
    warnings.push({
      code: "series_limit_applied",
      message: `Planner will use a grouped series limit of ${estimatedSeriesLimit}`,
    })
  }

  if (estimatedBuckets > TARGET_BUCKETS) {
    warnings.push({
      code: "bucket_limit_applied",
      message: `Planner selected ${estimatedBuckets} buckets`,
    })
  }

  if (classification === "sync_bounded" && !normalized.allowSlowPath) {
    warnings.push({
      code: "slow_path_confirmation_required",
      message: "This query requires allowSlowPath=true to run on the bounded path",
    })
  }

  return {
    classification,
    executionPath,
    normalizedQuery: normalized,
    estimatedBuckets,
    estimatedSeriesLimit,
    warnings,
  }
}

function rowsToStringValues(rows: ReadonlyArray<Record<string, unknown>>, key: string): string[] {
  const seen = new Set<string>()
  const values: string[] = []

  for (const row of rows) {
    const raw = row[key]
    const next = String(raw ?? "").trim()
    if (!next || seen.has(next)) continue
    seen.add(next)
    values.push(next)
  }

  return values
}

export class QueryBuilderService extends ServiceMap.Service<QueryBuilderService, QueryBuilderServiceShape>()(
  "QueryBuilderService",
  {
    make: Effect.gen(function* () {
      const tinybird = yield* TinybirdService

      const metadata = Effect.fn("QueryBuilderService.metadata")(function* (
        tenant: TenantContext,
        input: {
          signal: BuilderSignal
          startTime?: string
          endTime?: string
          limit?: number
        },
      ) {
        const limit = input.limit ?? DEFAULT_FIELD_LIMIT

        const rows = yield* Effect.tryPromise({
          try: async () => {
            if (input.signal === "traces") {
              const [spanRows, resourceRows] = await Promise.all([
                Effect.runPromise(
                  tinybird.query(tenant, {
                    pipe: "span_attribute_keys",
                    params: {
                      start_time: input.startTime,
                      end_time: input.endTime,
                      limit,
                    },
                  }),
                ),
                Effect.runPromise(
                  tinybird.query(tenant, {
                    pipe: "resource_attribute_keys",
                    params: {
                      start_time: input.startTime,
                      end_time: input.endTime,
                      limit,
                    },
                  }),
                ),
              ])

              return [
                ...spanRows.data.map((row) => ({
                  path: `attr.${String((row as { attributeKey?: unknown }).attributeKey ?? "")}`,
                  origin: "span_attribute" as const,
                })),
                ...resourceRows.data.map((row) => ({
                  path: `resource.${String((row as { attributeKey?: unknown }).attributeKey ?? "")}`,
                  origin: "resource_attribute" as const,
                })),
              ]
            }

            if (input.signal === "logs") {
              const timeFilter = buildTimeFilter("Timestamp", input.startTime, input.endTime)
              const where = [
                `OrgId = ${escapeSqlString(tenant.orgId)}`,
                timeFilter,
              ]
                .filter(Boolean)
                .join(" AND ")
              const [logAttrRows, resourceRows] = await Promise.all([
                Effect.runPromise(
                  tinybird.sql(
                    tenant,
                    `
                      SELECT arrayJoin(mapKeys(LogAttributes)) AS attributeKey
                      FROM logs
                      WHERE ${where}
                        AND LogAttributes != map()
                      GROUP BY attributeKey
                      ORDER BY count() DESC
                      LIMIT ${limit}
                    `,
                  ),
                ),
                Effect.runPromise(
                  tinybird.sql(
                    tenant,
                    `
                      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS attributeKey
                      FROM logs
                      WHERE ${where}
                        AND ResourceAttributes != map()
                      GROUP BY attributeKey
                      ORDER BY count() DESC
                      LIMIT ${limit}
                    `,
                  ),
                ),
              ])

              return [
                ...logAttrRows.map((row) => ({
                  path: `attr.${String(row.attributeKey ?? "")}`,
                  origin: "log_attribute" as const,
                })),
                ...resourceRows.map((row) => ({
                  path: `resource.${String(row.attributeKey ?? "")}`,
                  origin: "resource_attribute" as const,
                })),
              ]
            }

            const tables = ["metrics_sum", "metrics_gauge", "metrics_histogram", "metrics_exponential_histogram"]
            const metricAttrRows: Array<{ path: string; origin: "metric_attribute" | "resource_attribute" }> = []

            for (const table of tables) {
              const timeFilter = buildTimeFilter("TimeUnix", input.startTime, input.endTime)
              const where = [
                `OrgId = ${escapeSqlString(tenant.orgId)}`,
                timeFilter,
              ]
                .filter(Boolean)
                .join(" AND ")

              const [attrRows, resourceRows] = await Promise.all([
                Effect.runPromise(
                  tinybird.sql(
                    tenant,
                    `
                      SELECT arrayJoin(mapKeys(Attributes)) AS attributeKey
                      FROM ${table}
                      WHERE ${where}
                        AND Attributes != map()
                      GROUP BY attributeKey
                      ORDER BY count() DESC
                      LIMIT ${limit}
                    `,
                  ),
                ),
                Effect.runPromise(
                  tinybird.sql(
                    tenant,
                    `
                      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS attributeKey
                      FROM ${table}
                      WHERE ${where}
                        AND ResourceAttributes != map()
                      GROUP BY attributeKey
                      ORDER BY count() DESC
                      LIMIT ${limit}
                    `,
                  ),
                ),
              ])

              metricAttrRows.push(
                ...attrRows.map((row) => ({
                  path: `attr.${String(row.attributeKey ?? "")}`,
                  origin: "metric_attribute" as const,
                })),
                ...resourceRows.map((row) => ({
                  path: `resource.${String(row.attributeKey ?? "")}`,
                  origin: "resource_attribute" as const,
                })),
              )
            }

            return metricAttrRows
          },
          catch: (error) =>
            new QueryEngineExecutionError({
              message: error instanceof Error ? error.message : "Failed to load builder metadata",
            }),
        })

        return new QueryBuilderMetadataResponse({
          fields: buildMetadataItems(input.signal, rows),
        })
      })

      const fieldValues = Effect.fn("QueryBuilderService.fieldValues")(function* (
        tenant: TenantContext,
        input: {
          signal: BuilderSignal
          field: string
          startTime?: string
          endTime?: string
          query?: string
          limit?: number
        },
      ) {
        const limit = input.limit ?? DEFAULT_VALUE_LIMIT
        const normalizedField = normalizeFieldPath(input.signal, input.field)
        const likeClause = input.query?.trim()
          ? `AND value ILIKE ${escapeSqlString(`%${input.query.trim()}%`)}`
          : ""

        const rows = yield* Effect.tryPromise({
          try: async () => {
            if (input.signal === "traces") {
              const resolved = resolveField("traces", normalizedField, "traces_raw")
              if (!resolved) {
                throw new QueryEngineValidationError({
                  message: "Unknown field",
                  details: [input.field],
                })
              }
              const timeFilter = buildTimeFilter("Timestamp", input.startTime, input.endTime)
              return await Effect.runPromise(
                tinybird.sql(
                  tenant,
                  `
                    SELECT value
                    FROM (
                      SELECT ${resolved.expression} AS value, count() AS usageCount
                      FROM traces
                      WHERE OrgId = ${escapeSqlString(tenant.orgId)}
                        ${timeFilter ? `AND ${timeFilter}` : ""}
                        AND ${resolved.expression} != ''
                      GROUP BY value
                    )
                    WHERE 1 = 1
                      ${likeClause}
                    ORDER BY usageCount DESC
                    LIMIT ${limit}
                  `,
                ),
              )
            }

            if (input.signal === "logs") {
              const resolved = resolveField("logs", normalizedField, "logs_raw")
              if (!resolved) {
                throw new QueryEngineValidationError({
                  message: "Unknown field",
                  details: [input.field],
                })
              }
              const timeFilter = buildTimeFilter("Timestamp", input.startTime, input.endTime)
              return await Effect.runPromise(
                tinybird.sql(
                  tenant,
                  `
                    SELECT value
                    FROM (
                      SELECT ${resolved.expression} AS value, count() AS usageCount
                      FROM logs
                      WHERE OrgId = ${escapeSqlString(tenant.orgId)}
                        ${timeFilter ? `AND ${timeFilter}` : ""}
                        AND ${resolved.expression} != ''
                      GROUP BY value
                    )
                    WHERE 1 = 1
                      ${likeClause}
                    ORDER BY usageCount DESC
                    LIMIT ${limit}
                  `,
                ),
              )
            }

            const tables = ["metrics_sum", "metrics_gauge", "metrics_histogram", "metrics_exponential_histogram"]
            const values: string[] = []

            for (const table of tables) {
              const resolved = resolveField("metrics", normalizedField, "metrics_raw")
              if (!resolved) continue
              const timeFilter = buildTimeFilter("TimeUnix", input.startTime, input.endTime)
              const rows = await Effect.runPromise(
                tinybird.sql(
                  tenant,
                  `
                    SELECT value
                    FROM (
                      SELECT ${resolved.expression} AS value, count() AS usageCount
                      FROM ${table}
                      WHERE OrgId = ${escapeSqlString(tenant.orgId)}
                        ${timeFilter ? `AND ${timeFilter}` : ""}
                        AND ${resolved.expression} != ''
                      GROUP BY value
                    )
                    WHERE 1 = 1
                      ${likeClause}
                    ORDER BY usageCount DESC
                    LIMIT ${limit}
                  `,
                ),
              )

              values.push(...rowsToStringValues(rows, "value"))
              if (values.length >= limit) break
            }

            return values.slice(0, limit).map((value) => ({ value }))
          },
          catch: (error) =>
            error instanceof QueryEngineValidationError
              ? error
              : new QueryEngineExecutionError({
                  message: error instanceof Error ? error.message : "Failed to load field values",
                }),
        }).pipe(
          Effect.catchTag("QueryEngineValidationError", (error) => Effect.fail(error)),
        )

        return new QueryBuilderFieldValuesResponse({
          values: rowsToStringValues(rows, "value"),
        })
      })

      const plan = Effect.fn("QueryBuilderService.plan")(function* (
        tenant: TenantContext,
        input: {
          startTime: string
          endTime: string
          query: QueryBuilderRequest
        },
      ) {
        const cacheKey = stableCacheKey("plan", tenant, input)
        const cached = getCached(plannerCache, cacheKey)
        if (cached) return cached

        const result = yield* Effect.try({
          try: () => {
            const range = getRangeBounds(input.startTime, input.endTime)
            const built = buildPlan(input.query, range)
            return new QueryBuilderPlanResponse({
              plan: {
                classification: built.classification,
                executionPath: built.executionPath,
                normalizedQuery: built.normalizedQuery,
                estimatedBuckets: built.estimatedBuckets,
                estimatedSeriesLimit: built.estimatedSeriesLimit,
                warnings: built.warnings,
              },
            })
          },
          catch: (error) =>
            error instanceof QueryEngineValidationError
              ? error
              : new QueryEngineExecutionError({
                  message: error instanceof Error ? error.message : "Failed to build query plan",
                }),
        }).pipe(
          Effect.catchTag("QueryEngineValidationError", (error) => Effect.fail(error)),
        )

        setCached(plannerCache, cacheKey, result, DEFAULT_PLANNER_CACHE_TTL_MS)
        return result
      })

      const execute = Effect.fn("QueryBuilderService.execute")(function* (
        tenant: TenantContext,
        input: {
          startTime: string
          endTime: string
          query: QueryBuilderRequest
        },
      ) {
        const range = yield* Effect.try({
          try: () => getRangeBounds(input.startTime, input.endTime),
          catch: (error) =>
            error instanceof QueryEngineValidationError
              ? error
              : new QueryEngineValidationError({
                  message: "Invalid time range",
                  details: [error instanceof Error ? error.message : "Unknown error"],
                }),
        })

        const planned = yield* plan(tenant, input)
        if (
          planned.plan.classification === "sync_bounded" &&
          !planned.plan.normalizedQuery.allowSlowPath
        ) {
          return yield* new QueryEngineValidationError({
            message: "Planner confirmation required",
            details: planned.plan.warnings.map((warning) => warning.message),
          })
        }

        const shouldBypassCache = range.endMs >= Date.now() - NEWEST_DATA_CACHE_BYPASS_MS
        const cacheKey = stableCacheKey("execute", tenant, {
          ...input,
          query: planned.plan.normalizedQuery,
        })
        if (!shouldBypassCache) {
          const cached = getCached(resultCache, cacheKey)
          if (cached) return cached
        }

        const sqlPlan = yield* Effect.try({
          try: () => buildQuerySql(planned.plan.normalizedQuery, planned.plan, range),
          catch: (error) =>
            error instanceof QueryEngineValidationError
              ? error
              : new QueryEngineExecutionError({
                  message: error instanceof Error ? error.message : "Failed to compile SQL",
                }),
        }).pipe(
          Effect.catchTag("QueryEngineValidationError", (error) => Effect.fail(error)),
        )

        const sql = substituteSqlTemplate(sqlPlan.sql, tenant, input)
        const rows = yield* tinybird.sql(tenant, sql).pipe(
          Effect.mapError(
            (error) =>
              new QueryEngineExecutionError({
                message: error instanceof Error ? error.message : "Tinybird SQL execution failed",
              }),
          ),
        )

        const result =
          sqlPlan.resultKind === "timeseries"
            ? buildTimeseriesResult(planned.plan.normalizedQuery.signal, rows)
            : buildBreakdownResult(planned.plan.normalizedQuery.signal, rows)

        const response = new QueryBuilderExecuteResponse({
          plan: planned.plan,
          result,
        })

        if (!shouldBypassCache && planned.plan.classification === "sync_fast") {
          setCached(resultCache, cacheKey, response, DEFAULT_RESULT_CACHE_TTL_MS)
        }

        return response
      })

      return {
        metadata,
        fieldValues,
        plan,
        execute,
      } satisfies QueryBuilderServiceShape
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(TinybirdService.layer),
  )
}

export const __testables = {
  normalizeFieldPath,
  buildPlan,
  buildQuerySql,
  compileFilterNode,
}
