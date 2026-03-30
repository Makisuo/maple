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
  const params = serviceName ? { service_name: serviceName } : {}
  return [
    {
      id: "throughput",
      visualization: "stat",
      dataSource: {
        endpoint: "service_overview",
        params,
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
        params,
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
        params,
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
        params,
        transform: { reduceToValue: { field: "p95LatencyMs", aggregate: "avg" } },
      },
      display: { title: "P95 Latency", unit: "ms" },
      layout: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      id: "throughput-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_traces_timeseries",
        params: { ...params, metric: "count", group_by: "service" },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "Throughput Over Time" },
      layout: { x: 0, y: 2, w: 6, h: 4 },
    },
    {
      id: "error-rate-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_traces_timeseries",
        params: { ...params, metric: "error_rate", group_by: "service" },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "Error Rate Over Time", unit: "%" },
      layout: { x: 6, y: 2, w: 6, h: 4 },
    },
    {
      id: "latency-chart",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_traces_timeseries",
        params: { ...params, metric: "p95_duration", group_by: "service" },
        transform: { flattenSeries: { valueField: "value" } },
      },
      display: { title: "P95 Latency Over Time", unit: "ms" },
      layout: { x: 0, y: 6, w: 12, h: 4 },
    },
  ]
}

function errorTrackingWidgets(serviceName?: string): WidgetDef[] {
  const params = serviceName ? { service_name: serviceName } : {}
  return [
    {
      id: "error-rate-ts",
      visualization: "chart",
      dataSource: {
        endpoint: "custom_traces_timeseries",
        params: { ...params, metric: "error_rate", group_by: "service" },
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
        params: { ...params, limit: 20 },
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
        params: { ...params, has_error: true, limit: 10 },
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
// Tool registration
// ---------------------------------------------------------------------------

export function registerCreateDashboardTool(server: McpToolRegistrar) {
  server.tool(
    "create_dashboard",
    "Create a dashboard from a template or custom JSON. " +
      "Templates: service_health (overview stats + latency + errors), error_tracking (error rate + errors by type + recent traces), blank (empty shell). " +
      "Use get_dashboard on an existing dashboard to learn widget structure for custom JSON.",
    Schema.Struct({
      name: requiredStringParam("Dashboard name"),
      template: optionalStringParam(
        "Template: service_health, error_tracking, blank, or custom (default: custom). " +
          "Templates auto-generate widgets — just provide name and optionally service_name.",
      ),
      service_name: optionalStringParam("Scope template widgets to a specific service"),
      time_range: optionalStringParam("Time range for template: 1h, 6h, 24h, or 7d (default: 1h)"),
      description: optionalStringParam("Dashboard description"),
      dashboard_json: optionalStringParam(
        "Full dashboard JSON string (required when template='custom' or no template). " +
          "Use get_dashboard to see the expected schema.",
      ),
    }),
    (params) =>
      Effect.gen(function* () {
        let portable: PortableDashboardDocument

        const templateName = params.template ?? (params.dashboard_json ? "custom" : "service_health")

        if (templateName === "custom") {
          if (!params.dashboard_json) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: 'template="custom" requires dashboard_json. Use get_dashboard to see the expected schema, or use a template (service_health, error_tracking, blank).',
                },
              ],
            }
          }

          let parsed: unknown
          try {
            parsed = JSON.parse(params.dashboard_json)
          } catch {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Invalid JSON: could not parse dashboard_json",
                },
              ],
            }
          }

          try {
            portable = decodePortableDashboard(parsed)
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Invalid dashboard schema: ${String(error)}`,
                },
              ],
            }
          }
        } else {
          const templateFn = DASHBOARD_TEMPLATES[templateName]
          if (!templateFn) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Unknown template "${templateName}". Available: ${Object.keys(DASHBOARD_TEMPLATES).join(", ")}, custom`,
                },
              ],
            }
          }

          const timeRangeValue = TIME_RANGE_MAP[params.time_range ?? "1h"] ?? "1h"
          const widgets = templateFn(params.service_name)

          try {
            portable = decodePortableDashboard({
              name: params.name,
              ...(params.description && { description: params.description }),
              timeRange: { type: "relative", value: timeRangeValue },
              widgets,
            })
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Template generation error: ${String(error)}`,
                },
              ],
            }
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

        if (templateName !== "custom") {
          lines.push(`Template: ${templateName}`)
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
