import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import {
  QUERY_BUILDER_METRIC_TYPES,
  createQueryDraft,
  formulaLabel,
  formatFiltersAsWhereClause,
  queryLabel,
  resetQueryForDataSource,
  type QueryBuilderDataSource,
  type QueryBuilderFormulaDraft,
  type QueryBuilderMetricType,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"
import { Match } from "effect"

export interface AiWidgetProposal {
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
}

export type NormalizeAiWidgetProposalResult =
  | { kind: "valid"; proposal: AiWidgetProposal }
  | { kind: "blocked"; reason: string; proposal: AiWidgetProposal }

const QUERY_BUILDER_CHART_IDS = new Set([
  "query-builder-bar",
  "query-builder-area",
  "query-builder-line",
])

const MONOTONIC_METRIC_AGGREGATIONS = new Set(["rate", "increase"])
const GAUGE_LIKE_METRIC_AGGREGATIONS = new Set(["avg", "sum", "min", "max", "count"])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isQueryBuilderDataSource(value: unknown): value is QueryBuilderDataSource {
  return value === "traces" || value === "logs" || value === "metrics"
}

function isQueryBuilderMetricType(value: unknown): value is QueryBuilderMetricType {
  return QUERY_BUILDER_METRIC_TYPES.includes(value as never)
}

function toMetricType(
  value: unknown,
  fallback: QueryBuilderMetricType,
): QueryBuilderMetricType {
  return isQueryBuilderMetricType(value) ? value : fallback
}

function isExplicitInvalidMetricType(value: unknown): boolean {
  return value !== undefined && !isQueryBuilderMetricType(value)
}

function normalizeGroupByToken(token: string): string {
  return Match.value(token).pipe(
    Match.when("service", () => "service.name"),
    Match.when("span_name", () => "span.name"),
    Match.when("status_code", () => "status.code"),
    Match.when("http_method", () => "http.method"),
    Match.when("none", () => "none"),
    Match.orElse(() => token),
  )
}

function toQueryGroupByArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map(normalizeGroupByToken)
    return normalized.length > 0 ? normalized : ["none"]
  }
  if (typeof value === "string" && value.trim()) {
    return [normalizeGroupByToken(value)]
  }
  return ["none"]
}

function hasAnyKnownQueryFields(raw: Record<string, unknown>): boolean {
  const knownKeys = [
    "id",
    "name",
    "enabled",
    "dataSource",
    "source",
    "signalSource",
    "metricName",
    "metricType",
    "whereClause",
    "aggregation",
    "metric",
    "stepInterval",
    "bucketSeconds",
    "orderByDirection",
    "addOns",
    "groupBy",
    "having",
    "orderBy",
    "limit",
    "legend",
    "filters",
  ]

  return knownKeys.some((key) => key in raw)
}

function toMetricName(
  raw: Record<string, unknown>,
  dataSource: QueryBuilderDataSource,
  fallback: string,
): string {
  if (dataSource !== "metrics") return fallback

  if (typeof raw.metricName === "string") {
    return raw.metricName
  }

  const filters = asRecord(raw.filters)
  if (typeof filters?.metricName === "string") {
    return filters.metricName
  }

  return fallback
}

function toStepInterval(raw: Record<string, unknown>): string {
  if (typeof raw.stepInterval === "string" && raw.stepInterval.trim().length > 0) {
    return raw.stepInterval
  }

  if (
    typeof raw.bucketSeconds === "number" &&
    Number.isFinite(raw.bucketSeconds) &&
    raw.bucketSeconds > 0
  ) {
    return String(raw.bucketSeconds)
  }

  return ""
}

function normalizeTraceAggregation(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed

  const normalized = trimmed
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
    .replace(/[()]/g, "")

  return Match.value(normalized).pipe(
    Match.when("count", () => "count"),
    Match.whenOr("avg", "avgduration", "avglatency", () => "avg_duration"),
    Match.whenOr("p50", "p50duration", "p50latency", () => "p50_duration"),
    Match.whenOr("p95", "p95duration", "p95latency", () => "p95_duration"),
    Match.whenOr("p99", "p99duration", "p99latency", () => "p99_duration"),
    Match.when("errorrate", () => "error_rate"),
    Match.orElse(() => trimmed),
  )
}

