import {
  McpQueryError,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { PortableDashboardDocument } from "@maple/domain/http"

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)
const PortableDashboardFromJson = Schema.fromJsonString(PortableDashboardDocument)

// ---------------------------------------------------------------------------
// Dashboard templates
// ---------------------------------------------------------------------------

type WidgetDef = {
  id: string
  visualization: string
  dataSource: { endpoint: string; params?: Record<string, unknown>; transform?: Record<string, unknown> }
  display: Record<string, unknown>
  layout: { x: number; y: number; w: number; h: number }
}

// ---------------------------------------------------------------------------
// Query builder helpers — produce the full queries format expected by
// custom_query_builder_timeseries / custom_query_builder_breakdown
// ---------------------------------------------------------------------------

function makeQueryDraft(opts: {
  id: string
  name: string
  dataSource: "traces" | "logs" | "metrics"
  aggregation: string
  whereClause?: string
  groupBy?: string[]
  metricName?: string
  metricType?: string
  isMonotonic?: boolean
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name,
    enabled: true,
    dataSource: opts.dataSource,
    signalSource: "default",
    metricName: opts.metricName ?? "",
    metricType: opts.metricType ?? "sum",
    ...(opts.isMonotonic != null && { isMonotonic: opts.isMonotonic }),
    whereClause: opts.whereClause ?? "",
    aggregation: opts.aggregation,
    stepInterval: "",
    orderByDirection: "desc",
    addOns: {
      groupBy: (opts.groupBy?.length ?? 0) > 0,
      having: false,
      orderBy: false,
      limit: false,
      legend: false,
    },
    groupBy: opts.groupBy ?? [],
    having: "",
    orderBy: "",
    limit: "",
    legend: "",
  }
}

function makeQueryBuilderTimeseriesDataSource(
  queries: Record<string, unknown>[],
): { endpoint: string; params: Record<string, unknown> } {
  return {
    endpoint: "custom_query_builder_timeseries",
    params: {
      queries,
      formulas: [],
      comparison: { mode: "none", includePercentChange: true },
      debug: false,
    },
  }
}

function makeQueryBuilderBreakdownDataSource(
  queries: Record<string, unknown>[],
): { endpoint: string; params: Record<string, unknown> } {
  return {
    endpoint: "custom_query_builder_breakdown",
    params: { queries },
  }
}

const CHART_DISPLAY_AREA = {
  chartId: "query-builder-area",
  chartPresentation: { legend: "visible" },
  stacked: true,
  curveType: "monotone",
}

const CHART_DISPLAY_LINE = {
  chartId: "query-builder-line",
  chartPresentation: { legend: "visible" },
  stacked: false,
  curveType: "monotone",
}

const CHART_DISPLAY_BAR = {
  chartId: "query-builder-bar",
  chartPresentation: { legend: "visible" },
  stacked: true,
  curveType: "linear",
}

function chartDisplayForMetric(aggregation: string): Record<string, unknown> {
  if (["count", "error_rate", "rate", "increase"].includes(aggregation)) {
    return CHART_DISPLAY_AREA
  }
  if (["avg_duration", "p50_duration", "p95_duration", "p99_duration", "avg", "max", "min"].includes(aggregation)) {
    return CHART_DISPLAY_LINE
  }
  return CHART_DISPLAY_BAR
}

const UNIT_ALIASES: Record<string, string> = {
  ms: "duration_ms",
  milliseconds: "duration_ms",
  us: "duration_us",
  microseconds: "duration_us",
  s: "duration_s",
  seconds: "duration_s",
  ns: "duration_ns",
  nanoseconds: "duration_ns",
  "%": "percent",
  short: "number",
}

function normalizeUnit(unit: string): string {
  return UNIT_ALIASES[unit] ?? unit
}

function inferUnit(metric: string): string {
  if (["avg_duration", "p50_duration", "p95_duration", "p99_duration"].includes(metric)) return "duration_ms"
  if (metric === "error_rate") return "percent"
  return "number"
}

const VALID_GROUP_BY: Record<string, readonly string[]> = {
  traces: ["service.name", "span.name", "status.code", "http.method", "none"],
  logs: ["service.name", "severity", "none"],
  metrics: ["service.name", "none"],
}

const GROUP_BY_ALIASES: Record<string, string> = {
  service: "service.name",
  span_name: "span.name",
  status_code: "status.code",
  http_method: "http.method",
}

