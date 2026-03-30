import {
  McpQueryError,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"

export function registerGetDashboardTool(server: McpToolRegistrar) {
  server.tool(
    "get_dashboard",
    "Get the full configuration of a dashboard by ID, including all widget definitions with their dataSource, display, and layout configs. Use list_dashboards first to find dashboard IDs. The returned JSON structure can be used as a reference when creating new dashboards via create_dashboard.",
    Schema.Struct({
      dashboard_id: requiredStringParam("Dashboard ID to retrieve"),
    }),
    ({ dashboard_id }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant
        const persistence = yield* DashboardPersistenceService

        const result = yield* persistence.list(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "get_dashboard",
              }),
          ),
        )

        const dashboard = result.dashboards.find((d) => d.id === dashboard_id)

        if (!dashboard) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Dashboard not found: ${dashboard_id}`,
              },
            ],
          }
        }

        const dashboardJson = {
          id: dashboard.id,
          name: dashboard.name,
          description: dashboard.description,
          tags: dashboard.tags ? [...dashboard.tags] : undefined,
          timeRange: dashboard.timeRange,
          widgets: dashboard.widgets.map((w) => ({
            id: w.id,
            visualization: w.visualization,
            dataSource: w.dataSource,
            display: w.display,
            layout: w.layout,
          })),
          createdAt: dashboard.createdAt,
          updatedAt: dashboard.updatedAt,
        }

        const lines: string[] = [
          `## Dashboard: ${dashboard.name}`,
          `ID: ${dashboard.id}`,
          `Widgets: ${dashboard.widgets.length}`,
          `Created: ${dashboard.createdAt.slice(0, 19)}`,
          `Updated: ${dashboard.updatedAt.slice(0, 19)}`,
          ``,
          `Full configuration (JSON):`,
          JSON.stringify(dashboardJson, null, 2),
        ]

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "get_dashboard",
            data: {
              dashboard: dashboardJson,
            },
          }),
        }
      }),
  )
}
