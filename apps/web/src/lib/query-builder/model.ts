import type { QueryBuilderRequest } from "@maple/domain"
import {
  QueryBuilderParseError,
  parseFilterExpression,
} from "@/lib/query-builder/filter-language"

export type QueryBuilderDataSource = "traces" | "logs" | "metrics"
export type QueryBuilderAddOnKey = "groupBy" | "having" | "orderBy" | "limit" | "legend"
export type QueryBuilderMetricType = "sum" | "gauge" | "histogram" | "exponential_histogram"

export interface QueryBuilderQueryDraft {
  id: string
  name: string
  enabled: boolean
  dataSource: QueryBuilderDataSource
  signalSource: "default" | "meter"
  metricName: string
  metricType: QueryBuilderMetricType
  whereClause: string
  aggregation: string
  stepInterval: string
  orderByDirection: "desc" | "asc"
  addOns: Record<QueryBuilderAddOnKey, boolean>
  groupBy: string
  having: string
  orderBy: string
  limit: string
  legend: string
}

export interface BuildSpecResult {
  query: QueryBuilderRequest | null
  warnings: string[]
  error: string | null
}

export const AGGREGATIONS_BY_SOURCE: Record<
  QueryBuilderDataSource,
  Array<{ label: string; value: string }>
> = {
  traces: [
    { label: "count", value: "count" },
    { label: "avg(duration)", value: "avg_duration" },
    { label: "p50(duration)", value: "p50_duration" },
    { label: "p95(duration)", value: "p95_duration" },
    { label: "p99(duration)", value: "p99_duration" },
    { label: "error_rate", value: "error_rate" },
  ],
  logs: [{ label: "count", value: "count" }],
  metrics: [
    { label: "avg", value: "avg" },
    { label: "sum", value: "sum" },
    { label: "min", value: "min" },
    { label: "max", value: "max" },
    { label: "count", value: "count" },
  ],
}

export const QUERY_BUILDER_METRIC_TYPES: readonly QueryBuilderMetricType[] = [
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
] as const

export const GROUP_BY_OPTIONS: Record<
  QueryBuilderDataSource,
  Array<{ label: string; value: string }>
> = {
  traces: [
    { label: "service.name", value: "service.name" },
    { label: "span.name", value: "span.name" },
    { label: "status.code", value: "status.code" },
    { label: "http.method", value: "http.method" },
    { label: "none", value: "none" },
  ],
  logs: [
    { label: "service.name", value: "service.name" },
    { label: "severity", value: "severity" },
    { label: "none", value: "none" },
  ],
  metrics: [
    { label: "service.name", value: "service.name" },
    { label: "none", value: "none" },
  ],
}

const QUERY_BADGE_COLORS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-4",
  "bg-chart-5",
  "bg-chart-3",
] as const

export function queryBadgeColor(index: number): string {
  return QUERY_BADGE_COLORS[index % QUERY_BADGE_COLORS.length]
}

function defaultWhereClause(): string {
  return ""
}

export function queryLabel(index: number): string {
  return String.fromCharCode(65 + index)
}

export function formulaLabel(index: number): string {
  return `F${index + 1}`
}

export function createQueryDraft(index: number): QueryBuilderQueryDraft {
  const isDefaultErrorRateQuery = index === 0

  return {
    id: crypto.randomUUID(),
    name: queryLabel(index),
    enabled: true,
    dataSource: "traces",
    signalSource: "default",
    metricName: "",
    metricType: "gauge",
    whereClause: defaultWhereClause(),
    aggregation: isDefaultErrorRateQuery ? "error_rate" : "count",
    stepInterval: "60",
    orderByDirection: "desc",
    addOns: {
      groupBy: true,
      having: false,
      orderBy: false,
      limit: false,
      legend: false,
    },
    groupBy: "service.name",
    having: "",
    orderBy: "",
    limit: "",
    legend: "",
  }
}