function validateGroupBy(
  rawGroupBy: string,
  source: string,
  widgetTitle: string,
): string | null {
  const resolved = GROUP_BY_ALIASES[rawGroupBy] ?? rawGroupBy
  const validOptions = VALID_GROUP_BY[source] ?? []

  if (validOptions.includes(resolved)) return null
  // metrics also allows attr.<key> pattern
  if (source === "metrics" && resolved.startsWith("attr.") && resolved.length > 5) return null

  const optsList = [...validOptions, ...(source === "metrics" ? ["attr.<key>"] : [])]
  return `Widget "${widgetTitle}": invalid group_by "${rawGroupBy}" for source=${source}. Valid: ${optsList.join(", ")}. ${source === "metrics" ? "Example: attr.signal" : ""}`
}

function serviceWhereClause(serviceName?: string): string {
  return serviceName ? `service.name = "${serviceName}"` : ""
}

function serviceHealthWidgets(serviceName?: string): WidgetDef[] {
  const where = serviceWhereClause(serviceName)
  const groupBy = ["service.name"]
  return [
    {
      id: "throughput",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: serviceName ? { service_name: serviceName } : {},
        transform: { reduceToValue: { field: "throughput", aggregate: "sum" } },
      },
      display: { title: "Throughput", unit: "number" },
      layout: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      id: "error-rate",
      visualization: "stat",
      dataSource: {
        ...makeQueryBuilderTimeseriesDataSource([
          makeQueryDraft({
            id: "error-rate-stat",
            name: "Error Rate",
            dataSource: "traces",
            aggregation: "error_rate",
            whereClause: where,
            groupBy: [],
          }),
        ]),
        transform: { reduceToValue: { field: "Error Rate", aggregate: "avg" } },
      },
      display: { title: "Error Rate", unit: "percent" },
      layout: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      id: "p50",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: serviceName ? { service_name: serviceName } : {},
        transform: { reduceToValue: { field: "p50LatencyMs", aggregate: "avg" } },
      },
      display: { title: "P50 Latency", unit: "duration_ms" },
      layout: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      id: "p95",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: serviceName ? { service_name: serviceName } : {},
        transform: { reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
      },
      display: { title: "P95 Latency", unit: "duration_ms" },
      layout: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      id: "throughput-chart",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "throughput",
          name: "Throughput",
          dataSource: "traces",
          aggregation: "count",
          whereClause: where,
          groupBy,
        }),
      ]),
      display: { title: "Throughput Over Time", ...CHART_DISPLAY_AREA, unit: "number" },
      layout: { x: 0, y: 2, w: 6, h: 4 },
    },
    {
      id: "error-rate-chart",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "error-rate",
          name: "Error Rate",
          dataSource: "traces",
          aggregation: "error_rate",
          whereClause: where,
          groupBy,
        }),
      ]),
      display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
      layout: { x: 6, y: 2, w: 6, h: 4 },
    },
    {
      id: "latency-chart",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "p95-latency",
          name: "P95 Latency",
          dataSource: "traces",
          aggregation: "p95_duration",
          whereClause: where,
          groupBy,
        }),
      ]),
      display: { title: "P95 Latency Over Time", ...CHART_DISPLAY_LINE, unit: "duration_ms" },
      layout: { x: 0, y: 6, w: 12, h: 4 },
    },
  ]
}

function errorTrackingWidgets(serviceName?: string): WidgetDef[] {
  const where = serviceWhereClause(serviceName)
  const groupBy = ["service.name"]
  return [
    {
      id: "error-rate-ts",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "error-rate",
          name: "Error Rate",
          dataSource: "traces",
          aggregation: "error_rate",
          whereClause: where,
          groupBy,
        }),
      ]),
      display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
      layout: { x: 0, y: 0, w: 12, h: 4 },
    },
    {
      id: "errors-by-type",
      visualization: "table",
      dataSource: {
        endpoint: "errors_by_type",
        params: {
          ...(serviceName && { services: [serviceName] }),
          limit: 20,
        },
      },
      display: {
        title: "Errors by Type",
        columns: [
          { field: "errorType", header: "Error Type" },
          { field: "count", header: "Count" },
          { field: "affectedServicesCount", header: "Services" },
        ],
      },
      layout: { x: 0, y: 4, w: 12, h: 5 },
    },
    {
      id: "recent-error-traces",
      visualization: "list",
      dataSource: {
        endpoint: "list_traces",
        params: {
          ...(serviceName && { service: serviceName }),
          hasError: true,
          limit: 10,
        },
      },
      display: {
        title: "Recent Error Traces",
        listDataSource: "traces",
        listLimit: 10,
      },
      layout: { x: 0, y: 9, w: 12, h: 5 },
    },
  ]
}

