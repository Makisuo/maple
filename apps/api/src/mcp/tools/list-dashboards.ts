import {
  McpQueryError,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"

export function registerListDashboardsTool(server: McpToolRegistrar) {
  server.tool(
    "list_dashboards",
    "List all dashboards with widget counts and timestamps. Use get_dashboard to see full widget configuration.",
    Schema.Struct({
      search: optionalStringParam("Filter dashboards by name (case-insensitive contains)"),
    }),
    ({ search }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant
        const persistence = yield* DashboardPersistenceService

        const result = yield* persistence.list(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_dashboards",
              }),
          ),
        )

        let dashboards = result.dashboards

        if (search) {
          const lowerSearch = search.toLowerCase()
          dashboards = dashboards.filter((d) =>
            d.name.toLowerCase().includes(lowerSearch),
          )
        }

        const lines: string[] = [
          `## Dashboards`,
          `Total: ${dashboards.length} dashboard${dashboards.length !== 1 ? "s" : ""}`,
          ``,
        ]

        if (dashboards.length === 0) {
          lines.push("No dashboards found.")
        } else {
          const headers = ["ID", "Name", "Widgets", "Updated"]
          const rows = dashboards.map((d) => [
            d.id,
            d.name,
            String(d.widgets.length),
            d.updatedAt.slice(0, 19),
          ])
          lines.push(formatTable(headers, rows))
        }

        const nextSteps: string[] = []
        for (const d of dashboards.slice(0, 3)) {
          nextSteps.push(`\`get_dashboard dashboard_id="${d.id}"\` — view dashboard configuration`)
        }
        nextSteps.push('`create_dashboard template="service_health"` — create a new dashboard from template')
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_dashboards",
            data: {
              dashboards: dashboards.map((d) => ({
                id: d.id,
                name: d.name,
                description: d.description,
                tags: d.tags ? [...d.tags] : undefined,
                widgetCount: d.widgets.length,
                createdAt: d.createdAt,
                updatedAt: d.updatedAt,
              })),
              total: dashboards.length,
            },
          }),
        }
      }),
  )
}
