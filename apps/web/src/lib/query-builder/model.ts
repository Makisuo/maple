import type { QuerySpec } from "@maple/query-engine"
import {
  normalizeKey,
  parseBoolean,
  parseWhereClause,
  splitCsv,
} from "@maple/query-engine/where-clause"
import { Match } from "effect"

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
  groupBy: string[]
  having: string
  orderBy: string
  limit: string
  legend: string
}

export interface BuildSpecResult {
  query: QuerySpec | null
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
    { label: "attr.*", value: "attr." },
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
    stepInterval: "",
    orderByDirection: "desc",
    addOns: {
      groupBy: true,
      having: false,
      orderBy: false,
      limit: false,
      legend: false,
    },
    groupBy: ["service.name"],
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

// ---------------------------------------------------------------------------
// Clause-to-filter mapping via Match
// ---------------------------------------------------------------------------

interface AccumulatedAttributeFilter {
  key: string
  value?: string
  mode: "equals" | "exists" | "gt" | "gte" | "lt" | "lte" | "contains"
}

interface TracesFilterAccumulator {
  serviceName?: string
  spanName?: string
  rootSpansOnly?: boolean
  errorsOnly?: boolean
  environments?: string[]
  commitShas?: string[]
  attributeFilters: AccumulatedAttributeFilter[]
  groupByAttributeKeys?: string[]
  resourceAttributeFilters: AccumulatedAttributeFilter[]
}

function operatorToFilterMode(
  operator: string,
): AccumulatedAttributeFilter["mode"] {
  switch (operator) {
    case "exists": return "exists"
    case ">": return "gt"
    case ">=": return "gte"
    case "<": return "lt"
    case "<=": return "lte"
    case "contains": return "contains"
    default: return "equals"
  }
}

function applyTracesClause(
  filters: TracesFilterAccumulator,
  clause: { key: string; operator: string; value: string },
  warnings: string[],
): TracesFilterAccumulator {
  const key = normalizeKey(clause.key)

  // Handle attr.* and resource.* prefixes before Match
  if (key.startsWith("attr.")) {
    const attributeKey = key.slice(5)
    if (filters.attributeFilters.length >= 5) {
      warnings.push(`Maximum of 5 attr.* filters supported; ignoring attr.${attributeKey}`)
      return filters
    }
    return {
      ...filters,
      attributeFilters: [
        ...filters.attributeFilters,
        {
          key: attributeKey,
          mode: operatorToFilterMode(clause.operator),
          ...(clause.operator !== "exists" ? { value: clause.value } : {}),
        },
      ],
    }
  }

  if (key.startsWith("resource.")) {
    const resourceKey = key.slice(9)
    if (filters.resourceAttributeFilters.length >= 5) {
      warnings.push(`Maximum of 5 resource.* filters supported; ignoring resource.${resourceKey}`)
      return filters
    }
    return {
      ...filters,
      resourceAttributeFilters: [
        ...filters.resourceAttributeFilters,
        {
          key: resourceKey,
          mode: operatorToFilterMode(clause.operator),
          ...(clause.operator !== "exists" ? { value: clause.value } : {}),
        },
      ],
    }
  }

  return Match.value(key).pipe(
    Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
    Match.when("span.name", () => ({ ...filters, spanName: clause.value })),
    Match.when("deployment.environment", () => ({
      ...filters,
      environments: splitCsv(clause.value),
    })),
    Match.when("deployment.commit_sha", () => ({
      ...filters,
      commitShas: splitCsv(clause.value),
    })),
    Match.when("root_only", () => {
      const boolValue = parseBoolean(clause.value)
      if (boolValue == null) {
        warnings.push(`Invalid root_only value ignored: ${clause.value}`)
        return filters
      }
      return { ...filters, rootSpansOnly: boolValue }
    }),
    Match.when("has_error", () => {
      const boolValue = parseBoolean(clause.value)
      if (boolValue == null) {
        warnings.push(`Invalid has_error value ignored: ${clause.value}`)
        return filters
      }
      return { ...filters, errorsOnly: boolValue }
    }),
    Match.orElse(() => {
      warnings.push(`Unsupported traces filter ignored: ${clause.key}`)
      return filters
    }),
  )
}

function applyLogsClause(
  filters: { serviceName?: string; severity?: string },
  clause: { key: string; value: string },
  warnings: string[],
): { serviceName?: string; severity?: string } {
  const key = normalizeKey(clause.key)

  return Match.value(key).pipe(
    Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
    Match.when("severity", () => ({ ...filters, severity: clause.value })),
    Match.orElse(() => {
      warnings.push(`Unsupported logs filter ignored: ${clause.key}`)
      return filters
    }),
  )
}

function applyMetricsClause(
  filters: { metricName: string; metricType: QueryBuilderMetricType; serviceName?: string },
  clause: { key: string; value: string },
  warnings: string[],
): { metricName: string; metricType: QueryBuilderMetricType; serviceName?: string } {
  const key = normalizeKey(clause.key)

  return Match.value(key).pipe(
    Match.when("service.name", () => ({ ...filters, serviceName: clause.value })),
    Match.when("metric.type", () => {
      if (QUERY_BUILDER_METRIC_TYPES.includes(clause.value as QueryBuilderMetricType)) {
        return { ...filters, metricType: clause.value as QueryBuilderMetricType }
      }
      warnings.push(`Invalid metric.type ignored: ${clause.value}`)
      return filters
    }),
    Match.orElse(() => {
      warnings.push(`Unsupported metrics filter ignored: ${clause.key}`)
      return filters
    }),
  )
}

// ---------------------------------------------------------------------------
// Group-by mapping via Match
// ---------------------------------------------------------------------------

type TracesGroupByKey = "service" | "span_name" | "status_code" | "http_method" | "attribute" | "none"

function resolveTracesGroupByToken(
  token: string,
  filters: TracesFilterAccumulator,
  warnings: string[],
  raw: string,
): TracesGroupByKey | null {
  return Match.value(token).pipe(
    Match.whenOr("service", "service.name", () => "service" as const),
    Match.whenOr("span", "span.name", () => "span_name" as const),
    Match.whenOr("status", "status.code", () => "status_code" as const),
    Match.when("http.method", () => "http_method" as const),
    Match.whenOr("none", "all", () => "none" as const),
    Match.orElse((t) => {
      if (t.startsWith("attr.")) {
        const attributeKey = t.slice(5)
        if (!attributeKey) {
          warnings.push("Invalid attr.* group by ignored")
          return null
        }
        if (!filters.groupByAttributeKeys) filters.groupByAttributeKeys = []
        filters.groupByAttributeKeys.push(attributeKey)
        return "attribute" as const
      }
      warnings.push(`Unsupported traces group by ignored: ${raw}`)
      return null
    }),
  )
}

type LogsGroupByKey = "service" | "severity" | "none"

function resolveLogsGroupByToken(
  token: string,
  warnings: string[],
  raw: string,
): LogsGroupByKey | null {
  return Match.value(token).pipe(
    Match.whenOr("service", "service.name", () => "service" as const),
    Match.when("severity", () => "severity" as const),
    Match.whenOr("none", "all", () => "none" as const),
    Match.orElse(() => {
      warnings.push(`Unsupported logs group by ignored: ${raw}`)
      return null
    }),
  )
}

type MetricsGroupByKey = "service" | "attribute" | "none"

function resolveMetricsGroupByToken(
  token: string,
  metricsFilters: { metricName: string; metricType: string; serviceName?: string; groupByAttributeKey?: string },
  warnings: string[],
  raw: string,
): MetricsGroupByKey | null {
  return Match.value(token).pipe(
    Match.whenOr("service", "service.name", () => "service" as const),
    Match.whenOr("none", "all", () => "none" as const),
    Match.orElse((t) => {
      if (t.startsWith("attr.")) {
        const attributeKey = t.slice(5)
        if (!attributeKey) {
          warnings.push("Invalid attr.* group by ignored")
          return null
        }
        metricsFilters.groupByAttributeKey = attributeKey
        return "attribute" as const
      }
      warnings.push(`Unsupported metrics group by ignored: ${raw}`)
      return null
    }),
  )
}

// ---------------------------------------------------------------------------
// Accumulator → QuerySpec filters
// ---------------------------------------------------------------------------

function buildTracesSpecFilters(acc: TracesFilterAccumulator): Record<string, unknown> | undefined {
  const filters: Record<string, unknown> = {}

  if (acc.serviceName) filters.serviceName = acc.serviceName
  if (acc.spanName) filters.spanName = acc.spanName
  if (acc.rootSpansOnly) filters.rootSpansOnly = acc.rootSpansOnly
  if (acc.errorsOnly) filters.errorsOnly = acc.errorsOnly
  if (acc.environments?.length) filters.environments = acc.environments
  if (acc.commitShas?.length) filters.commitShas = acc.commitShas
  if (acc.groupByAttributeKeys?.length) filters.groupByAttributeKeys = acc.groupByAttributeKeys
  if (acc.attributeFilters.length > 0) filters.attributeFilters = acc.attributeFilters
  if (acc.resourceAttributeFilters.length > 0) filters.resourceAttributeFilters = acc.resourceAttributeFilters

  return Object.keys(filters).length > 0 ? filters : undefined
}

// ---------------------------------------------------------------------------
// Query spec builders
// ---------------------------------------------------------------------------

export function buildTimeseriesQuerySpec(
  query: QueryBuilderQueryDraft
): BuildSpecResult {
  const warnings: string[] = []
  const { clauses, warnings: parseWarnings } = parseWhereClause(query.whereClause)
  for (const w of parseWarnings) warnings.push(w.message)

  const bucketSeconds = parseBucketSeconds(query.stepInterval)
  if (query.stepInterval.trim() && !bucketSeconds) {
    warnings.push("Invalid step interval ignored; auto interval will be used")
  }

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

    const filters = clauses.reduce<TracesFilterAccumulator>(
      (acc, clause) => applyTracesClause(acc, clause, warnings),
      { attributeFilters: [], resourceAttributeFilters: [] },
    )

    const groupByKeys: TracesGroupByKey[] = []
    if (query.addOns.groupBy && query.groupBy.length > 0) {
      for (const raw of query.groupBy) {
        const token = raw.trim().toLowerCase()
        if (!token) continue
        const resolved = resolveTracesGroupByToken(token, filters, warnings, raw)
        if (resolved) groupByKeys.push(resolved)
      }
    }

    const groupBy = groupByKeys.length > 0 ? groupByKeys : undefined

    if (groupByKeys.includes("attribute") && !filters.groupByAttributeKeys?.length) {
      return {
        query: null,
        warnings,
        error: "groupBy=attribute requires attr.<key> in Group By or Where clause",
      }
    }

    const specFilters = buildTracesSpecFilters(filters)

    return {
      query: {
        kind: "timeseries",
        source: "traces",
        metric: query.aggregation as
          | "count"
          | "avg_duration"
          | "p50_duration"
          | "p95_duration"
          | "p99_duration"
          | "error_rate",
        groupBy,
        filters: specFilters,
        bucketSeconds,
      } as QuerySpec,
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

    const filters = clauses.reduce<{ serviceName?: string; severity?: string }>(
      (acc, clause) => applyLogsClause(acc, clause, warnings),
      {},
    )

    const logsGroupByKeys: LogsGroupByKey[] = []
    if (query.addOns.groupBy && query.groupBy.length > 0) {
      for (const raw of query.groupBy) {
        const token = raw.trim().toLowerCase()
        if (!token) continue
        const resolved = resolveLogsGroupByToken(token, warnings, raw)
        if (resolved) logsGroupByKeys.push(resolved)
      }
    }

    const groupBy = logsGroupByKeys.length > 0 ? logsGroupByKeys : undefined

    return {
      query: {
        kind: "timeseries",
        source: "logs",
        metric: "count",
        groupBy,
        filters: Object.keys(filters).length ? filters : undefined,
        bucketSeconds,
      } as QuerySpec,
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

  const metricsFilters = clauses.reduce(
    (acc, clause) => applyMetricsClause(acc, clause, warnings),
    {
      metricName: query.metricName,
      metricType: query.metricType,
    } as { metricName: string; metricType: QueryBuilderMetricType; serviceName?: string; groupByAttributeKey?: string },
  )

  const metricsGroupByKeys: MetricsGroupByKey[] = []
  if (query.addOns.groupBy && query.groupBy.length > 0) {
    for (const raw of query.groupBy) {
      const token = raw.trim().toLowerCase()
      if (!token) continue
      const resolved = resolveMetricsGroupByToken(token, metricsFilters, warnings, raw)
      if (resolved) metricsGroupByKeys.push(resolved)
    }
  }
  const groupBy = metricsGroupByKeys.length > 0 ? metricsGroupByKeys : undefined

  return {
    query: {
      kind: "timeseries",
      source: "metrics",
      metric: query.aggregation as "avg" | "sum" | "min" | "max" | "count",
      groupBy,
      filters: metricsFilters,
      bucketSeconds,
    } as QuerySpec,
    warnings,
    error: null,
  }
}

export function buildBreakdownQuerySpec(
  query: QueryBuilderQueryDraft
): BuildSpecResult {
  const timeseriesResult = buildTimeseriesQuerySpec(query)
  if (!timeseriesResult.query) return timeseriesResult

  const spec = timeseriesResult.query
  if (spec.kind !== "timeseries") return timeseriesResult

  const groupByArray = (spec as { groupBy?: string[] }).groupBy ?? []
  const breakdownGroupBy = groupByArray.find((g) => g !== "none")
  if (!breakdownGroupBy) {
    return {
      query: null,
      warnings: timeseriesResult.warnings,
      error: "Breakdown requires a non-none group-by field",
    }
  }

  const limitRaw = query.addOns.limit ? query.limit.trim() : ""
  const parsedLimit = limitRaw
    ? Number.parseInt(limitRaw, 10)
    : undefined
  const limit =
    parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit <= 100
      ? parsedLimit
      : undefined

  return {
    query: {
      kind: "breakdown" as const,
      source: spec.source,
      metric: (spec as { metric: string }).metric,
      groupBy: breakdownGroupBy,
      filters: (spec as { filters?: unknown }).filters,
      limit,
    } as QuerySpec,
    warnings: timeseriesResult.warnings,
    error: null,
  }
}

export function buildListQuerySpec(
  query: QueryBuilderQueryDraft,
  limit?: number,
): BuildSpecResult {
  // Reuse the timeseries spec builder to parse the where clause into filters
  const timeseriesResult = buildTimeseriesQuerySpec(query)
  if (!timeseriesResult.query) return timeseriesResult

  const spec = timeseriesResult.query
  if (spec.kind !== "timeseries") return timeseriesResult

  return {
    query: {
      kind: "list" as const,
      source: spec.source,
      filters: (spec as { filters?: unknown }).filters,
      limit,
    } as QuerySpec,
    warnings: timeseriesResult.warnings,
    error: null,
  }
}

const FILTER_MODE_TO_DISPLAY: Record<string, string> = {
  equals: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "contains",
}

function formatAttrFilterClause(
  prefix: string,
  af: { key: string; value?: string; mode: string },
): string {
  if (af.mode === "exists") {
    return `${prefix}.${af.key} exists`
  }
  const op = FILTER_MODE_TO_DISPLAY[af.mode] ?? "="
  if (af.mode === "contains") {
    return `${prefix}.${af.key} contains "${af.value ?? ""}"`
  }
  return `${prefix}.${af.key} ${op} "${af.value ?? ""}"`
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

  if (Array.isArray(filters.attributeFilters)) {
    for (const af of filters.attributeFilters as Array<{ key: string; value?: string; mode: string }>) {
      clauses.push(formatAttrFilterClause("attr", af))
    }
  }

  if (Array.isArray(filters.resourceAttributeFilters)) {
    for (const rf of filters.resourceAttributeFilters as Array<{ key: string; value?: string; mode: string }>) {
      clauses.push(formatAttrFilterClause("resource", rf))
    }
  }

  return clauses.join(" AND ")
}