function metricOverviewWidgets(opts: {
  metricName: string
  metricType: string
  serviceName?: string
  metric?: string
}): WidgetDef[] {
  const agg = opts.metric ?? "avg"
  const metricsFilters: Record<string, unknown> = {
    metricName: opts.metricName,
    metricType: opts.metricType,
    ...(opts.serviceName && { serviceName: opts.serviceName }),
  }
  const where = opts.serviceName ? `service.name = "${opts.serviceName}"` : ""
  return [
    {
      id: "metric-current",
      visualization: "stat",
      dataSource: {
        endpoint: "custom_timeseries",
        params: { source: "metrics", metric: agg, groupBy: "none", filters: metricsFilters },
        transform: {
          flattenSeries: { valueField: "value" },
          reduceToValue: { field: "value", aggregate: "avg" },
        },
      },
      display: { title: `${opts.metricName} (${agg})` },
      layout: { x: 0, y: 0, w: 4, h: 2 },
    },
    {
      id: "metric-max",
      visualization: "stat",
      dataSource: {
        endpoint: "custom_timeseries",
        params: { source: "metrics", metric: "max", groupBy: "none", filters: metricsFilters },
        transform: {
          flattenSeries: { valueField: "value" },
          reduceToValue: { field: "value", aggregate: "max" },
        },
      },
      display: { title: `${opts.metricName} (max)` },
      layout: { x: 4, y: 0, w: 4, h: 2 },
    },
    {
      id: "metric-count",
      visualization: "stat",
      dataSource: {
        endpoint: "custom_timeseries",
        params: { source: "metrics", metric: "count", groupBy: "none", filters: metricsFilters },
        transform: {
          flattenSeries: { valueField: "value" },
          reduceToValue: { field: "value", aggregate: "sum" },
        },
      },
      display: { title: "Data Points", unit: "number" },
      layout: { x: 8, y: 0, w: 4, h: 2 },
    },
    {
      id: "metric-timeseries",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "metric-ts",
          name: opts.metricName,
          dataSource: "metrics",
          aggregation: agg,
          whereClause: where,
          groupBy: ["service.name"],
          metricName: opts.metricName,
          metricType: opts.metricType,
        }),
      ]),
      display: { title: `${opts.metricName} Over Time`, ...chartDisplayForMetric(agg) },
      layout: { x: 0, y: 2, w: 12, h: 4 },
    },
    {
      id: "metric-breakdown",
      visualization: "table",
      dataSource: makeQueryBuilderBreakdownDataSource([
        makeQueryDraft({
          id: "metric-bd",
          name: opts.metricName,
          dataSource: "metrics",
          aggregation: agg,
          whereClause: where,
          groupBy: ["service.name"],
          metricName: opts.metricName,
          metricType: opts.metricType,
        }),
      ]),
      display: {
        title: "By Service",
        columns: [
          { field: "name", header: "Service" },
          { field: "value", header: agg.charAt(0).toUpperCase() + agg.slice(1) },
        ],
      },
      layout: { x: 0, y: 6, w: 12, h: 4 },
    },
  ]
}

function platformOverviewWidgets(): WidgetDef[] {
  return [
    {
      id: "total-throughput",
      visualization: "stat",
      dataSource: {
        endpoint: "service_usage",
        transform: { reduceToValue: { field: "totalTraceCount", aggregate: "sum" } },
      },
      display: { title: "Total Traces", unit: "number" },
      layout: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      id: "total-errors",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
      },
      display: { title: "Total Errors", unit: "number" },
      layout: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      id: "error-rate",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        transform: { reduceToValue: { field: "errorRate", aggregate: "first" } },
      },
      display: { title: "Error Rate", unit: "percent" },
      layout: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      id: "affected-services",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        transform: { reduceToValue: { field: "affectedServicesCount", aggregate: "first" } },
      },
      display: { title: "Affected Services", unit: "number" },
      layout: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      id: "service-overview",
      visualization: "table",
      dataSource: { endpoint: "service_overview" },
      display: {
        title: "Service Overview",
        columns: [
          { field: "serviceName", header: "Service" },
          { field: "throughput", header: "Throughput", unit: "number", align: "right" },
          { field: "p95LatencyMs", header: "P95", unit: "duration_ms", align: "right" },
          { field: "errorCount", header: "Errors", unit: "number", align: "right" },
        ],
      },
      layout: { x: 0, y: 2, w: 12, h: 5 },
    },
    {
      id: "throughput-by-service",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "throughput",
          name: "Throughput",
          dataSource: "traces",
          aggregation: "count",
          groupBy: ["service.name"],
        }),
      ]),
      display: { title: "Throughput by Service", ...CHART_DISPLAY_AREA, unit: "number" },
      layout: { x: 0, y: 7, w: 6, h: 4 },
    },
    {
      id: "error-rate-by-service",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "error-rate",
          name: "Error Rate",
          dataSource: "traces",
          aggregation: "error_rate",
          groupBy: ["service.name"],
        }),
      ]),
      display: { title: "Error Rate by Service", ...CHART_DISPLAY_AREA },
      layout: { x: 6, y: 7, w: 6, h: 4 },
    },
    {
      id: "recent-error-traces",
      visualization: "list",
      dataSource: {
        endpoint: "list_traces",
        params: { hasError: true, limit: 10 },
      },
      display: {
        title: "Recent Error Traces",
        listDataSource: "traces",
        listWhereClause: "has_error = true",
        listLimit: 10,
      },
      layout: { x: 0, y: 11, w: 12, h: 5 },
    },
  ]
}

