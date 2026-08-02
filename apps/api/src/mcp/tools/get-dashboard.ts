import { McpQueryError, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"

export function registerGetDashboardTool(server: McpToolRegistrar) {
	server.tool(
		"get_dashboard",
		"Get the full configuration of a dashboard by ID, including all widget definitions with their dataSource, display, and layout configs. Use list_dashboards first to find dashboard IDs. The returned JSON structure can be used as a reference when creating new dashboards via create_dashboard.",
		Schema.Struct({
			dashboard_id: requiredStringParam("Dashboard ID to retrieve"),
		}),
		Effect.fn("McpTool.getDashboard")(function* ({ dashboard_id }) {
			const tenant = yield* resolveTenant
			const persistence = yield* DashboardPersistenceService

			const result = yield* persistence.list(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "get_dashboard",
							cause: error,
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
				// Always emit `tags` (even empty) so the returned JSON round-trips
				// cleanly back through `update_dashboard`'s `dashboard_json`/the
				// incremental widget tools — an omitted `tags` previously made callers
				// guess whether the field was a document field at all.
				tags: dashboard.tags ? [...dashboard.tags] : [],
				timeRange: dashboard.timeRange,
				widgets: dashboard.widgets.map((w) => ({
					id: w.id,
					visualization: w.visualization,
					dataSource: w.dataSource,
					display: w.display,
					layout: w.layout,
					// Only present when the widget is pinned to its own window; the
					// absence is meaningful ("follows the dashboard range"), so it must
					// not become an explicit `undefined` on the way out.
					...(w.timeRange ? { timeRange: w.timeRange } : {}),
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
