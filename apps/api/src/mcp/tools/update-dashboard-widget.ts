import { McpQueryError, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { decodeWidgetJson, withDashboardMutation } from "../lib/dashboard-mutations"

const TOOL = "update_dashboard_widget"

export function registerUpdateDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Replace a single widget on an existing dashboard. Pass the full widget JSON (same shape as one entry in `widgets[]` from get_dashboard) for ONLY the widget you want to change. Other widgets and dashboard metadata are left untouched. The stored widget id is always forced to the widget_id parameter, so any id inside widget_json is ignored.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard containing the widget (use list_dashboards to find IDs)",
			),
			widget_id: requiredStringParam(
				"ID of the widget to replace (use get_dashboard to see existing widget ids)",
			),
			widget_json: requiredStringParam(
				"Full JSON for the replacement widget: { id, visualization, dataSource, display, layout }. Any `id` field inside this JSON is ignored in favor of widget_id.",
			),
		}),
		Effect.fn("McpTool.updateDashboardWidget")(function* ({ dashboard_id, widget_id, widget_json }) {
			const parsedWidget = yield* decodeWidgetJson(widget_json, TOOL)

			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					const index = existingWidgets.findIndex((w) => w.id === widget_id)

					if (index === -1) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Widget not found: ${widget_id}. Use get_dashboard to see existing widget ids.`,
								pipe: TOOL,
							}),
						)
					}

					const replacement = { ...parsedWidget, id: widget_id }
					const next = existingWidgets.slice()
					next[index] = replacement
					return next
				}),
			)

			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: result.notFound }],
				}
			}

			const { dashboard } = result
			const updated = dashboard.widgets.find((w) => w.id === widget_id)

			const lines = [
				`## Widget Updated`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Widget ID: ${widget_id}`,
				`Visualization: ${updated?.visualization ?? "?"}`,
				`Total widgets: ${dashboard.widgets.length}`,
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
						widgetId: widget_id,
					},
				}),
			}
		}),
	)
}