function normalizeAggregation(
  dataSource: QueryBuilderDataSource,
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback
  }

  if (dataSource === "traces") {
    return normalizeTraceAggregation(value)
  }

  return value.trim()
}

function normalizeMetricsAggregation(
  value: string,
  metricType: QueryBuilderMetricType,
  isMonotonic: boolean,
  hints: string[],
): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")

  const hintText = hints.join(" ").toLowerCase()
  const preferIncrease = /\b(increase|delta|change|added|new|increment|growth)\b/.test(hintText)

  const aliasMap: Record<string, string> = {
    average: "avg",
    mean: "avg",
    total: "sum",
    minimum: "min",
    maximum: "max",
    persecond: "rate",
    ratepersecond: "rate",
    delta: "increase",
  }

  const candidate = aliasMap[normalized] ?? value.trim()

  if (metricType === "sum" && isMonotonic) {
    if (
      candidate === "rate" ||
      candidate === "increase" ||
      candidate === "sum" ||
      candidate === "avg" ||
      candidate === "count"
    ) {
      return preferIncrease ? "increase" : "rate"
    }
    return MONOTONIC_METRIC_AGGREGATIONS.has(candidate)
      ? candidate
      : (preferIncrease ? "increase" : "rate")
  }

  if (metricType === "gauge") {
    return GAUGE_LIKE_METRIC_AGGREGATIONS.has(candidate) ? candidate : "avg"
  }

  return candidate === "avg" || candidate === "min" || candidate === "max" || candidate === "count"
    ? candidate
    : "avg"
}

function rewriteFriendlyTraceMetricText(value: string): string {
  return value
    .replace(/\bp50_duration\b/gi, "p50")
    .replace(/\bp95_duration\b/gi, "p95")
    .replace(/\bp99_duration\b/gi, "p99")
    .replace(/\bavg_duration\b/gi, "avg duration")
    .replace(/\berror_rate\b/gi, "error rate")
}

function rewriteFriendlyQueryLegend(query: QueryBuilderQueryDraft): QueryBuilderQueryDraft {
  if (!query.legend.trim()) {
    return query
  }

  return {
    ...query,
    legend: rewriteFriendlyTraceMetricText(query.legend),
  }
}

function rewriteFriendlyFormulaLegend(formula: QueryBuilderFormulaDraft): QueryBuilderFormulaDraft {
  return {
    ...formula,
    legend: rewriteFriendlyTraceMetricText(formula.legend),
  }
}

