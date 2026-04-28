import { McpQueryError, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { withDashboardMutation } from "../lib/dashboard-mutations"

const TOOL = "remove_dashboard_widget"

export function registerRemoveDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Remove a single widget from a dashboard by id. Other widgets and dashboard metadata are left untouched.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard containing the widget (use list_dashboards to find IDs)",
			),
			widget_id: requiredStringParam(
				"ID of the widget to remove (use get_dashboard to see existing widget ids)",
			),
		}),
		Effect.fn("McpTool.removeDashboardWidget")(function* ({ dashboard_id, widget_id }) {
			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					if (!existingWidgets.some((w) => w.id === widget_id)) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Widget not found: ${widget_id}. Use get_dashboard to see existing widget ids.`,
								pipe: TOOL,
							}),
						)
					}

					return existingWidgets.filter((w) => w.id !== widget_id)
				}),
			)

			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: result.notFound }],
				}
			}

			const { dashboard } = result

			const lines = [
				`## Widget Removed`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Removed Widget ID: ${widget_id}`,
				`Remaining widgets: ${dashboard.widgets.length}`,
				`Updated: ${dashboard.updatedAt.slice(0, 19)}`,
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: TOOL,
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
						removedWidgetId: widget_id,
					},
				}),
			}
		}),
	)
}
