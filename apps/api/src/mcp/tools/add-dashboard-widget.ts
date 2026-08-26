import {
	McpQueryError,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { MCP_VISUALIZATIONS, RawSqlDisplayType } from "@maple/domain/http"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	decodeDataSourceJson,
	decodeDisplayJson,
	decodeLayoutJson,
	decodeTimeRangeJson,
	defaultSizeForPanelType,
	findNextWidgetPosition,
	generateWidgetId,
	withDashboardMutation,
	type DashboardWidget,
} from "@/mcp/lib/dashboard-mutations"
import { buildRawSqlDataSource, validateRawSql, withScalarReduction } from "@/mcp/lib/raw-sql-widget"
import { makeProductEventsFunnelDataSource } from "@maple/widgets/dashboard"
import { PANEL_TYPE_LIST_MD, resolvePanelType } from "@/mcp/lib/panel-type"
import { formatRenderIssues, validateWidgetRenderability } from "@/mcp/lib/validate-widget-renderability"
import {
	collectBlockingBuilderWarnings,
	formatValidationSummary,
	inspectWidgetsAfterMutation,
} from "@/mcp/lib/inspect-widget"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"

const TOOL = "add_dashboard_widget"

// Widget kinds accepted by the legacy `visualization` parameter, derived from
// the shared widget-type table so this can't drift behind the renderer registry
// the way the old hand-maintained copy did.
const KNOWN_VISUALIZATIONS = MCP_VISUALIZATIONS

// Rendered into the parameter description below. The list used to be retyped by
// hand even though the error message already derived it, so a newly
// `mcpExposed` widget type was advertised in one voice and rejected in another.
const VISUALIZATION_LIST_QUOTED = KNOWN_VISUALIZATIONS.map((viz) => `"${viz}"`).join(", ")