function httpEndpointsWidgets(serviceName?: string): WidgetDef[] {
  const where = serviceWhereClause(serviceName)
  return [
    {
      id: "top-endpoints-throughput",
      visualization: "table",
      dataSource: makeQueryBuilderBreakdownDataSource([
        makeQueryDraft({
          id: "top-throughput",
          name: "Throughput",
          dataSource: "traces",
          aggregation: "count",
          whereClause: where,
          groupBy: ["span.name"],
        }),
      ]),
      display: {
        title: "Top Endpoints by Throughput",
        columns: [
          { field: "name", header: "Endpoint" },
          { field: "value", header: "Requests", align: "right" },
        ],
      },
      layout: { x: 0, y: 0, w: 6, h: 5 },
    },
    {
      id: "slowest-endpoints",
      visualization: "table",
      dataSource: makeQueryBuilderBreakdownDataSource([
        makeQueryDraft({
          id: "slowest",
          name: "P95 Latency",
          dataSource: "traces",
          aggregation: "p95_duration",
          whereClause: where,
          groupBy: ["span.name"],
        }),
      ]),
      display: {
        title: "Slowest Endpoints (P95)",
        columns: [
          { field: "name", header: "Endpoint" },
          { field: "value", header: "P95 Latency", unit: "duration_ms", align: "right" },
        ],
      },
      layout: { x: 6, y: 0, w: 6, h: 5 },
    },
    {
      id: "endpoint-error-rate",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "error-rate",
          name: "Error Rate",
          dataSource: "traces",
          aggregation: "error_rate",
          whereClause: where,
          groupBy: ["span.name"],
        }),
      ]),
      display: { title: "Error Rate by Endpoint", ...CHART_DISPLAY_AREA },
      layout: { x: 0, y: 5, w: 12, h: 4 },
    },
    {
      id: "recent-traces",
      visualization: "list",
      dataSource: {
        endpoint: "list_traces",
        params: {
          ...(serviceName && { service: serviceName }),
          limit: 10,
        },
      },
      display: {
        title: "Recent Traces",
        listDataSource: "traces",
        listLimit: 10,
      },
      layout: { x: 0, y: 9, w: 12, h: 5 },
    },
  ]
}