export interface QueryBuilderFormulaDraft {
  id: string
  name: string
  expression: string
  legend: string
}

export function createFormulaDraft(
  index: number,
  queryNames: string[]
): QueryBuilderFormulaDraft {
  const [first = "A", second = "B"] = queryNames

  return {
    id: crypto.randomUUID(),
    name: formulaLabel(index),
    expression: `${first} / ${second}`,
    legend: "Error ratio",
  }
}

export function resetQueryForDataSource(
  query: QueryBuilderQueryDraft,
  dataSource: QueryBuilderDataSource
): QueryBuilderQueryDraft {
  return {
    ...query,
    dataSource,
    aggregation: AGGREGATIONS_BY_SOURCE[dataSource][0].value,
    metricName: dataSource === "metrics" ? query.metricName : "",
  }
}

function parsePositiveInteger(raw: string): number | undefined {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function normalizeGroupBy(
  dataSource: QueryBuilderDataSource,
  raw: string,
): string[] | undefined {
  const token = raw.trim().toLowerCase()
  if (!token || token === "none" || token === "all") return undefined

  if (dataSource === "traces") {
    if (token === "service") return ["service.name"]
    if (token === "span") return ["span.name"]
    if (token === "status") return ["status.code"]
  }

  if (token === "service") return ["service.name"]
  return [token]
}

function parseBucketSeconds(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return undefined

  const shorthand = trimmed.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/)
  if (!shorthand) {
    return undefined
  }

  const amount = Number.parseInt(shorthand[1], 10)
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined
  }

  const unit = shorthand[2]
  if (!unit || unit.startsWith("s") || unit.startsWith("sec") || unit.startsWith("second")) {
    return amount
  }

  if (unit.startsWith("m") || unit.startsWith("min")) {
    return amount * 60
  }

  if (unit.startsWith("h") || unit.startsWith("hr") || unit.startsWith("hour")) {
    return amount * 60 * 60
  }

  if (unit.startsWith("d") || unit.startsWith("day")) {
    return amount * 60 * 60 * 24
  }

  return undefined
}

