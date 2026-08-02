import { McpQueryError, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { decodeWidgetJson, withDashboardMutation } from "../lib/dashboard-mutations"
import {
	collectBlockingBuilderWarnings,
	formatValidationSummary,
	inspectWidgetsAfterMutation,
} from "../lib/inspect-widget"
import { resolveTenant } from "../lib/query-warehouse"

const TOOL = "update_dashboard_widget"

export function registerUpdateDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		'Replace a single widget on an existing dashboard. Pass the full widget JSON (same shape as one entry in `widgets[]` from get_dashboard) for ONLY the widget you want to change. Other widgets and dashboard metadata are left untouched. The stored widget id is always forced to the widget_id parameter, so any id inside widget_json is ignored.\n\nThe response includes an automatic validation summary (verdict, flags). If `verdict` is `suspicious` or `broken`, fix the widget and call this tool again — the chart will not render meaningful data as-is.\n\nTrace and log queries omit the metric-only fields (`metricName`/`metricType`/`isMonotonic`/`signalSource`) — only `dataSource: "metrics"` queries carry them. `whereClause` is a custom grammar (`=`, `>`, `<`, `>=`, `<=`, `contains`, `exists` joined by ` AND `) — there is NO SQL `IS NULL`/`IS NOT NULL`; use `<key> exists` to require an attribute. See the `maple://instructions` resource for the full widget JSON shape (aggregations per source, groupBy prefixes, units, stat reduceToValue, hideSeries).',
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard containing the widget (use list_dashboards to find IDs)",
			),
			widget_id: requiredStringParam(
				"ID of the widget to replace (use get_dashboard to see existing widget ids)",
			),
			widget_json: requiredStringParam(
				'Full JSON for the replacement widget: { id, visualization, dataSource, display, layout, timeRange? }. Any `id` field inside this JSON is ignored in favor of widget_id. `timeRange` pins the widget to its own window (`{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"...","endTime":"..."}`); omitting it means "follow the dashboard\'s range", so leaving it out of an update REMOVES an existing override.',
			),
		}),
		Effect.fn("McpTool.updateDashboardWidget")(function* ({ dashboard_id, widget_id, widget_json }) {
			const parsedWidget = yield* decodeWidgetJson(widget_json, TOOL)

			// Reject clauses the engine can't honor before persisting the replacement.
			const blockingWarnings = yield* collectBlockingBuilderWarnings(parsedWidget.dataSource)
			if (blockingWarnings.length > 0) {
				return validationError(
					`This widget's query has clauses the engine can't honor, which would silently change what the chart shows (the widget was NOT updated):\n- ${blockingWarnings.join("\n- ")}\n\nFix and retry. Notes: span/resource attributes work automatically (e.g. \`query.context = "x"\`) but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys; prefix non-allowlisted groupBy keys with \`attr.\`.`,
				)
			}

			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					const index = existingWidgets.findIndex((w) => w.id === widget_id)

					if (index === -1) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Widget not found: ${widget_id}. Use get_dashboard to see existing widget ids.`,
								pipeName: TOOL,
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

			const tenant = yield* resolveTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: [widget_id],
				validate: true,
			})

			const lines = [
				`## Widget Updated`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Widget ID: ${widget_id}`,
				`Visualization: ${updated?.visualization ?? "?"}`,
				`Total widgets: ${dashboard.widgets.length}`,
				`Updated: ${dashboard.updatedAt.slice(0, 19)}`,
			]

			const validationBlock = formatValidationSummary(validation, true)
			if (validationBlock) {
				lines.push("", validationBlock)
			}

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
						...(validation.ran && { validation }),
					},
				}),
			}
		}),
	)
}