function topErrorsWidgets(serviceName?: string): WidgetDef[] {
  const where = serviceWhereClause(serviceName)
  return [
    {
      id: "total-errors",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        params: serviceName ? { services: [serviceName] } : {},
        transform: { reduceToValue: { field: "totalErrors", aggregate: "first" } },
      },
      display: { title: "Total Errors", unit: "number" },
      layout: { x: 0, y: 0, w: 4, h: 2 },
    },
    {
      id: "error-rate",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        params: serviceName ? { services: [serviceName] } : {},
        transform: { reduceToValue: { field: "errorRate", aggregate: "first" } },
      },
      display: { title: "Error Rate", unit: "percent" },
      layout: { x: 4, y: 0, w: 4, h: 2 },
    },
    {
      id: "affected-services",
      visualization: "stat",
      dataSource: {
        endpoint: "errors_summary",
        params: serviceName ? { services: [serviceName] } : {},
        transform: { reduceToValue: { field: "affectedServicesCount", aggregate: "first" } },
      },
      display: { title: "Affected Services", unit: "number" },
      layout: { x: 8, y: 0, w: 4, h: 2 },
    },
    {
      id: "errors-by-type",
      visualization: "table",
      dataSource: {
        endpoint: "errors_by_type",
        params: {
          ...(serviceName && { services: [serviceName] }),
          limit: 20,
        },
      },
      display: {
        title: "Errors by Type",
        columns: [
          { field: "errorType", header: "Error Type" },
          { field: "count", header: "Count", align: "right" },
          { field: "affectedServicesCount", header: "Services", align: "right" },
        ],
      },
      layout: { x: 0, y: 2, w: 12, h: 5 },
    },
    {
      id: "error-rate-ts",
      visualization: "chart",
      dataSource: makeQueryBuilderTimeseriesDataSource([
        makeQueryDraft({
          id: "error-rate",
          name: "Error Rate",
          dataSource: "traces",
          aggregation: "error_rate",
          whereClause: where,
          groupBy: ["service.name"],
        }),
      ]),
      display: { title: "Error Rate Over Time", ...CHART_DISPLAY_AREA },
      layout: { x: 0, y: 7, w: 12, h: 4 },
    },
    {
      id: "recent-error-traces",
      visualization: "list",
      dataSource: {
        endpoint: "list_traces",
        params: {
          ...(serviceName && { service: serviceName }),
          hasError: true,
          limit: 10,
        },
      },
      display: {
        title: "Recent Error Traces",
        listDataSource: "traces",
        listWhereClause: "has_error = true",
        listLimit: 10,
      },
      layout: { x: 0, y: 11, w: 12, h: 5 },
    },
  ]
}

const DASHBOARD_TEMPLATES: Record<string, (serviceName?: string) => WidgetDef[]> = {
  service_health: serviceHealthWidgets,
  error_tracking: errorTrackingWidgets,
  platform_overview: platformOverviewWidgets,
  http_endpoints: httpEndpointsWidgets,
  top_errors: topErrorsWidgets,
  blank: () => [],
}

function generateDescription(template: string, serviceName?: string): string {
  const scope = serviceName ? ` for ${serviceName}` : ""
  switch (template) {
    case "service_health":
      return `Service health overview${scope} — throughput, error rate, and latency.`
    case "error_tracking":
      return `Error tracking${scope} — error rate trends, error types, and recent error traces.`
    case "metric_overview":
      return `Metric overview${scope} — current values, time series, and service breakdown.`
    case "platform_overview":
      return "Platform overview — cross-service health, throughput, error rates, and recent errors."
    case "http_endpoints":
      return `HTTP endpoint performance${scope} — top endpoints, slowest endpoints, and error rates.`
    case "top_errors":
      return `Error investigation${scope} — error counts, types, trends, and recent error traces.`
    default:
      return ""
  }
}

const TIME_RANGE_MAP: Record<string, string> = {
  "1h": "1h",
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
}

// ---------------------------------------------------------------------------
// Simplified widget specs → WidgetDef conversion
// ---------------------------------------------------------------------------

interface SimpleWidgetSpec {
  title: string
  visualization?: string
  source: string
  metric?: string
  metric_name?: string
  metric_type?: string
  service_name?: string
  group_by?: string
  unit?: string
}