function humanizeToken(token: string): string {
  const lower = token.toLowerCase()
  if (lower === "http") return "HTTP"
  if (lower === "cpu") return "CPU"
  if (lower === "jvm") return "JVM"
  if (lower === "db") return "DB"
  if (lower === "io") return "IO"
  if (lower === "id") return "ID"
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function humanizeMetricName(metricName: string): string {
  return metricName
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map(humanizeToken)
    .join(" ")
}

function describeGroupBy(field: string): string {
  return Match.value(field).pipe(
    Match.when("service.name", () => "Service"),
    Match.when("span.name", () => "Span"),
    Match.when("status.code", () => "Status Code"),
    Match.when("http.method", () => "HTTP Method"),
    Match.when("severity", () => "Severity"),
    Match.when("none", () => ""),
    Match.orElse(() =>
      field.startsWith("attr.")
        ? humanizeMetricName(field.slice(5))
        : humanizeMetricName(field),
    ),
  )
}

function firstGroupByField(groupBy: string[]): string | null {
  return groupBy.find((field) => field.trim().length > 0 && field !== "none") ?? null
}

function deriveQueryTitle(query: QueryBuilderQueryDraft): string {
  const groupByLabel = firstGroupByField(query.groupBy)
  const suffix = groupByLabel ? ` by ${describeGroupBy(groupByLabel)}` : ""

  if (query.dataSource === "traces") {
    return Match.value(query.aggregation).pipe(
      Match.when("count", () => `Requests${suffix}`),
      Match.when("avg_duration", () => `Avg Latency${suffix}`),
      Match.when("p50_duration", () => `P50 Latency${suffix}`),
      Match.when("p95_duration", () => `P95 Latency${suffix}`),
      Match.when("p99_duration", () => `P99 Latency${suffix}`),
      Match.when("error_rate", () => `Error Rate${suffix}`),
      Match.orElse(() => `${rewriteFriendlyTraceMetricText(query.aggregation)}${suffix}`),
    )
  }

  if (query.dataSource === "logs") {
    return `Logs${suffix}`
  }

  const baseMetric = humanizeMetricName(query.metricName || "Metric")
  return Match.value(query.aggregation).pipe(
    Match.when("rate", () => `${baseMetric} Rate${suffix}`),
    Match.when("increase", () => `${baseMetric} Increase${suffix}`),
    Match.when("avg", () => `${baseMetric}${suffix}`),
    Match.when("min", () => `Min ${baseMetric}${suffix}`),
    Match.when("max", () => `Max ${baseMetric}${suffix}`),
    Match.when("count", () => `${baseMetric} Samples${suffix}`),
    Match.when("sum", () => `Total ${baseMetric}${suffix}`),
    Match.orElse(() => `${baseMetric}${suffix}`),
  )
}

function inferChartId(queries: QueryBuilderQueryDraft[], currentChartId: unknown): string {
  if (typeof currentChartId === "string" && QUERY_BUILDER_CHART_IDS.has(currentChartId)) {
    return currentChartId
  }

  const aggregations = new Set(queries.map((query) => query.aggregation))
  if (
    aggregations.has("error_rate") ||
    aggregations.has("count") ||
    aggregations.has("rate") ||
    aggregations.has("increase")
  ) {
    return "query-builder-area"
  }

  return "query-builder-line"
}

function inferDisplayUnit(
  queries: QueryBuilderQueryDraft[],
  currentUnit: unknown,
): WidgetDisplayConfig["unit"] {
  if (typeof currentUnit === "string" && currentUnit.trim().length > 0) {
    return currentUnit
  }

  const firstQuery = queries[0]
  if (!firstQuery) return undefined

  if (firstQuery.dataSource === "traces") {
    if (firstQuery.aggregation === "error_rate") return "percent"
    if (
      firstQuery.aggregation === "avg_duration" ||
      firstQuery.aggregation === "p50_duration" ||
      firstQuery.aggregation === "p95_duration" ||
      firstQuery.aggregation === "p99_duration"
    ) {
      return "duration_ms"
    }
  }

  if (firstQuery.dataSource === "logs") {
    return "number"
  }

  return typeof currentUnit === "string" ? currentUnit : undefined
}

function inferTitle(
  input: AiWidgetProposal,
  normalizedQueries: QueryBuilderQueryDraft[],
  normalizedFormulas: QueryBuilderFormulaDraft[],
): string | undefined {
  if (isNonEmptyString(input.display.title)) {
    return rewriteFriendlyTraceMetricText(input.display.title.trim())
  }

  if (normalizedFormulas.length > 0) {
    const formulaLegend = normalizedFormulas[0]?.legend.trim()
    if (formulaLegend) {
      return rewriteFriendlyTraceMetricText(formulaLegend)
    }
  }

  if (normalizedQueries.length > 0) {
    const baseTitle = deriveQueryTitle(normalizedQueries[0]!)
    return normalizedQueries.length > 1 ? `${baseTitle} Comparison` : baseTitle
  }

  const endpointFallbacks: Partial<Record<string, string>> = {
    service_overview: "Service Overview",
    service_usage: "Service Usage",
    errors_summary: "Error Summary",
    errors_by_type: "Errors by Type",
    list_traces: "Recent Traces",
    list_logs: "Recent Logs",
    error_rate_by_service: "Error Rate by Service",
  }

  return endpointFallbacks[input.dataSource.endpoint]
}

function titlePrefersIncrease(title: unknown): boolean {
  return isNonEmptyString(title) && /\b(increase|delta|change|added|new|increment|growth)\b/i.test(title)
}

function normalizeQueryEntry(
  raw: unknown,
  index: number,
): { query: QueryBuilderQueryDraft; hasInvalidMetricType: boolean } | null {
  const queryRecord = asRecord(raw)
  if (!queryRecord || !hasAnyKnownQueryFields(queryRecord)) return null

  const sourceValue = queryRecord.dataSource ?? queryRecord.source
  const dataSource = isQueryBuilderDataSource(sourceValue)
    ? sourceValue
    : "traces"
  const queryBase = resetQueryForDataSource(createQueryDraft(index), dataSource)

  const fallbackFilters = asRecord(queryRecord.filters)
  const metricTypeInput = queryRecord.metricType ?? fallbackFilters?.metricType
  const hasInvalidMetricType =
    dataSource === "metrics" && isExplicitInvalidMetricType(metricTypeInput)
  const metricType = toMetricType(
    metricTypeInput,
    queryBase.metricType,
  )
  const defaultWhereClause = formatFiltersAsWhereClause({ filters: fallbackFilters })
  const groupBy = toQueryGroupByArray(queryRecord.groupBy)
  const addOns = asRecord(queryRecord.addOns)
  const rawAggregation =
    typeof queryRecord.aggregation === "string" && queryRecord.aggregation.trim().length > 0
      ? queryRecord.aggregation
      : typeof queryRecord.metric === "string" && queryRecord.metric.trim().length > 0
        ? queryRecord.metric
        : undefined
  const metricName = toMetricName(queryRecord, dataSource, queryBase.metricName)
  const isMonotonic =
    typeof queryRecord.isMonotonic === "boolean"
      ? queryRecord.isMonotonic
      : metricType === "sum"
  const aggregation =
    dataSource === "metrics"
      ? normalizeMetricsAggregation(
          normalizeAggregation(dataSource, rawAggregation, queryBase.aggregation),
          metricType,
          isMonotonic,
          [
            metricName,
            typeof queryRecord.name === "string" ? queryRecord.name : "",
            typeof queryRecord.legend === "string" ? queryRecord.legend : "",
          ],
        )
      : normalizeAggregation(dataSource, rawAggregation, queryBase.aggregation)

  return {
    hasInvalidMetricType,
    query: {
    ...queryBase,
    id: typeof queryRecord.id === "string" ? queryRecord.id : queryBase.id,
    name:
      typeof queryRecord.name === "string" && queryRecord.name.trim().length > 0
        ? queryRecord.name
        : queryLabel(index),
    enabled: typeof queryRecord.enabled === "boolean" ? queryRecord.enabled : true,
    dataSource,
    signalSource:
      queryRecord.signalSource === "default" || queryRecord.signalSource === "meter"
        ? queryRecord.signalSource
        : "default",
    metricName,
    metricType,
    isMonotonic,
    whereClause:
      typeof queryRecord.whereClause === "string"
        ? queryRecord.whereClause
        : defaultWhereClause,
    aggregation,
    stepInterval: toStepInterval(queryRecord),
    orderByDirection:
      queryRecord.orderByDirection === "asc" || queryRecord.orderByDirection === "desc"
        ? queryRecord.orderByDirection
        : queryBase.orderByDirection,
    addOns: {
      groupBy:
        typeof addOns?.groupBy === "boolean"
          ? addOns.groupBy
          : groupBy.length > 0 && !(groupBy.length === 1 && groupBy[0] === "none"),
      having: typeof addOns?.having === "boolean" ? addOns.having : queryBase.addOns.having,
      orderBy: typeof addOns?.orderBy === "boolean" ? addOns.orderBy : queryBase.addOns.orderBy,
      limit: typeof addOns?.limit === "boolean" ? addOns.limit : queryBase.addOns.limit,
      legend: typeof addOns?.legend === "boolean" ? addOns.legend : queryBase.addOns.legend,
    },
    groupBy,
    having:
      typeof queryRecord.having === "string" ? queryRecord.having : queryBase.having,
    orderBy:
      typeof queryRecord.orderBy === "string" ? queryRecord.orderBy : queryBase.orderBy,
    limit:
      typeof queryRecord.limit === "string" ? queryRecord.limit : queryBase.limit,
    legend:
      typeof queryRecord.legend === "string" ? queryRecord.legend : queryBase.legend,
  },
  }
}

function validateMetricsQueries(
  queries: QueryBuilderQueryDraft[],
  hasInvalidMetricType: boolean,
): string | null {
  if (hasInvalidMetricType) {
    return "Metrics chart needs metric name and metric type."
  }

  for (const query of queries) {
    if (query.dataSource !== "metrics") continue

    const metricName = query.metricName
    if (typeof metricName !== "string" || metricName.trim().length === 0) {
      return "Metrics chart needs metric name and metric type."
    }

    const metricType = query.metricType
    if (!isQueryBuilderMetricType(metricType)) {
      return "Metrics chart needs metric name and metric type."
    }
  }

  return null
}

function normalizeFormulaEntry(
  raw: unknown,
  index: number,
): QueryBuilderFormulaDraft | null {
  const formula = asRecord(raw)
  if (!formula) return null
  if (typeof formula.expression !== "string" || typeof formula.legend !== "string") {
    return null
  }

  return {
    id: typeof formula.id === "string" ? formula.id : crypto.randomUUID(),
    name:
      typeof formula.name === "string" && formula.name.trim().length > 0
        ? formula.name
        : formulaLabel(index),
    expression: formula.expression,
    legend: formula.legend,
  }
}

function stripTimeParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return params
  const { startTime, endTime, ...rest } = params
  return rest
}

