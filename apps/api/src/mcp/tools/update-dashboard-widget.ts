import { McpQueryError, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { decodeWidgetJson, withDashboardMutation } from "@/mcp/lib/dashboard-mutations"
import { formatRenderIssues, validateWidgetRenderability } from "@/mcp/lib/validate-widget-renderability"
import { resolvePanelType } from "@/mcp/lib/panel-type"
import { withScalarReduction } from "@/mcp/lib/raw-sql-widget"
import {
	collectBlockingBuilderWarnings,
	formatValidationSummary,
	inspectWidgetsAfterMutation,
} from "@/mcp/lib/inspect-widget"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"

const TOOL = "update_dashboard_widget"

export function registerUpdateDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Replace a single widget on an existing dashboard. Pass the full widget JSON (the same shape as one entry in `widgets[]` from get_dashboard) for ONLY the widget you want to change; everything else is left untouched. The stored id is always forced to `widget_id`, so any `id` inside `widget_json` is ignored.\n\n" +
			"**Call `describe_dashboard_schema` before editing** for the data-source kinds, unit vocabulary, aggregations and group-by tokens — generated from the live schema.\n\n" +
			"This replaces the WHOLE widget, so omitting `timeRange` removes an existing per-widget override. The response carries render warnings plus an automatic validation summary; a `suspicious` or `broken` verdict means the chart will not render meaningfully as-is.",
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
			const decodedWidget = yield* decodeWidgetJson(widget_json, TOOL)

			// Repair rather than reject. A scalar tile needs `transform.reduceToValue`
			// to read `data[0].value`, and plenty of stored stats predate that being
			// checked — blocking here would make a legacy widget uneditable, so you
			// could not even fix its title. `add_dashboard_widget` injects the same
			// default, so both paths agree.
			const panel = resolvePanelType({
				visualization: decodedWidget.visualization,
				chartId: decodedWidget.display.chartId,
			})
			const parsedWidget = panel.ok
				? {
						...decodedWidget,
						dataSource: withScalarReduction(
							decodedWidget.dataSource,
							panel.resolved.meta.isScalar,
						),
					}
				: decodedWidget
			const repairedScalar = parsedWidget.dataSource !== decodedWidget.dataSource

			// Reject clauses the engine can't honor before persisting the replacement.
			const blockingWarnings = yield* collectBlockingBuilderWarnings(parsedWidget.dataSource)
			if (blockingWarnings.length > 0) {
				return validationError(
					`This widget's query has clauses the engine can't honor, which would silently change what the chart shows (the widget was NOT updated):\n- ${blockingWarnings.join("\n- ")}\n\nFix and retry. Notes: span/resource attributes work automatically (e.g. \`query.context = "x"\`) but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys; prefix non-allowlisted groupBy keys with \`attr.\`.`,
				)
			}

			// Combinations the renderer cannot draw — a scalar with no reduction, a
			// note wired to a query, a list backed by SQL.
			const renderIssues = validateWidgetRenderability({ widget: parsedWidget })
			if (renderIssues.fatal.length > 0) {
				return validationError(
					`This widget cannot render as configured (it was NOT updated):\n${formatRenderIssues({ fatal: renderIssues.fatal, warnings: [] })}`,
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

			const tenant = yield* CurrentMcpTenant
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

			if (repairedScalar) {
				lines.push(
					"",
					'Note: this widget had no `transform.reduceToValue`, so `{ field: "value", aggregate: "first" }` was added — a stat/gauge renders `[object Object]` without one. Set it explicitly to choose a different reducer.',
				)
			}

			if (renderIssues.warnings.length > 0) {
				lines.push(
					"",
					"### Render warnings",
					formatRenderIssues({ fatal: [], warnings: renderIssues.warnings }),
				)
			}

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
