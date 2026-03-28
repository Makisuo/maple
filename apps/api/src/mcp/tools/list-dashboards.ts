import {
  McpQueryError,
  McpTenantError,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatTable } from "../lib/format"
import { HttpServerRequest } from "effect/unstable/http"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"

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

export function registerListDashboardsTool(server: McpToolRegistrar) {
  server.tool(
    "list_dashboards",
    "List all dashboards in the organization. Returns dashboard ID, name, description, widget count, and timestamps. Use get_dashboard with a dashboard ID to see the full widget configuration.",
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
          `=== Dashboards ===`,
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
