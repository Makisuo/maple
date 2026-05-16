import {
	McpQueryError,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { RawSqlDisplayType } from "@maple/domain/http"
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
import {
	buildRawSqlDataSource,
	validateRawSqlMacro,
	visualizationToDisplayType,
} from "../lib/raw-sql-widget"
import { formatValidationSummary, inspectWidgetsAfterMutation } from "../lib/inspect-widget"
import { resolveTenant } from "../lib/query-tinybird"

const TOOL = "add_dashboard_widget"

// Widget kinds accepted by `visualization`. `markdown` is excluded — markdown
// widgets don't go through this tool today. Kept in lockstep with
// `VisualizationType` in apps/web/src/components/dashboard-builder/types.ts.
const KNOWN_VISUALIZATIONS = [
	"chart",
	"stat",
	"gauge",
	"table",
	"list",
	"pie",
	"histogram",
	"heatmap",
] as const

export function registerAddDashboardWidgetTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Add a single widget to an existing dashboard without re-sending the whole document. `visualization` MUST be one of: `chart`, `stat`, `gauge`, `table`, `list`, `pie`, `histogram`, `heatmap` — NOT a free-form title. `gauge` renders a single scalar on a radial gauge (same data shape as `stat`); set `display_json.gauge` to `{ min, max }` and `display_json.thresholds` to color the arc. For line/area/bar charts, pass `visualization: \"chart\"` and `display_type: \"line\"`/`\"area\"`/`\"bar\"`. Two creation paths:\n\n1. **Structured query builder** (default): pass `data_source_json` + `display_json` to wire the widget to a specific endpoint (`custom_query_builder_timeseries`, `service_overview`, etc.). Trace and log queries omit the metric-only fields (`metricName`/`metricType`/`isMonotonic`/`signalSource`) — only `dataSource: \"metrics\"` queries carry them. `whereClause` is a custom grammar (`=`, `>`, `<`, `>=`, `<=`, `contains`, `exists` joined by ` AND `) — there is NO SQL `IS NULL`/`IS NOT NULL`; use `<key> exists` to require an attribute. See the `maple://instructions` resource for the full widget JSON shape (aggregations per source, groupBy prefixes, units, stat reduceToValue, hideSeries).\n\n2. **Raw ClickHouse SQL**: pass `sql` to create a `raw_sql_chart` widget (the tool builds the dataSource for you — `data_source_json` is ignored). `sql` MUST reference `$__orgFilter`. Macros: `$__orgFilter` (required), `$__timeFilter(Column)`, `$__startTime`, `$__endTime`, `$__interval_s` (only useful when SQL also references it, typically inside `toStartOfInterval(…, INTERVAL $__interval_s SECOND)`).\n\n   **Before writing raw SQL, call `describe_warehouse_tables`** to discover real table and column names (no args → list every table; `table: \"<name>\"` → full column list with types, jsonPaths, sorting key, and curated notes on enum casing, units, sort-key hints). Do not guess table or column names — a hallucinated identifier silently produces an empty chart. Columns are PascalCase; values for `StatusCode`/`SeverityText`/`SpanKind` are Title Case (`'Error'` not `'ERROR'`); span `Duration` is in nanoseconds (divide by 1e6 for ms).\n\n   **SELECT shape per `display_type`** (the renderer is opinionated; wrong aliases → empty or `[object Object]`):\n   - `line`/`area`/`bar`: time bucket as first column (alias `bucket`) + ONE OR MORE numeric series columns. Each numeric column becomes one series; the column name becomes the legend label. **String columns are dropped**, so for multi-series (e.g., per-service breakdown) pivot in SQL with `countIf(...)` — tall form (`bucket, ServiceName, count()`) collapses to a single aggregate line. Single-series: `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS errors FROM ... WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket ORDER BY bucket`. Multi-series wide form: `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, countIf(ServiceName='api') AS api, countIf(ServiceName='web') AS web FROM ... GROUP BY bucket ORDER BY bucket`. For dynamic series labels, run a discovery query first (e.g., `query_data` or a quick top-N) and inject the values.\n   - `stat`: one scalar aliased `value` — `SELECT count() AS value FROM ... WHERE $__orgFilter AND $__timeFilter(Timestamp)`\n   - `pie`: `name` (label) + numeric column; cap with `LIMIT 8`-ish\n   - `heatmap`: three columns aliased `x`, `y`, `value` (string-cast numeric x/y)\n   - `table`: any rows; columns render in order\n   - `histogram`: one numeric column aliased `value` (renderer buckets client-side); add `LIMIT 5000`\n\n   If `display_type` is omitted it's derived from `visualization` (chart→line via `display_json.chartId`, stat→stat, table→table, pie→pie, histogram→histogram, heatmap→heatmap). The stat `reduceToValue` transform is auto-injected.\n\n   **See `maple://instructions` for the full table catalog, column lists, and worked examples per display type.**\n\nIf `layout_json` is omitted the widget is auto-placed using the same grid logic as the web UI. Returns the new widget id plus an automatic validation summary (verdict, flags). If `verdict` is `suspicious` or `broken`, fix via `update_dashboard_widget` — the chart will not render meaningful data as-is.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard to add the widget to (use list_dashboards to find IDs)",
			),
			visualization: requiredStringParam(
				'MUST be exactly one of: "chart", "stat", "gauge", "table", "list", "pie", "histogram", "heatmap". This is the widget KIND, not a title — set the title via `display_json.title`. For line/area/bar charts use `"chart"` and set `display_type` to `"line"`/`"area"`/`"bar"`.',
			),
			sql: optionalStringParam(
				"Raw ClickHouse SQL with macros (`$__orgFilter` required). When set, the tool creates a `raw_sql_chart` widget and ignores `data_source_json`.",
			),
			display_type: Schema.optional(RawSqlDisplayType).annotate({
				description:
					"Raw SQL display type: line/area/bar/table/stat/pie/histogram/heatmap. Only used when `sql` is set. Derived from `visualization` (+ `display_json.chartId`) if omitted.",
			}),
			granularity_seconds: optionalNumberParam(
				"Bucket size in seconds for raw SQL timeseries. Only used when `sql` is set. If omitted the server auto-computes from the dashboard time range.",
			),
			data_source_json: optionalStringParam(
				"JSON string for the widget's dataSource: { endpoint, params?, transform? }. Required for the structured-query path; ignored when `sql` is set. Use get_dashboard on an existing widget to see the exact shape.",
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
		}),
		Effect.fn("McpTool.addDashboardWidget")(function* ({
			dashboard_id,
			visualization,
			sql,
			display_type,
			granularity_seconds,
			data_source_json,
			display_json,
			layout_json,
			widget_id,
		}) {
			if (!(KNOWN_VISUALIZATIONS as ReadonlyArray<string>).includes(visualization)) {
				return validationError(
					`\`visualization\` must be one of: ${KNOWN_VISUALIZATIONS.join(", ")}. Got: ${JSON.stringify(visualization)}. This field is the widget KIND, not a title — set the title via \`display_json.title\`. For line/area/bar charts, use \`visualization: "chart"\` and \`display_type: "line"\`/"area"/"bar".`,
					'{ "visualization": "chart", "display_type": "line", "sql": "..." }',
				)
			}

			const useRawSql = typeof sql === "string" && sql.trim().length > 0
			if (!useRawSql && (!data_source_json || !display_json)) {
				return validationError(
					"add_dashboard_widget requires either `sql` (raw ClickHouse SQL path) or both `data_source_json` and `display_json` (structured-query path).",
					'{ "sql": "SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)" }',
				)
			}

			const display: DashboardWidget["display"] = display_json
				? yield* decodeDisplayJson(display_json, TOOL)
				: {}

			let dataSource: DashboardWidget["dataSource"]
			if (useRawSql) {
				const macroError = validateRawSqlMacro(sql)
				if (macroError) {
					return validationError(
						macroError,
						"SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					)
				}
				const displayType =
					display_type ?? visualizationToDisplayType(visualization, display.chartId)
				dataSource = buildRawSqlDataSource({
					visualization,
					sql,
					displayType,
					granularitySeconds: granularity_seconds,
				})
			} else {
				dataSource = yield* decodeDataSourceJson(data_source_json!, TOOL)
			}

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

			const tenant = yield* resolveTenant
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
				`Visualization: ${visualization}`,
				`Layout: x=${added?.layout.x ?? "?"} y=${added?.layout.y ?? "?"} w=${added?.layout.w ?? "?"} h=${added?.layout.h ?? "?"}`,
				`Total widgets: ${dashboard.widgets.length}`,
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
						widgetId: newId,
						...(validation.ran && { validation }),
					},
				}),
			}
		}),
	)
}