export function normalizeAiWidgetProposal(
  input: AiWidgetProposal,
): NormalizeAiWidgetProposalResult {
  if (
    input.visualization === "list" &&
    (input.dataSource.endpoint === "list_traces" || input.dataSource.endpoint === "list_logs")
  ) {
    return { kind: "valid", proposal: { ...input, dataSource: { ...input.dataSource, params: stripTimeParams(input.dataSource.params) } } }
  }

  if (input.dataSource.endpoint !== "custom_query_builder_timeseries") {
    return { kind: "valid", proposal: { ...input, dataSource: { ...input.dataSource, params: stripTimeParams(input.dataSource.params) } } }
  }

  const params = asRecord(input.dataSource.params) ?? {}
  const queriesInput = params.queries
  const normalizedEntries = Array.isArray(queriesInput)
    ? queriesInput
        .map((query, index) => normalizeQueryEntry(query, index))
        .filter((query): query is { query: QueryBuilderQueryDraft; hasInvalidMetricType: boolean } => query !== null)
    : (() => {
        const legacyQuery = normalizeQueryEntry(params, 0)
        return legacyQuery ? [legacyQuery] : null
      })()
  const normalizedQueries = normalizedEntries?.map((entry) => entry.query)
  const hasInvalidMetricType = normalizedEntries?.some((entry) => entry.hasInvalidMetricType) ?? false

  if (!normalizedQueries || normalizedQueries.length === 0) {
    return {
      kind: "blocked",
      reason: "Chart config is missing queries[] for query builder.",
      proposal: input,
    }
  }

  const metricsValidationError = validateMetricsQueries(normalizedQueries, hasInvalidMetricType)
  if (metricsValidationError) {
    return {
      kind: "blocked",
      reason: metricsValidationError,
      proposal: input,
    }
  }

  const titleDrivenQueries = titlePrefersIncrease(input.display.title)
    ? normalizedQueries.map((query) =>
        query.dataSource === "metrics" &&
        query.metricType === "sum" &&
        query.isMonotonic &&
        query.aggregation === "rate"
          ? { ...query, aggregation: "increase" }
          : query,
      )
    : normalizedQueries

  const formulasInput = Array.isArray(params.formulas) ? params.formulas : []
  const normalizedFormulas = formulasInput
    .map((formula, index) => normalizeFormulaEntry(formula, index))
    .filter((formula): formula is QueryBuilderFormulaDraft => formula !== null)
    .map(rewriteFriendlyFormulaLegend)
  const comparison = asRecord(params.comparison)
  const normalizedComparison = {
    mode:
      comparison?.mode === "none" || comparison?.mode === "previous_period"
        ? comparison.mode
        : "none",
    includePercentChange:
      typeof comparison?.includePercentChange === "boolean"
        ? comparison.includePercentChange
        : true,
  } as const

  const { startTime: _st, endTime: _et, ...restParams } = params
  const normalizedDataSource: WidgetDataSource = {
    ...input.dataSource,
    params: {
      ...restParams,
      queries: titleDrivenQueries.map(rewriteFriendlyQueryLegend),
      formulas: normalizedFormulas,
      comparison: normalizedComparison,
      debug: params.debug === true,
    },
  }

  return {
    kind: "valid",
    proposal: {
      ...input,
      display: {
        ...input.display,
        title: inferTitle(input, titleDrivenQueries, normalizedFormulas),
        chartId:
          input.visualization === "chart"
            ? inferChartId(titleDrivenQueries, input.display.chartId)
            : input.display.chartId,
        unit:
          input.visualization === "chart" || input.visualization === "stat"
            ? inferDisplayUnit(titleDrivenQueries, input.display.unit)
            : input.display.unit,
      },
      dataSource: normalizedDataSource,
    },
  }
}
