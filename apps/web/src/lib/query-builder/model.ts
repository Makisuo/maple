import type { QuerySpec } from "@maple/domain"

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

interface ParsedClause {
  key: string
  value: string
  operator?: "=" | ">" | "<" | ">=" | "<=" | "contains" | "exists"
}

export interface BuildSpecResult {
  query: QuerySpec | null
  warnings: string[]
  error: string | null
}

const TRUE_VALUES = new Set(["1", "true", "yes", "y"])
const FALSE_VALUES = new Set(["0", "false", "no", "n"])

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

function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function toBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  return null
}

function parseWhereClause(expression: string): {
  clauses: ParsedClause[]
  warnings: string[]
} {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { clauses: [], warnings: [] }
  }

  const parts = trimmed
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)

  const clauses: ParsedClause[] = []
  const warnings: string[] = []

  for (const part of parts) {
    const existsMatch = part.match(/^([a-zA-Z0-9_.-]+)\s+exists$/i)
    if (existsMatch) {
      clauses.push({
        key: existsMatch[1].trim().toLowerCase(),
        value: "",
        operator: "exists",
      })
      continue
    }

    const match = part.match(
      /^([a-zA-Z0-9_.-]+)\s*(<=|>=|<|>|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))$/
    )

    if (!match) {
      warnings.push(`Unsupported clause syntax ignored: ${part}`)
      continue
    }

    clauses.push({
      key: match[1].trim().toLowerCase(),
      value: (match[3] ?? match[4] ?? match[5] ?? "").trim(),
      operator: match[2] as ParsedClause["operator"],
    })
  }

  return { clauses, warnings }
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
  const { clauses, warnings: parseWarnings } = parseWhereClause(query.whereClause)
  warnings.push(...parseWarnings)

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

    const filters: {
      serviceName?: string
      spanName?: string
      rootSpansOnly?: boolean
      errorsOnly?: boolean
      environments?: string[]
      commitShas?: string[]
      attributeKey?: string
      attributeValue?: string
      attributeFilterMode?: "equals" | "exists"
      groupByAttributeKeys?: string[]
      resourceAttributeKey?: string
      resourceAttributeValue?: string
      resourceAttributeFilterMode?: "equals" | "exists"
    } = {}

    for (const clause of clauses) {
      if (clause.key === "service" || clause.key === "service.name") {
        filters.serviceName = clause.value
        continue
      }

      if (clause.key === "span" || clause.key === "span.name") {
        filters.spanName = clause.value
        continue
      }

      if (
        clause.key === "deployment.environment" ||
        clause.key === "environment" ||
        clause.key === "env"
      ) {
        filters.environments = splitCsv(clause.value)
        continue
      }

      if (
        clause.key === "deployment.commit_sha" ||
        clause.key === "commit_sha"
      ) {
        filters.commitShas = splitCsv(clause.value)
        continue
      }

      if (clause.key === "root_only" || clause.key === "root.only") {
        const boolValue = toBoolean(clause.value)
        if (boolValue == null) {
          warnings.push(`Invalid root_only value ignored: ${clause.value}`)
        } else {
          filters.rootSpansOnly = boolValue
        }
        continue
      }

      if (clause.key === "has_error" || clause.key === "errors_only") {
        const boolValue = toBoolean(clause.value)
        if (boolValue == null) {
          warnings.push(`Invalid has_error value ignored: ${clause.value}`)
        } else {
          filters.errorsOnly = boolValue
        }
        continue
      }

      if (clause.key.startsWith("attr.")) {
        const attributeKey = clause.key.slice(5)
        if (!filters.attributeKey) {
          filters.attributeKey = attributeKey
          if (clause.operator === "exists") {
            filters.attributeFilterMode = "exists"
          } else {
            filters.attributeValue = clause.value
          }
        } else {
          warnings.push(
            `Multiple attr.* filters found; only ${filters.attributeKey} is used`
          )
        }
        continue
      }

      if (clause.key.startsWith("resource.")) {
        const resourceKey = clause.key.slice(9)
        if (!filters.resourceAttributeKey) {
          filters.resourceAttributeKey = resourceKey
          if (clause.operator === "exists") {
            filters.resourceAttributeFilterMode = "exists"
          } else {
            filters.resourceAttributeValue = clause.value
          }
        } else {
          warnings.push(
            `Multiple resource.* filters found; only ${filters.resourceAttributeKey} is used`
          )
        }
        continue
      }

      warnings.push(`Unsupported traces filter ignored: ${clause.key}`)
    }

    type TracesGroupByKey = "service" | "span_name" | "status_code" | "http_method" | "attribute" | "none"
    const groupByKeys: TracesGroupByKey[] = []

    if (query.addOns.groupBy && query.groupBy.length > 0) {
      for (const raw of query.groupBy) {
        const token = raw.trim().toLowerCase()
        if (!token) continue
        if (token === "service" || token === "service.name") {
          groupByKeys.push("service")
        } else if (token === "span" || token === "span.name") {
          groupByKeys.push("span_name")
        } else if (token === "status" || token === "status.code") {
          groupByKeys.push("status_code")
        } else if (token === "http.method") {
          groupByKeys.push("http_method")
        } else if (token === "none" || token === "all") {
          groupByKeys.push("none")
        } else if (token.startsWith("attr.")) {
          const attributeKey = token.slice(5)
          if (!attributeKey) {
            warnings.push("Invalid attr.* group by ignored")
          } else {
            groupByKeys.push("attribute")
            if (!filters.groupByAttributeKeys) filters.groupByAttributeKeys = []
            filters.groupByAttributeKeys.push(attributeKey)
          }
        } else {
          warnings.push(`Unsupported traces group by ignored: ${raw}`)
        }
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
        filters: Object.keys(filters).length ? filters : undefined,
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

    const filters: {
      serviceName?: string
      severity?: string
    } = {}

    for (const clause of clauses) {
      if (clause.key === "service" || clause.key === "service.name") {
        filters.serviceName = clause.value
        continue
      }

      if (clause.key === "severity") {
        filters.severity = clause.value
        continue
      }

      warnings.push(`Unsupported logs filter ignored: ${clause.key}`)
    }

    type LogsGroupByKey = "service" | "severity" | "none"
    const logsGroupByKeys: LogsGroupByKey[] = []

    if (query.addOns.groupBy && query.groupBy.length > 0) {
      for (const raw of query.groupBy) {
        const token = raw.trim().toLowerCase()
        if (!token) continue
        if (token === "service" || token === "service.name") {
          logsGroupByKeys.push("service")
        } else if (token === "severity") {
          logsGroupByKeys.push("severity")
        } else if (token === "none" || token === "all") {
          logsGroupByKeys.push("none")
        } else {
          warnings.push(`Unsupported logs group by ignored: ${raw}`)
        }
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

  const filters: {
    metricName: string
    metricType: QueryBuilderMetricType
    serviceName?: string
  } = {
    metricName: query.metricName,
    metricType: query.metricType,
  }

  for (const clause of clauses) {
    if (clause.key === "service" || clause.key === "service.name") {
      filters.serviceName = clause.value
      continue
    }

    if (clause.key === "metric.type") {
      if (QUERY_BUILDER_METRIC_TYPES.includes(clause.value as QueryBuilderMetricType)) {
        filters.metricType = clause.value as QueryBuilderMetricType
      } else {
        warnings.push(`Invalid metric.type ignored: ${clause.value}`)
      }
      continue
    }

    warnings.push(`Unsupported metrics filter ignored: ${clause.key}`)
  }

  type MetricsGroupByKey = "service" | "none"
  const metricsGroupByKeys: MetricsGroupByKey[] = []
  if (query.addOns.groupBy && query.groupBy.length > 0) {
    for (const raw of query.groupBy) {
      const token = raw.trim().toLowerCase()
      if (!token) continue
      if (token === "service" || token === "service.name") {
        metricsGroupByKeys.push("service")
      } else if (token === "none" || token === "all") {
        metricsGroupByKeys.push("none")
      } else {
        warnings.push(`Unsupported metrics group by ignored: ${raw}`)
      }
    }
  }
  const groupBy = metricsGroupByKeys.length > 0 ? metricsGroupByKeys : undefined

  return {
    query: {
      kind: "timeseries",
      source: "metrics",
      metric: query.aggregation as "avg" | "sum" | "min" | "max" | "count",
      groupBy,
      filters,
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
