import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import {
  QUERY_BUILDER_METRIC_TYPES,
  createQueryDraft,
  formatFiltersAsWhereClause,
  resetQueryForDataSource,
  type QueryBuilderDataSource,
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

function toLegacyQuery(
  params: Record<string, unknown>,
): QueryBuilderQueryDraft | null {
  const source = params.source
  if (!isQueryBuilderDataSource(source)) return null

  const queryBase = resetQueryForDataSource(createQueryDraft(0), source)
  const filters = asRecord(params.filters)
  const aggregation =
    typeof params.metric === "string" && params.metric.trim().length > 0
      ? params.metric
      : queryBase.aggregation
  const groupBy = toQueryGroupByToken(params.groupBy)
  const metricName =
    source === "metrics" && typeof filters?.metricName === "string"
      ? filters.metricName
      : queryBase.metricName

  const metricType = toMetricType(filters?.metricType, queryBase.metricType)

  return {
    ...queryBase,
    dataSource: source,
    aggregation,
    stepInterval:
      typeof params.bucketSeconds === "number" &&
      Number.isFinite(params.bucketSeconds) &&
      params.bucketSeconds > 0
        ? String(params.bucketSeconds)
        : queryBase.stepInterval,
    whereClause: formatFiltersAsWhereClause(params),
    groupBy,
    addOns: {
      ...queryBase.addOns,
      groupBy: groupBy !== "none",
    },
    metricName,
    metricType,
  }
}

function validateMetricsQueries(
  queries: unknown[],
): string | null {
  for (const query of queries) {
    const queryRecord = asRecord(query)
    if (!queryRecord || queryRecord.dataSource !== "metrics") continue

    const metricName = queryRecord.metricName
    if (typeof metricName !== "string" || metricName.trim().length === 0) {
      return "Metrics chart needs metric name and metric type."
    }

    const metricType = queryRecord.metricType
    if (!QUERY_BUILDER_METRIC_TYPES.includes(metricType as QueryBuilderMetricType)) {
      return "Metrics chart needs metric name and metric type."
    }
  }

  return null
}

export function normalizeAiWidgetProposal(
  input: AiWidgetProposal,
): NormalizeAiWidgetProposalResult {
  if (input.dataSource.endpoint !== "custom_query_builder_timeseries") {
    return { kind: "valid", proposal: input }
  }

  const params = asRecord(input.dataSource.params) ?? {}
  const queriesInput = params.queries
  const normalizedQueries = Array.isArray(queriesInput)
    ? queriesInput
    : (() => {
        const legacyQuery = toLegacyQuery(params)
        return legacyQuery ? [legacyQuery] : null
      })()

  if (!normalizedQueries || normalizedQueries.length === 0) {
    return {
      kind: "blocked",
      reason: "Chart config is missing queries[] for query builder.",
      proposal: input,
    }
  }

  const metricsValidationError = validateMetricsQueries(normalizedQueries)
  if (metricsValidationError) {
    return {
      kind: "blocked",
      reason: metricsValidationError,
      proposal: input,
    }
  }

  const normalizedDataSource: WidgetDataSource = {
    ...input.dataSource,
    params: {
      ...params,
      queries: normalizedQueries,
      formulas: Array.isArray(params.formulas) ? params.formulas : [],
      comparison:
        asRecord(params.comparison) ?? {
          mode: "none",
          includePercentChange: true,
        },
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
