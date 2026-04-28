import { McpQueryError, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import {
	decodeDataSourceJson,
	decodeDisplayJson,
	decodeLayoutJson,
	defaultSizeForVisualization,
	findNextWidgetPosition,
	generateWidgetId,
	withDashboardMutation,
	type DashboardWidget,
} from "../lib/dashboard-mutations"

const TOOL = "add_dashboard_widget"

export function registerAddDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Add a single widget to an existing dashboard without re-sending the whole document. Pass the widget's visualization type plus JSON-encoded dataSource and display config. If layout_json is omitted the widget is auto-placed using the same grid logic as the web UI. Returns the new widget id.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard to add the widget to (use list_dashboards to find IDs)",
			),
			visualization: requiredStringParam(
				'Widget visualization type: "chart", "stat", "table", or "list"',
			),
			data_source_json: requiredStringParam(
				"JSON string for the widget's dataSource: { endpoint, params?, transform? }. Use get_dashboard on an existing widget to see the exact shape.",
			),
			display_json: requiredStringParam(
				"JSON string for the widget's display config: { title?, unit?, thresholds?, chartId?, columns?, ... }. Use get_dashboard on an existing widget to see the exact shape.",
			),
			layout_json: optionalStringParam(
				"Optional JSON string for layout { x, y, w, h }. If omitted the widget is auto-placed using a 12-column grid with sensible default sizes per visualization.",
			),
			widget_id: optionalStringParam(
				"Optional stable id for the new widget. If omitted a UUID is generated.",
			),
		}),
		Effect.fn("McpTool.addDashboardWidget")(function* ({
			dashboard_id,
			visualization,
			data_source_json,
			display_json,
			layout_json,
			widget_id,
		}) {
			const dataSource = yield* decodeDataSourceJson(data_source_json, TOOL)
			const display = yield* decodeDisplayJson(display_json, TOOL)
			const explicitLayout = layout_json ? yield* decodeLayoutJson(layout_json, TOOL) : undefined

			const newId = widget_id && widget_id.length > 0 ? widget_id : generateWidgetId()

			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					if (existingWidgets.some((w) => w.id === newId)) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Widget id "${newId}" already exists on dashboard ${dashboard_id}. Pass a different widget_id or omit it to auto-generate one.`,
								pipe: TOOL,
							}),
						)
					}

					const layout =
						explicitLayout ??
						(() => {
							const size = defaultSizeForVisualization(visualization)
							const position = findNextWidgetPosition(existingWidgets, size.w)
							return { ...position, w: size.w, h: size.h }
						})()

					const widget: DashboardWidget = {
						id: newId,
						visualization,
						dataSource,
						display,
						layout,
					}

					return [...existingWidgets, widget]
				}),
			)

			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: result.notFound }],
				}
			}

			const { dashboard } = result
			const added = dashboard.widgets.find((w) => w.id === newId)

			const lines = [
				`## Widget Added`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Widget ID: ${newId}`,
				`Visualization: ${visualization}`,
				`Layout: x=${added?.layout.x ?? "?"} y=${added?.layout.y ?? "?"} w=${added?.layout.w ?? "?"} h=${added?.layout.h ?? "?"}`,
				`Total widgets: ${dashboard.widgets.length}`,
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
						widgetId: newId,
					},
				}),
			}
		}),
	)
}
