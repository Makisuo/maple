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

function serviceHealthWidgets(serviceName?: string): WidgetDef[] {
  const svcParams = serviceName ? { service_name: serviceName } : {}
  const tracesFilters = serviceName ? { serviceName } : undefined
  return [
    {
      id: "throughput",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: svcParams,
        transform: { reduceToValue: { field: "throughput", aggregate: "sum" } },
      },
      display: { title: "Throughput" },
      layout: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      id: "error-rate",
      visualization: "stat",
      dataSource: {
        endpoint: "error_rate_by_service",
        params: svcParams,
        transform: { reduceToValue: { field: "errorRate", aggregate: "avg" } },
      },
      display: { title: "Error Rate", suffix: "%" },
      layout: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      id: "p50",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: svcParams,
        transform: { reduceToValue: { field: "p50LatencyMs", aggregate: "avg" } },
      },
      display: { title: "P50 Latency", unit: "ms" },
      layout: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      id: "p95",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params: svcParams,
        transform: { reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
      },
      display: { title: "P95 Latency", unit: "ms" },
      layout: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      id: "throughput-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_timeseries",
        params: {
          source: "traces",
          metric: "count",
          groupBy: "service",
          ...(tracesFilters && { filters: tracesFilters }),
        },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "Throughput Over Time" },
      layout: { x: 0, y: 2, w: 6, h: 4 },
    },
    {
      id: "error-rate-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_timeseries",
        params: {
          source: "traces",
          metric: "error_rate",
          groupBy: "service",
          ...(tracesFilters && { filters: tracesFilters }),
        },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "Error Rate Over Time", unit: "%" },
      layout: { x: 6, y: 2, w: 6, h: 4 },
    },
    {
      id: "latency-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_timeseries",
        params: {
          source: "traces",
          metric: "p95_duration",
          groupBy: "service",
          ...(tracesFilters && { filters: tracesFilters }),
        },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "P95 Latency Over Time", unit: "ms" },
      layout: { x: 0, y: 6, w: 12, h: 4 },
    },
  ]
}

function errorTrackingWidgets(serviceName?: string): WidgetDef[] {
  const svcParams = serviceName ? { service_name: serviceName } : {}
  const tracesFilters = serviceName ? { serviceName } : undefined
  return [
    {
      id: "error-rate-ts",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_timeseries",
        params: {
          source: "traces",
          metric: "error_rate",
          groupBy: "service",
          ...(tracesFilters && { filters: tracesFilters }),
        },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "Error Rate Over Time", unit: "%" },
      layout: { x: 0, y: 0, w: 12, h: 4 },
    },
    {
      id: "errors-by-type",
      visualization: "table",
      dataSource: {
        endpoint: "errors_by_type",
        params: { ...svcParams, limit: 20 },
      },
      display: {
        title: "Errors by Type",
        columns: [
          { field: "errorType", header: "Error Type" },
          { field: "count", header: "Count" },
          { field: "affectedServices", header: "Services" },
        ],
      },
      layout: { x: 0, y: 4, w: 12, h: 5 },
    },
    {
      id: "recent-error-traces",
      visualization: "list",
      dataSource: {
        endpoint: "list_traces",
        params: { ...svcParams, has_error: true, limit: 10 },
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
      display: { title: "Data Points" },
      layout: { x: 8, y: 0, w: 4, h: 2 },
    },
    {
      id: "metric-timeseries",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_timeseries",
        params: { source: "metrics", metric: agg, groupBy: "service", filters: metricsFilters },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: `${opts.metricName} Over Time` },
      layout: { x: 0, y: 2, w: 12, h: 4 },
    },
    {
      id: "metric-breakdown",
      visualization: "table",
      dataSource: {
        endpoint: "custom_breakdown",
        params: { source: "metrics", metric: agg, groupBy: "service", filters: metricsFilters },
      },
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

const DASHBOARD_TEMPLATES: Record<string, (serviceName?: string) => WidgetDef[]> = {
  service_health: serviceHealthWidgets,
  error_tracking: errorTrackingWidgets,
  blank: () => [],
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

  const params: Record<string, unknown> = { source, metric }

  if (viz === "table") {
    params.groupBy = spec.group_by ?? "service"
  } else {
    params.groupBy = spec.group_by ?? (viz === "stat" ? "none" : "service")
  }

  if (source === "metrics") {
    params.filters = {
      metricName: spec.metric_name,
      metricType: spec.metric_type,
      ...(spec.service_name && { serviceName: spec.service_name }),
    }
  } else if (spec.service_name) {
    params.filters = { serviceName: spec.service_name }
  }

  let endpoint: string
  let transform: Record<string, unknown> | undefined

  if (viz === "table") {
    endpoint = "custom_breakdown"
  } else {
    endpoint = "custom_timeseries"
    if (viz === "stat") {
      transform = {
        flattenSeries: { valueField: "value" },
        reduceToValue: { field: "value", aggregate: "avg" },
      }
    } else {
      transform = { flattenSeries: { valueField: "value" } }
    }
  }

  const display: Record<string, unknown> = { title: spec.title }
  if (spec.unit) display.unit = spec.unit
  if (viz === "table") {
    display.columns = [
      { field: "name", header: spec.group_by === "severity" ? "Severity" : "Service" },
      { field: "value", header: metric.charAt(0).toUpperCase() + metric.slice(1) },
    ]
  }

  return {
    id,
    visualization: viz,
    dataSource: {
      endpoint,
      params,
      ...(transform && { transform }),
    },
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
      "  metric_overview — requires metric_name + metric_type: current value stats + timeseries chart + service breakdown\n" +
      "  blank — empty dashboard\n\n" +
      "Simplified widgets (provide name + widgets JSON array, same params as query_data):\n" +
      '  Each: { title, visualization?: "chart"|"stat"|"table", source: "traces"|"logs"|"metrics", metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }\n' +
      "  Layouts auto-computed. Example:\n" +
      '  widgets=\'[{"title":"HTTP Duration","source":"metrics","metric":"avg","metric_name":"http.server.duration","metric_type":"histogram"}]\'\n\n' +
      "Custom JSON: provide dashboard_json with full widget definitions (use get_dashboard to see schema).",
    Schema.Struct({
      name: requiredStringParam("Dashboard name"),
      template: optionalStringParam(
        "Template: service_health, error_tracking, metric_overview, blank, or custom. " +
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
          'Each: { title, visualization?: "chart"|"stat"|"table", source: "traces"|"logs"|"metrics", ' +
          "metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }. " +
          "Uses same params as query_data. Layouts auto-computed.",
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
                    "Templates: service_health, error_tracking, metric_overview (requires metric_name + metric_type), blank\n\n" +
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

          portable = yield* Effect.try({
            try: () => decodePortableDashboard({
              name: params.name,
              ...(params.description && { description: params.description }),
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

          portable = yield* Effect.try({
            try: () => decodePortableDashboard({
              name: params.name,
              ...(params.description && { description: params.description }),
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