export function buildTimeseriesQuerySpec(
  query: QueryBuilderQueryDraft
): BuildSpecResult {
  const warnings: string[] = []
  let filters: QueryBuilderRequest["filters"] | undefined
  let having: QueryBuilderRequest["having"] | undefined

  const bucketSeconds = parseBucketSeconds(query.stepInterval)
  if (query.stepInterval.trim() && !bucketSeconds) {
    warnings.push("Invalid step interval ignored; auto interval will be used")
  }

  try {
    filters = parseFilterExpression(query.whereClause) ?? undefined
  } catch (error) {
    if (error instanceof QueryBuilderParseError) {
      return {
        query: null,
        warnings,
        error: `Where clause parse error at ${error.index + 1}: ${error.message}`,
      }
    }
    throw error
  }

  if (query.addOns.having && query.having.trim()) {
    try {
      having = parseFilterExpression(query.having) ?? undefined
    } catch (error) {
      if (error instanceof QueryBuilderParseError) {
        return {
          query: null,
          warnings,
          error: `Having parse error at ${error.index + 1}: ${error.message}`,
        }
      }
      throw error
    }
  }

  const groupBy = query.addOns.groupBy
    ? normalizeGroupBy(query.dataSource, query.groupBy)
    : undefined
  const limit = query.addOns.limit ? parsePositiveInteger(query.limit) : undefined
  if (query.addOns.limit && query.limit.trim() && !limit) {
    return {
      query: null,
      warnings,
      error: "Limit must be a positive integer",
    }
  }

  const orderBy =
    query.addOns.orderBy && query.orderBy.trim()
      ? {
          field: query.orderBy.trim().toLowerCase(),
          direction: query.orderByDirection,
        }
      : undefined

  if (query.dataSource === "traces") {
    const allowedMetrics = new Set([
      "count",
      "avg_duration",
      "p50_duration",
      "p95_duration",
      "p99_duration",
      "error_rate",
    ])

    if (!allowedMetrics.has(query.aggregation)) {
      return {
        query: null,
        warnings,
        error: `Unsupported traces metric: ${query.aggregation}`,
      }
    }

    return {
      query: {
        kind: "timeseries",
        signal: "traces",
        metric: query.aggregation,
        filters,
        having,
        groupBy,
        orderBy,
        limit,
        bucketSeconds,
        allowSlowPath: true,
      } satisfies QueryBuilderRequest,
      warnings,
      error: null,
    }
  }

  if (query.dataSource === "logs") {
    if (query.aggregation !== "count") {
      return {
        query: null,
        warnings,
        error: "Logs source currently supports only count metric",
      }
    }

    return {
      query: {
        kind: "timeseries",
        signal: "logs",
        metric: "count",
        filters,
        having,
        groupBy,
        orderBy,
        limit,
        bucketSeconds,
        allowSlowPath: true,
      } satisfies QueryBuilderRequest,
      warnings,
      error: null,
    }
  }

  const allowedMetrics = new Set(["avg", "sum", "min", "max", "count"])
  if (!allowedMetrics.has(query.aggregation)) {
    return {
      query: null,
      warnings,
      error: `Unsupported metrics aggregation: ${query.aggregation}`,
    }
  }

  if (!query.metricName || !query.metricType) {
    return {
      query: null,
      warnings,
      error: "Metric source requires metric name and metric type",
    }
  }

  return {
    query: {
      kind: "timeseries",
      signal: "metrics",
      metric: query.aggregation,
      metricName: query.metricName,
      metricType: query.metricType,
      filters,
      having,
      groupBy,
      orderBy,
      limit,
      bucketSeconds,
      allowSlowPath: true,
    } satisfies QueryBuilderRequest,
    warnings,
    error: null,
  }
}

export function formatFiltersAsWhereClause(
  params: Record<string, unknown>
): string {
  const filters =
    params.filters && typeof params.filters === "object"
      ? (params.filters as Record<string, unknown>)
      : {}

  const clauses: string[] = []

  if (typeof filters.serviceName === "string" && filters.serviceName.trim()) {
    clauses.push(`service.name = "${filters.serviceName.trim()}"`)
  }

  if (typeof filters.spanName === "string" && filters.spanName.trim()) {
    clauses.push(`span.name = "${filters.spanName.trim()}"`)
  }

  if (typeof filters.severity === "string" && filters.severity.trim()) {
    clauses.push(`severity = "${filters.severity.trim()}"`)
  }

  if (filters.rootSpansOnly === true) {
    clauses.push("root_only = true")
  }

  if (Array.isArray(filters.environments) && filters.environments.length > 0) {
    const val = filters.environments
      .filter((item): item is string => typeof item === "string")
      .join(",")

    if (val) {
      clauses.push(`deployment.environment = "${val}"`)
    }
  }

  if (Array.isArray(filters.commitShas) && filters.commitShas.length > 0) {
    const val = filters.commitShas
      .filter((item): item is string => typeof item === "string")
      .join(",")

    if (val) {
      clauses.push(`deployment.commit_sha = "${val}"`)
    }
  }

  if (
    typeof filters.attributeKey === "string" &&
    filters.attributeKey.trim() &&
    typeof filters.attributeValue === "string"
  ) {
    clauses.push(
      `attr.${filters.attributeKey.trim()} = "${filters.attributeValue.trim()}"`
    )
  }

  if (
    typeof filters.resourceAttributeKey === "string" &&
    filters.resourceAttributeKey.trim() &&
    typeof filters.resourceAttributeValue === "string"
  ) {
    clauses.push(
      `resource.${filters.resourceAttributeKey.trim()} = "${filters.resourceAttributeValue.trim()}"`
    )
  }

  return clauses.join(" AND ")
}