export function registerAddDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		// The panel-type list is on the `panel_type` parameter, where it is binding.
		// Rendering PANEL_TYPE_LIST_MD here too paid for the same list twice.
		"Add a single widget to an existing dashboard without re-sending the whole document. Two creation paths:\n\n" +
			"1. **Structured query builder**: pass `data_source_json` (a `kind`-discriminated data source) plus `display_json`.\n" +
			"2. **Raw ClickHouse SQL**: pass `sql` instead and the tool builds the data source. `sql` MUST reference `$__orgFilter`. Call `describe_warehouse_tables` first so you do not guess table or column names.\n\n" +
			"**Call `describe_dashboard_schema` before authoring** for the data-source kinds, unit vocabulary (`percent` is a 0–1 fraction, `percent_100` is 0–100 — inverted from Grafana), aggregations and group-by tokens, all generated from the live schema.\n\n" +
			"Layout is auto-placed when `layout_json` is omitted. The response carries an automatic validation summary; a `suspicious` or `broken` verdict means the chart will not render meaningfully as-is.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard to add the widget to (use list_dashboards to find IDs)",
			),
			panel_type: optionalStringParam(
				"The widget KIND — not a title (set that via `display_json.title`). MUST be exactly one of: " +
					PANEL_TYPE_LIST_MD +
					". This one field replaces the old `visualization` + `display_json.chartId` + `display_type` combination: `bar` and `area` are directly reachable here, and the matching `chartId` and raw-SQL display type are derived for you.",
			),
			visualization: optionalStringParam(
				"Legacy alias for `panel_type`, still accepted. One of: " +
					VISUALIZATION_LIST_QUOTED +
					". It collapses line/bar/area into `chart` and then needs `display_json.chartId` to tell them apart — prefer `panel_type`.",
			),
			sql: optionalStringParam(
				'Raw ClickHouse SQL with macros (`$__orgFilter` required). When set, the tool builds a `kind: "raw_sql"` data source and ignores `data_source_json`.',
			),
			display_type: Schema.optional(RawSqlDisplayType).annotate({
				description:
					"Raw SQL display type: line/area/bar/table/stat/pie/histogram/heatmap/funnel/hbar. Only used when `sql` is set. Derived from `visualization` (+ `display_json.chartId`) if omitted.",
			}),
			granularity_seconds: optionalNumberParam(
				"Bucket size in seconds for raw SQL timeseries. Only used when `sql` is set. If omitted the server auto-computes from the dashboard time range.",
			),
			data_source_json: optionalStringParam(
				"JSON string for the widget's dataSource: { endpoint, params?, transform? }. Required for the structured-query path; ignored when `sql` is set, and derived for you when `display_json.funnel.steps` defines a product-event funnel. Use get_dashboard on an existing widget to see the exact shape.",
			),
			display_json: optionalStringParam(
				"JSON string for the widget's display config: { title?, unit?, thresholds?, chartId?, columns?, ... }. Required for the structured-query path; defaults to `{}` for the raw-SQL path. Use get_dashboard on an existing widget to see the exact shape.",
			),
			layout_json: optionalStringParam(
				"Optional JSON string for layout { x, y, w, h }. If omitted the widget is auto-placed using a 12-column grid with sensible default sizes per visualization.",
			),
			widget_id: optionalStringParam(
				"Optional stable id for the new widget. If omitted a UUID is generated.",
			),
			time_range_json: optionalStringParam(
				'Optional JSON string pinning this widget to its own time range instead of the dashboard\'s: `{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"...","endTime":"..."}` (ISO 8601). Omit it and the widget follows the dashboard range, which is what almost every widget should do — use it only when the tile genuinely means a different window (an "active in the last 30 minutes" stat on a 7-day board). The widget header labels the override so readers can see it.',
			),
		}),
		Effect.fn("McpTool.addDashboardWidget")(function* ({
			dashboard_id,
			panel_type,
			visualization,
			sql,
			display_type,
			granularity_seconds,
			data_source_json,
			display_json,
			layout_json,
			widget_id,
			time_range_json,
		}) {
			const useRawSql = typeof sql === "string" && sql.trim().length > 0

			const decodedDisplay: DashboardWidget["display"] = display_json
				? yield* decodeDisplayJson(display_json, TOOL)
				: {}

			// A product-event funnel is defined by `display_json.funnel.steps` alone:
			// its data source is derived from that definition, so a caller need not
			// (and should not) hand-assemble the route.
			const funnelSteps = decodedDisplay.funnel?.steps
			const funnelDefinition =
				funnelSteps !== undefined && funnelSteps.length > 0
					? {
							steps: funnelSteps,
							keyBy: decodedDisplay.funnel?.keyBy,
							windowSeconds: decodedDisplay.funnel?.windowSeconds,
							breakdownBy: decodedDisplay.funnel?.breakdownBy,
							filters: decodedDisplay.funnel?.filters,
						}
					: undefined

			if (!useRawSql && funnelDefinition === undefined && (!data_source_json || !display_json)) {
				return validationError(
					"add_dashboard_widget requires either `sql` (raw ClickHouse SQL path), both `data_source_json` and `display_json` (structured-query path), or a `display_json.funnel.steps` definition (product-event funnel).",
					'{ "sql": "SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)" }',
				)
			}

			// One decision, one field. `panel_type` is preferred; `visualization`
			// stays accepted so agents and transcripts written against the old
			// surface keep working.
			const panelResolution = resolvePanelType({
				panel_type,
				visualization,
				chartId: decodedDisplay.chartId,
			})
			if (!panelResolution.ok) {
				return validationError(panelResolution.error, panelResolution.example)
			}
			const panel = panelResolution.resolved

			let dataSource: DashboardWidget["dataSource"]
			if (useRawSql) {
				// `list` has no raw-SQL rendering, so `rawSqlDisplayTypeFor` used to
				// fall back to `"line"` and the widget silently became a line chart.
				if (panel.rawSqlDisplayType === undefined) {
					return validationError(
						`\`panel_type: "${panel.panelType}"\` has no raw-SQL rendering, so passing \`sql\` would silently render it as a line chart. For tabular SQL results use \`panel_type: "table"\`; a list is configured via \`display_json.listDataSource\` instead.`,
						'{ "panel_type": "table", "sql": "SELECT ..." }',
					)
				}
				const sqlError = validateRawSql(sql)
				if (sqlError) {
					return validationError(
						sqlError,
						"SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					)
				}
				const displayType = display_type ?? panel.rawSqlDisplayType
				dataSource = buildRawSqlDataSource({
					visualization: panel.visualization,
					sql,
					displayType,
					granularitySeconds: granularity_seconds,
				})
			} else if (funnelDefinition !== undefined && !data_source_json) {
				if (panel.visualization !== "funnel") {
					return validationError(
						`\`display_json.funnel.steps\` defines a product-event funnel, which only \`panel_type: "funnel"\` renders (got \`${panel.panelType}\`).`,
						'{ "panel_type": "funnel", "display_json": "{\\"title\\":\\"Signup funnel\\",\\"funnel\\":{\\"steps\\":[{\\"kind\\":\\"page\\",\\"pagePath\\":\\"/pricing\\"},{\\"kind\\":\\"event\\",\\"eventName\\":\\"signup_completed\\"}]}}" }',
					)
				}
				dataSource = makeProductEventsFunnelDataSource(funnelDefinition)
			} else {
				dataSource = yield* decodeDataSourceJson(data_source_json!, TOOL)
				// A scalar tile reads `data[0].value`, so without a reduction it
				// renders `[object Object]`. The raw-SQL path has always injected
				// this; the structured path never did, which made every
				// MCP-authored stat and gauge broken by default.
				dataSource = withScalarReduction(dataSource, panel.meta.isScalar)
			}

			// The canonical `chartId` for the panel type, unless the caller pinned
			// one. This is what makes `panel_type: "bar"` reachable at all on the
			// structured path — previously the only way was a hand-written
			// `display_json.chartId` that no documentation mentioned.
			const display: DashboardWidget["display"] =
				panel.chartId !== undefined && decodedDisplay.chartId === undefined
					? { ...decodedDisplay, chartId: panel.chartId }
					: decodedDisplay

			const renderIssues = validateWidgetRenderability({
				widget: { visualization: panel.visualization, dataSource, display },
				panelType: panel.panelType,
			})
			if (renderIssues.fatal.length > 0) {
				return validationError(
					`This widget cannot render as configured (it was NOT saved):\n${formatRenderIssues({ fatal: renderIssues.fatal, warnings: [] })}`,
				)
			}

			// Reject clauses the query engine can't honor BEFORE persisting, so a
			// mis-scoped widget (dropped filter / group-by) can never be saved
			// silently. Raw-SQL widgets short-circuit (no query-builder warnings).
			const blockingWarnings = yield* collectBlockingBuilderWarnings(dataSource)
			if (blockingWarnings.length > 0) {
				return validationError(
					`This widget's query has clauses the engine can't honor, which would silently change what the chart shows (the widget was NOT saved):\n- ${blockingWarnings.join("\n- ")}\n\nFix and retry. Notes: span/resource attributes work automatically (e.g. \`query.context = "x"\`) but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys; prefix non-allowlisted groupBy keys with \`attr.\`.`,
				)
			}

			const explicitLayout = layout_json ? yield* decodeLayoutJson(layout_json, TOOL) : undefined
			const timeRange = time_range_json ? yield* decodeTimeRangeJson(time_range_json, TOOL) : undefined

			const newId = widget_id && widget_id.length > 0 ? widget_id : generateWidgetId()

			const result = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) =>
				Effect.gen(function* () {
					if (existingWidgets.some((w) => w.id === newId)) {
						return yield* Effect.fail(
							new McpQueryError({
								message: `Widget id "${newId}" already exists on dashboard ${dashboard_id}. Pass a different widget_id or omit it to auto-generate one.`,
								pipeName: TOOL,
							}),
						)
					}

					const layout =
						explicitLayout ??
						(() => {
							// Keyed off the panel type, not the visualization: a gauge
							// carries an `mcpWidth` override that `"chart"` would lose.
							const size = defaultSizeForPanelType(panel.panelType)
							const position = findNextWidgetPosition(existingWidgets, size.w)
							return { ...position, w: size.w, h: size.h }
						})()

					const widget: DashboardWidget = {
						id: newId,
						visualization: panel.visualization,
						dataSource,
						display,
						layout,
						// Absent unless asked for: the key must not exist at all, so the
						// widget reads as "follows the dashboard range".
						...(timeRange ? { timeRange } : undefined),
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

			const tenant = yield* CurrentMcpTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: [newId],
				validate: true,
			})

			const lines = [
				`## Widget Added`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Widget ID: ${newId}`,
				`Panel type: ${panel.panelType} (visualization: ${panel.visualization})`,
				...(timeRange
					? [
							`Time range: pinned to ${timeRange.type === "relative" ? `last ${timeRange.value}` : `${timeRange.startTime} → ${timeRange.endTime}`} (not the dashboard's)`,
						]
					: []),
				`Layout: x=${added?.layout.x ?? "?"} y=${added?.layout.y ?? "?"} w=${added?.layout.w ?? "?"} h=${added?.layout.h ?? "?"}`,
				`Total widgets: ${dashboard.widgets.length}`,
			]

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
						widgetId: newId,
						...(validation.ran ? { validation } : undefined),
					},
				}),
			}
		}),
	)
}
