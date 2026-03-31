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
import { DashboardDocument, PortableDashboardDocument } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain"

const decodePortableDashboard = Schema.decodeUnknownSync(PortableDashboardDocument)
const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)

const TIME_RANGE_MAP: Record<string, string> = {
  "1h": "1h",
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
}

export function registerUpdateDashboardTool(server: McpToolRegistrar) {
  server.tool(
    "update_dashboard",
    "Update an existing dashboard's name, description, time range, or full widget configuration. Use get_dashboard first to see the current state, then modify and pass back as dashboard_json.",
    Schema.Struct({
      dashboard_id: requiredStringParam("ID of the dashboard to update (use list_dashboards to find IDs)"),
      name: optionalStringParam("New dashboard name"),
      description: optionalStringParam("New dashboard description"),
      time_range: optionalStringParam("New time range: 1h, 6h, 24h, or 7d"),
      dashboard_json: optionalStringParam(
        "Full dashboard JSON to replace the current configuration. Use get_dashboard to see the current schema.",
      ),
    }),
    ({ dashboard_id, name, description, time_range, dashboard_json }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant
        const persistence = yield* DashboardPersistenceService

        const result = yield* persistence.list(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "update_dashboard",
              }),
          ),
        )

        const existing = result.dashboards.find((d) => d.id === dashboard_id)

        if (!existing) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Dashboard not found: ${dashboard_id}. Use list_dashboards to find available dashboard IDs.`,
              },
            ],
          }
        }

        const now = decodeIsoDateTimeString(new Date().toISOString())

        let updated: DashboardDocument

        if (dashboard_json) {
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

          updated = new DashboardDocument({
            id: existing.id,
            name: portable.name,
            description: portable.description,
            tags: portable.tags,
            timeRange: portable.timeRange,
            widgets: portable.widgets,
            createdAt: existing.createdAt,
            updatedAt: now,
          })
        } else {
          const timeRange = time_range
            ? {
                type: "relative" as const,
                value: TIME_RANGE_MAP[time_range] ?? time_range,
              }
            : existing.timeRange

          updated = new DashboardDocument({
            id: existing.id,
            name: name ?? existing.name,
            description: description ?? existing.description,
            tags: existing.tags,
            timeRange,
            widgets: existing.widgets,
            createdAt: existing.createdAt,
            updatedAt: now,
          })
        }

        const dashboard = yield* persistence
          .upsert(tenant.orgId, tenant.userId, updated)
          .pipe(
            Effect.mapError(
              (error) =>
                new McpQueryError({
                  message: error.message,
                  pipe: "update_dashboard",
                }),
            ),
          )

        const lines: string[] = [
          `## Dashboard Updated`,
          `ID: ${dashboard.id}`,
          `Name: ${dashboard.name}`,
          `Widgets: ${dashboard.widgets.length}`,
          `Updated: ${dashboard.updatedAt.slice(0, 19)}`,
        ]

        if (dashboard.description) {
          lines.splice(3, 0, `Description: ${dashboard.description}`)
        }

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "update_dashboard",
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