function simpleSpecToWidget(
  spec: SimpleWidgetSpec,
  id: string,
  layout: { x: number; y: number; w: number; h: number },
): WidgetDef | string {
  const viz = spec.visualization ?? "chart"
  const source = spec.source

  if (!spec.title || !source) {
    return `Widget "${spec.title ?? "(untitled)"}": title and source are required.`
  }

  if (!["traces", "logs", "metrics"].includes(source)) {
    return `Widget "${spec.title}": source must be traces, logs, or metrics.`
  }

  if (source === "metrics" && (!spec.metric_name || !spec.metric_type)) {
    return `Widget "${spec.title}": source=metrics requires metric_name and metric_type. Use list_metrics to discover.`
  }

  const metric = spec.metric ?? (source === "metrics" ? "avg" : "count")
  const where = spec.service_name ? `service.name = "${spec.service_name}"` : ""

  let groupBy: string[]
  if (spec.group_by) {
    const resolved = GROUP_BY_ALIASES[spec.group_by] ?? spec.group_by
    const validationError = validateGroupBy(spec.group_by, source, spec.title)
    if (validationError) return validationError
    groupBy = [resolved]
  } else {
    groupBy = viz === "stat" ? [] : ["service.name"]
  }

  const queryDraft = makeQueryDraft({
    id: `q-${id}`,
    name: spec.title,
    dataSource: source as "traces" | "logs" | "metrics",
    aggregation: metric,
    whereClause: where,
    groupBy,
    metricName: spec.metric_name,
    metricType: spec.metric_type,
  })

  const display: Record<string, unknown> = { title: spec.title }
  display.unit = spec.unit ? normalizeUnit(spec.unit) : inferUnit(metric)

  if (viz === "table") {
    // Tables use breakdown queries grouped by the specified dimension
    if (groupBy.length === 0 || groupBy[0] === "none") {
      return `Widget "${spec.title}": table visualization requires a group_by field (e.g. service.name, span.name).`
    }
    const ds = makeQueryBuilderBreakdownDataSource([queryDraft])
    return {
      id,
      visualization: viz,
      dataSource: ds,
      display: {
        title: spec.title,
        columns: [
          { field: "name", header: groupBy[0]?.replace(".", " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? "Name" },
          { field: "value", header: spec.title, unit: display.unit as string, align: "right" },
        ],
      },
      layout,
    }
  }

  if (viz === "list") {
    // Lists show recent traces or logs
    if (source === "logs") {
      return {
        id,
        visualization: viz,
        dataSource: {
          endpoint: "list_logs",
          params: {
            ...(spec.service_name && { service: spec.service_name }),
            limit: 10,
          },
        },
        display: { title: spec.title, listDataSource: "logs", listLimit: 10 },
        layout,
      }
    }
    // Default to traces list
    return {
      id,
      visualization: viz,
      dataSource: {
        endpoint: "list_traces",
        params: {
          ...(spec.service_name && { service: spec.service_name }),
          limit: 10,
        },
      },
      display: { title: spec.title, listDataSource: "traces", listLimit: 10 },
      layout,
    }
  }

  if (viz === "stat") {
    // Stats still use custom_timeseries + flattenSeries for simplicity
    const metricsFilters: Record<string, unknown> | undefined =
      source === "metrics"
        ? {
            metricName: spec.metric_name,
            metricType: spec.metric_type,
            ...(spec.service_name && { serviceName: spec.service_name }),
          }
        : spec.service_name
          ? { serviceName: spec.service_name }
          : undefined

    return {
      id,
      visualization: viz,
      dataSource: {
        endpoint: "custom_timeseries",
        params: {
          source,
          metric,
          groupBy: "none",
          ...(metricsFilters && { filters: metricsFilters }),
        },
        transform: {
          flattenSeries: { valueField: "value" },
          reduceToValue: { field: "value", aggregate: "avg" },
        },
      },
      display,
      layout,
    }
  }

  // Chart — use query builder
  const ds = makeQueryBuilderTimeseriesDataSource([queryDraft])
  Object.assign(display, chartDisplayForMetric(metric))

  return {
    id,
    visualization: viz,
    dataSource: ds,
    display,
    layout,
  }
}

function computeAutoLayout(
  specs: SimpleWidgetSpec[],
): Array<{ x: number; y: number; w: number; h: number }> {
  const layouts: Array<{ x: number; y: number; w: number; h: number }> = []
  let y = 0
  let x = 0

  for (const spec of specs) {
    const viz = spec.visualization ?? "chart"
    if (viz === "stat") {
      if (x + 4 > 12) {
        y += 2
        x = 0
      }
      layouts.push({ x, y, w: 4, h: 2 })
      x += 4
    } else if (viz === "table" || viz === "list") {
      if (x > 0) {
        y += 2
        x = 0
      }
      layouts.push({ x: 0, y, w: 12, h: 5 })
      y += 5
    } else {
      if (x > 0) {
        y += 2
        x = 0
      }
      layouts.push({ x: 0, y, w: 12, h: 4 })
      y += 4
    }
  }

  return layouts
}

function parseSimpleWidgets(json: string): WidgetDef[] | string {
  let specs: SimpleWidgetSpec[]
  try {
    specs = JSON.parse(json)
  } catch {
    return "Invalid widgets JSON. Expected a JSON array of widget specs."
  }

  if (!Array.isArray(specs) || specs.length === 0) {
    return "widgets must be a non-empty JSON array."
  }

  const layouts = computeAutoLayout(specs)
  const widgets: WidgetDef[] = []
  const errors: string[] = []

  for (let i = 0; i < specs.length; i++) {
    const result = simpleSpecToWidget(specs[i], `w${i}`, layouts[i])
    if (typeof result === "string") {
      errors.push(result)
    } else {
      widgets.push(result)
    }
  }

  if (errors.length > 0) {
    return errors.join("\n")
  }

  return widgets
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCreateDashboardTool(server: McpToolRegistrar) {
  server.tool(
    "create_dashboard",
    "Create a dashboard from a template, simplified widget specs, or custom JSON.\n\n" +
      "Templates (just provide name + optional service_name):\n" +
      "  service_health — throughput, error rate, latency stats + charts\n" +
      "  error_tracking — error rate chart + errors by type + recent error traces\n" +
      "  platform_overview — cross-service health: throughput, errors, service table, charts, error traces\n" +
      "  http_endpoints — top endpoints by throughput, slowest endpoints, error rate by endpoint, slow traces\n" +
      "  top_errors — total errors, error types table, error rate trend, recent error traces\n" +
      "  metric_overview — requires metric_name + metric_type: current value stats + timeseries chart + service breakdown\n" +
      "  blank — empty dashboard\n\n" +
      "Simplified widgets (provide name + widgets JSON array, same params as query_data):\n" +
      '  Each: { title, visualization?: "chart"|"stat"|"table"|"list", source: "traces"|"logs"|"metrics", metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }\n' +
      "  group_by values (use exact format):\n" +
      "    traces: service.name, span.name, status.code, http.method, none\n" +
      "    logs: service.name, severity, none\n" +
      "    metrics: service.name, attr.<key> (e.g. attr.signal, attr.status), none\n" +
      "    Aliases accepted: service, span_name, status_code, http_method\n" +
      "  unit: auto-inferred from metric if omitted (duration_ms for latency, percent for error_rate, number otherwise). Override with: ms, us, s, ns, %, number.\n" +
      "  Note: table requires a group_by field. list shows recent traces or logs.\n" +
      "  Layouts auto-computed. Example:\n" +
      '  widgets=\'[{"title":"HTTP Duration","source":"metrics","metric":"avg","metric_name":"http.server.duration","metric_type":"histogram","group_by":"attr.method"}]\'\n\n' +
      "Custom JSON: provide dashboard_json with full widget definitions (use get_dashboard to see schema).",
    Schema.Struct({
      name: requiredStringParam("Dashboard name"),
      template: optionalStringParam(
        "Template: service_health, error_tracking, platform_overview, http_endpoints, top_errors, metric_overview, blank, or custom. " +
          "Templates auto-generate widgets. Default: service_health (if no widgets or dashboard_json provided).",
      ),
      service_name: optionalStringParam("Scope template widgets to a specific service"),
      time_range: optionalStringParam("Time range: 1h, 6h, 24h, or 7d (default: 1h)"),
      description: optionalStringParam("Dashboard description"),
      metric_name: optionalStringParam(
        "Metric name for metric_overview template (use list_metrics to discover). " +
          "Example: http.server.duration",
      ),
      metric_type: optionalStringParam(
        "Metric type for metric_overview template: sum, gauge, histogram, or exponential_histogram",
      ),
      widgets: optionalStringParam(
        "JSON array of simplified widget specs (alternative to templates and dashboard_json). " +
          'Each: { title, visualization?: "chart"|"stat", source: "traces"|"logs"|"metrics", ' +
          "metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }. " +
          "group_by must use dotted format: service.name, span.name, status.code, http.method, severity, attr.<key>, none. " +
          "Unit auto-inferred from metric if omitted. Layouts auto-computed.",
      ),
      dashboard_json: optionalStringParam(
        "Full dashboard JSON string for complete control over widget configuration. " +
          "Use get_dashboard to see the expected schema.",
      ),
    }),
    Effect.fn("McpTool.createDashboard")(function* (params) {
        let portable: PortableDashboardDocument

        // Priority: explicit template → widgets → dashboard_json → default template
        const templateName = params.template
          ?? (params.widgets ? undefined : params.dashboard_json ? "custom" : "service_health")

        if (templateName === "custom") {
          if (!params.dashboard_json) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Provide dashboard_json for custom template, or use a different approach:\n\n" +
                    "Simplified widgets example:\n" +
                    '  widgets=\'[{"title":"HTTP Duration","visualization":"chart","source":"metrics","metric":"avg","metric_name":"http.server.duration","metric_type":"histogram"}]\'\n\n' +
                    "Templates: service_health, error_tracking, platform_overview, http_endpoints, top_errors, metric_overview (requires metric_name + metric_type), blank\n\n" +
                    "For full custom JSON, use get_dashboard on an existing dashboard to see the expected schema.",
                },
              ],
            }
          }

          portable = yield* Schema.decodeUnknownEffect(PortableDashboardFromJson)(params.dashboard_json!).pipe(
            Effect.mapError(() => new McpQueryError({ message: "Invalid dashboard JSON", pipe: "create_dashboard" })),
          )
        } else if (templateName === "metric_overview") {
          if (!params.metric_name || !params.metric_type) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: 'template="metric_overview" requires metric_name and metric_type.\n' +
                    "Use list_metrics to discover available metrics.\n\n" +
                    'Example: metric_name="http.server.duration" metric_type="histogram"',
                },
              ],
            }
          }

          const timeRangeValue = TIME_RANGE_MAP[params.time_range ?? "1h"] ?? "1h"
          const widgets = metricOverviewWidgets({
            metricName: params.metric_name,
            metricType: params.metric_type,
            serviceName: params.service_name,
          })

          const description = params.description || generateDescription("metric_overview", params.service_name)
          portable = yield* Effect.try({
            try: () => decodePortableDashboard({
              name: params.name,
              ...(description && { description }),
              timeRange: { type: "relative", value: timeRangeValue },
              widgets,
            }),
            catch: (error) => new McpQueryError({ message: `Template generation error: ${String(error)}`, pipe: "create_dashboard" }),
          })
        } else if (!templateName && params.widgets) {
          // Simplified widget specs path
          const result = parseSimpleWidgets(params.widgets)
          if (typeof result === "string") {
            return {
              isError: true,
              content: [{ type: "text" as const, text: result }],
            }
          }

          const timeRangeValue = TIME_RANGE_MAP[params.time_range ?? "1h"] ?? "1h"

          portable = yield* Effect.try({
            try: () => decodePortableDashboard({
              name: params.name,
              ...(params.description && { description: params.description }),
              timeRange: { type: "relative", value: timeRangeValue },
              widgets: result,
            }),
            catch: (error) => new McpQueryError({ message: `Widget generation error: ${String(error)}`, pipe: "create_dashboard" }),
          })
        } else if (templateName) {
          const templateFn = DASHBOARD_TEMPLATES[templateName]
          if (!templateFn) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Unknown template "${templateName}". Available: ${Object.keys(DASHBOARD_TEMPLATES).join(", ")}, metric_overview, custom`,
                },
              ],
            }
          }

          const timeRangeValue = TIME_RANGE_MAP[params.time_range ?? "1h"] ?? "1h"
          const widgets = templateFn(params.service_name)
          const description = params.description || generateDescription(templateName, params.service_name)

          portable = yield* Effect.try({
            try: () => decodePortableDashboard({
              name: params.name,
              ...(description && { description }),
              timeRange: { type: "relative", value: timeRangeValue },
              widgets,
            }),
            catch: (error) => new McpQueryError({ message: `Template generation error: ${String(error)}`, pipe: "create_dashboard" }),
          })
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Provide a template, widgets, or dashboard_json.\n\n" +
                  "Templates: service_health, error_tracking, metric_overview, blank\n" +
                  'Simplified widgets: widgets=\'[{"title":"...","source":"metrics","metric_name":"...","metric_type":"..."}]\'\n' +
                  "Custom JSON: dashboard_json with full widget definitions",
              },
            ],
          }
        }

        const tenant = yield* resolveTenant
        const persistence = yield* DashboardPersistenceService

        const dashboard = yield* persistence
          .create(tenant.orgId, tenant.userId, portable)
          .pipe(
            Effect.mapError(
              (error) =>
                new McpQueryError({
                  message: error.message,
                  pipe: "create_dashboard",
                }),
            ),
          )

        const lines: string[] = [
          `## Dashboard Created`,
          `ID: ${dashboard.id}`,
          `Name: ${dashboard.name}`,
          `Widgets: ${dashboard.widgets.length}`,
          `Created: ${dashboard.createdAt.slice(0, 19)}`,
        ]

        if (dashboard.description) {
          lines.splice(3, 0, `Description: ${dashboard.description}`)
        }

        if (templateName && templateName !== "custom") {
          lines.push(`Template: ${templateName}`)
        } else if (params.widgets) {
          lines.push(`Source: simplified widget specs`)
        }

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "create_dashboard",
            data: {
              dashboard: {
                id: dashboard.id,
                name: dashboard.name,
                description: dashboard.description,
                tags: dashboard.tags ? [...dashboard.tags] : undefined,
                widgetCount: dashboard.widgets.length,
                createdAt: dashboard.createdAt,
                updatedAt: dashboard.updatedAt,
              },
            },
          }),
        }
      }),
  )
}
