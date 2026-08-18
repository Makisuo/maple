import { McpQueryError, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { Effect, Result, Schema } from "effect"
import { DashboardWidgetSchema } from "@maple/domain/http"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	defaultSizeForVisualization,
	findNextWidgetPosition,
	generateWidgetId,
	withDashboardMutation,
	type DashboardWidget,
} from "@/mcp/lib/dashboard-mutations"
import {
	collectBlockingBuilderWarnings,
	formatValidationSummary,
	inspectWidgetsAfterMutation,
} from "@/mcp/lib/inspect-widget"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { validateWidgetRenderability } from "@/mcp/lib/validate-widget-renderability"
import { resolvePanelType } from "@/mcp/lib/panel-type"
import { withScalarReduction } from "@/mcp/lib/raw-sql-widget"

const TOOL = "replace_dashboard_widgets"

const decodeWidget = Schema.decodeUnknownEffect(DashboardWidgetSchema)
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

export function registerReplaceDashboardWidgetsTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		"Replace ALL widgets on a dashboard in one atomic, validated write — the safe middle ground between many incremental `add/update_dashboard_widget` calls and the corruption-prone full `dashboard_json` replace. Pass `widgets_json`: a JSON array of widget objects (same shape as `widgets[]` from get_dashboard). Each widget's query is validated BEFORE anything is persisted — if any widget references a filter/groupBy the engine can't honor, NOTHING is saved and the offending clauses are returned. Per-widget conveniences: `id` is auto-generated when omitted, and `layout` is auto-placed on a 12-column grid when omitted (so you can pass just `{ visualization, dataSource, display }`). Dashboard metadata (name, description, tags, time range) is left untouched. Returns an automatic validation summary; fix any `suspicious`/`broken` widgets and call again.",
		Schema.Struct({
			dashboard_id: requiredStringParam(
				"ID of the dashboard whose widgets to replace (use list_dashboards to find IDs)",
			),
			widgets_json: requiredStringParam(
				'JSON array of widget objects: [{ id?, visualization, dataSource, display, layout?, timeRange? }, ...]. `id` and `layout` are optional (auto-generated/auto-placed). `timeRange` pins one widget to its own window (`{"type":"relative","value":"30m"}` or `{"type":"absolute","startTime":"...","endTime":"..."}`); omit it and the widget follows the dashboard range, which is right for almost every widget. This REPLACES the entire widget list.',
			),
		}),
		Effect.fn("McpTool.replaceDashboardWidgets")(function* ({ dashboard_id, widgets_json }) {
			const parseResult = decodeJson(widgets_json)
			if (Result.isFailure(parseResult)) {
				return validationError(
					`widgets_json is not valid JSON: ${String(parseResult.failure)}`,
					'[{ "visualization": "stat", "dataSource": { ... }, "display": { ... } }]',
				)
			}
			const parsed = parseResult.success
			if (!Array.isArray(parsed)) {
				return validationError("widgets_json must be a JSON array of widget objects.")
			}
			if (parsed.length === 0) {
				return validationError(
					"widgets_json must contain at least one widget. To clear individual widgets use remove_dashboard_widget.",
				)
			}

			// Enrich each raw widget (auto id + auto layout) then decode. Layouts
			// are auto-placed against the widgets accumulated so far, matching the
			// single-widget add path.
			const widgets: DashboardWidget[] = []
			const repairedScalarIds: string[] = []
			for (let i = 0; i < parsed.length; i++) {
				const obj = parsed[i]
				if (obj === null || typeof obj !== "object") {
					return validationError(`widgets_json[${i}] is not an object.`)
				}
				const rec = obj as Record<string, unknown>
				const visualization = typeof rec.visualization === "string" ? rec.visualization : "chart"
				const candidate: Record<string, unknown> = {
					...rec,
					id: typeof rec.id === "string" && rec.id.length > 0 ? rec.id : generateWidgetId(),
				} satisfies Record<string, unknown>
				if (candidate.layout === undefined) {
					const size = defaultSizeForVisualization(visualization)
					const position = findNextWidgetPosition(widgets, size.w)
					candidate.layout = { ...position, w: size.w, h: size.h }
				}

				const decoded = yield* decodeWidget(candidate).pipe(
					Effect.mapError(
						(cause) =>
							new McpQueryError({
								message: `widgets_json[${i}] is not a valid widget: ${String(cause)}`,
								pipeName: TOOL,
								cause,
							}),
					),
				)

				// Repair a scalar with no reduction, exactly as the single-widget
				// paths do. Without this the batch tool was the strictest of the
				// three: `add` injects the default and `update` repairs, but a
				// get_dashboard -> replace_dashboard_widgets round trip over a board
				// holding one legacy stat failed outright and saved nothing — and
				// this is the tool the docs recommend over incremental calls.
				const panel = resolvePanelType({
					visualization: decoded.visualization,
					chartId: decoded.display.chartId,
				})
				const widget = panel.ok
					? {
							...decoded,
							dataSource: withScalarReduction(decoded.dataSource, panel.resolved.meta.isScalar),
						}
					: decoded
				if (widget.dataSource !== decoded.dataSource) repairedScalarIds.push(widget.id)
				widgets.push(widget)
			}

			const seenIds = new Set<string>()
			for (const w of widgets) {
				if (seenIds.has(w.id)) {
					return validationError(
						`Duplicate widget id "${w.id}" in widgets_json. Each widget needs a unique id (or omit id to auto-generate).`,
					)
				}
				seenIds.add(w.id)
			}

			// Validate every widget's query before persisting anything — an atomic,
			// all-or-nothing guard so a single bad widget can't corrupt the board.
			const blocking = yield* Effect.forEach(widgets, (w) =>
				collectBlockingBuilderWarnings(w.dataSource).pipe(
					Effect.map((warns) => warns.map((warn) => `[${w.id}] ${warn}`)),
				),
			).pipe(Effect.map((nested) => nested.flat()))
			if (blocking.length > 0) {
				return validationError(
					`Some widgets have clauses the engine can't honor — NOTHING was saved:\n- ${blocking.join("\n- ")}\n\nFix and retry. Span/resource attributes work automatically but cap at 5 attr filters; logs/metrics accept only a fixed set of filter/groupBy keys.`,
				)
			}

			// Same all-or-nothing guard for shapes the renderer can't draw. This is
			// a batch of freshly-authored widgets, not a restore, so fatal issues
			// block here exactly as they do on the single-widget add path.
			const renderIssues = widgets.map((widget) => ({
				widget,
				issues: validateWidgetRenderability({ widget }),
			}))
			const fatalRenderIssues = renderIssues.flatMap(({ widget, issues }) =>
				issues.fatal.map((message) => `[${widget.id}] ${message}`),
			)
			if (fatalRenderIssues.length > 0) {
				return validationError(
					`Some widgets cannot render as configured — NOTHING was saved:\n- ${fatalRenderIssues.join("\n- ")}`,
				)
			}
			const renderWarnings = renderIssues.flatMap(({ widget, issues }) =>
				issues.warnings.map((message) => `[${widget.id}] ${message}`),
			)

			const result = yield* withDashboardMutation(dashboard_id, TOOL, () => Effect.succeed(widgets))

			if (!result.ok) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: result.notFound }],
				}
			}

			const { dashboard } = result
			const tenant = yield* CurrentMcpTenant
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: widgets.map((w) => w.id),
				validate: true,
			})

			const lines = [
				`## Widgets Replaced`,
				`Dashboard: ${dashboard.name} (${dashboard.id})`,
				`Total widgets: ${dashboard.widgets.length}`,
				`Updated: ${dashboard.updatedAt.slice(0, 19)}`,
			]
			if (repairedScalarIds.length > 0) {
				lines.push(
					"",
					`Note: ${repairedScalarIds.length} scalar widget(s) had no \`transform.reduceToValue\` and were given \`{ field: "value", aggregate: "first" }\` — a stat/gauge renders \`[object Object]\` without one: ${repairedScalarIds.join(", ")}`,
				)
			}

			if (renderWarnings.length > 0) {
				lines.push("", "### Render warnings", ...renderWarnings.map((warning) => `- ${warning}`))
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
							tags: dashboard.tags ? [...dashboard.tags] : [],
							widgetCount: dashboard.widgets.length,
							createdAt: dashboard.createdAt,
							updatedAt: dashboard.updatedAt,
						},
						widgetIds: widgets.map((w) => w.id),
						...(validation.ran && { validation }),
					},
				}),
			}
		}),
	)
}
