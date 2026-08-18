import { McpQueryError, optionalStringParam, type McpToolRegistrar } from "./types"
import { formatTable } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { DASHBOARD_TEMPLATES } from "@/dashboard-templates"

export function registerListDashboardsTool(server: McpToolRegistrar) {
	server.tool(
		"list_dashboards",
		"List all dashboards with widget counts and timestamps. Use get_dashboard to see full widget configuration.",
		Schema.Struct({
			search: optionalStringParam("Filter dashboards by name (case-insensitive contains)"),
		}),
		Effect.fn("McpTool.listDashboards")(function* ({ search }) {
			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const result = yield* persistence.list(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "list_dashboards",
							cause: error,
						}),
				),
			)

			let dashboards = result.dashboards

			if (search) {
				const lowerSearch = search.toLowerCase()
				dashboards = dashboards.filter((d) => d.name.toLowerCase().includes(lowerSearch))
			}

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				search: search ?? "none",
				"result.rowCount": dashboards.length,
			})

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
			// Interpolated rather than hardcoded: this line used to suggest
			// `service_health`, but template keys are kebab-case, so the suggestion
			// errored when followed literally.
			const exampleTemplate = DASHBOARD_TEMPLATES[0]?.id ?? "blank"
			nextSteps.push(
				`\`create_dashboard template="${exampleTemplate}"\` — create a new dashboard from template`,
			)
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
