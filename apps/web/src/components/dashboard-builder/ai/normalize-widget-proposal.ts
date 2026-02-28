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

export interface AiWidgetProposal {
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
}

export type NormalizeAiWidgetProposalResult =
  | { kind: "valid"; proposal: AiWidgetProposal }
  | { kind: "blocked"; reason: string; proposal: AiWidgetProposal }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isQueryBuilderDataSource(value: unknown): value is QueryBuilderDataSource {
  return value === "traces" || value === "logs" || value === "metrics"
}

function toMetricType(
  value: unknown,
  fallback: QueryBuilderMetricType,
): QueryBuilderMetricType {
  return QUERY_BUILDER_METRIC_TYPES.includes(value as QueryBuilderMetricType)
    ? (value as QueryBuilderMetricType)
    : fallback
}

function isExplicitInvalidMetricType(value: unknown): boolean {
  return value !== undefined && !QUERY_BUILDER_METRIC_TYPES.includes(value as QueryBuilderMetricType)
}

function toQueryGroupByToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "service.name"
  switch (value) {
    case "service":
      return "service.name"
    case "span_name":
      return "span.name"
    case "status_code":
      return "status.code"
    case "http_method":
      return "http.method"
    case "none":
      return "none"
    default:
      return value
  }
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

function toStepInterval(raw: Record<string, unknown>, fallback: string): string {
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

  return fallback
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
  const defaultWhereClause = formatFiltersAsWhereClause({ filters: fallbackFilters })
  const groupBy = toQueryGroupByToken(queryRecord.groupBy)
  const addOns = asRecord(queryRecord.addOns)

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
    metricName: toMetricName(queryRecord, dataSource, queryBase.metricName),
    metricType: toMetricType(
      metricTypeInput,
      queryBase.metricType,
    ),
    whereClause:
      typeof queryRecord.whereClause === "string"
        ? queryRecord.whereClause
        : defaultWhereClause,
    aggregation:
      typeof queryRecord.aggregation === "string" && queryRecord.aggregation.trim().length > 0
        ? queryRecord.aggregation
        : typeof queryRecord.metric === "string" && queryRecord.metric.trim().length > 0
          ? queryRecord.metric
          : queryBase.aggregation,
    stepInterval: toStepInterval(queryRecord, queryBase.stepInterval),
    orderByDirection:
      queryRecord.orderByDirection === "asc" || queryRecord.orderByDirection === "desc"
        ? queryRecord.orderByDirection
        : queryBase.orderByDirection,
    addOns: {
      groupBy:
        typeof addOns?.groupBy === "boolean"
          ? addOns.groupBy
          : groupBy !== "none",
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
    if (!QUERY_BUILDER_METRIC_TYPES.includes(metricType as QueryBuilderMetricType)) {
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

export function normalizeAiWidgetProposal(
  input: AiWidgetProposal,
): NormalizeAiWidgetProposalResult {
  if (input.dataSource.endpoint !== "custom_query_builder_timeseries") {
    return { kind: "valid", proposal: input }
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

  const formulasInput = Array.isArray(params.formulas) ? params.formulas : []
  const normalizedFormulas = formulasInput
    .map((formula, index) => normalizeFormulaEntry(formula, index))
    .filter((formula): formula is QueryBuilderFormulaDraft => formula !== null)
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

  const normalizedDataSource: WidgetDataSource = {
    ...input.dataSource,
    params: {
      ...params,
      queries: normalizedQueries,
      formulas: normalizedFormulas,
      comparison: normalizedComparison,
      debug: params.debug === true,
    },
  }

  return {
    kind: "valid",
    proposal: {
      ...input,
      dataSource: normalizedDataSource,
    },
  }
}
