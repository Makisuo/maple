import {
  McpQueryError,
  McpTenantError,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { HttpServerRequest } from "effect/unstable/http"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { PortableDashboardDocument } from "@maple/domain/http"

const resolveTenant = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const nativeReq = yield* HttpServerRequest.toWeb(req)
  return yield* resolveMcpTenantContext(nativeReq)
}).pipe(
  Effect.mapError((error: unknown) =>
    new McpTenantError({
      message:
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : String(error),
    }),
  ),
)

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)

export function registerCreateDashboardTool(server: McpToolRegistrar) {
  server.tool(
    "create_dashboard",
    "Create a new dashboard from a full JSON specification. The dashboard_json parameter must be a JSON string matching the PortableDashboardDocument schema. " +
      "Use get_dashboard on an existing dashboard to learn the widget structure. " +
      "Minimal example: {\"name\": \"My Dashboard\", \"timeRange\": {\"type\": \"relative\", \"value\": \"1h\"}, \"widgets\": []}. " +
      "Widget structure: {\"id\": \"unique-id\", \"visualization\": \"chart\"|\"stat\"|\"table\"|\"list\", " +
      "\"dataSource\": {\"endpoint\": \"service_overview\", \"params\": {}, \"transform\": {}}, " +
      "\"display\": {\"title\": \"Widget Title\"}, \"layout\": {\"x\": 0, \"y\": 0, \"w\": 6, \"h\": 4}}. " +
      "Grid is 12 columns wide. Common endpoints: service_overview, error_rate_by_service, list_traces, list_logs, list_metrics, " +
      "custom_traces_timeseries, custom_logs_timeseries, custom_metrics_timeseries, service_apdex_time_series.",
    Schema.Struct({
      dashboard_json: requiredStringParam(
        "Full dashboard JSON string matching PortableDashboardDocument: " +
          '{ name: string, description?: string, tags?: string[], timeRange: { type: "relative", value: "1h" } | { type: "absolute", startTime: string, endTime: string }, ' +
          "widgets: [{ id: string, visualization: string, dataSource: { endpoint: string, params?: {}, transform?: {} }, display: { title?: string, ... }, layout: { x: number, y: number, w: number, h: number } }] }",
      ),
    }),
    ({ dashboard_json }) =>
      Effect.gen(function* () {
        let parsed: unknown
        try {
          parsed = JSON.parse(dashboard_json)
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

        let portable: PortableDashboardDocument
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
          `=== Dashboard Created ===`,
          `ID: ${dashboard.id}`,
          `Name: ${dashboard.name}`,
          `Widgets: ${dashboard.widgets.length}`,
          `Created: ${dashboard.createdAt.slice(0, 19)}`,
        ]

        if (dashboard.description) {
          lines.splice(3, 0, `Description: ${dashboard.description}`)
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
