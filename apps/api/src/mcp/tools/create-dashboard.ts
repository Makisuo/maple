import { McpQueryError, optionalStringParam, requiredStringParam, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import {
	DashboardTemplateParameterKey,
	PortableDashboardDocument,
	defaultWidgetLayout,
	findNextPosition,
} from "@maple/domain/http"
import { DASHBOARD_TEMPLATES, getTemplate } from "@/dashboard-templates"
import {
	QUERY_BUILDER_DATA_SOURCES,
	QUERY_BUILDER_METRIC_TYPES,
	toQueryBuilderDataSource,
	toQueryBuilderMetricType,
} from "@maple/query-model"
import {
	collectBlockingBuilderWarnings,
	formatValidationSummary,
	inspectWidgetsAfterMutation,
} from "@/mcp/lib/inspect-widget"
import {
	chartDisplayForMetric,
	makeQueryBuilderBreakdownDataSource,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
} from "@/dashboard-templates/helpers"
import type { TemplateParameterValues, WidgetDef } from "@/dashboard-templates"
import { validateDashboardTimeRange } from "@/mcp/lib/resolve-dashboard-time-range"
import { MAX_LIST_RANGE_SECONDS, MAX_QUERY_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"
import { makeRouteDataSource } from "@maple/widgets/dashboard"

const decodePortableDashboard = Schema.decodeUnknownEffect(PortableDashboardDocument)
const PortableDashboardFromJson = Schema.fromJsonString(PortableDashboardDocument)
const decodeParamKey = Schema.decodeUnknownSync(DashboardTemplateParameterKey)

// Simplified widget specs path — MCP-only, parses JSON tool input

function inferUnit(metric: string): string {
	if (["avg_duration", "p50_duration", "p95_duration", "p99_duration"].includes(metric))
		return "duration_ms"
	if (metric === "error_rate") return "percent"
	return "number"
}

const VALID_GROUP_BY: Record<string, readonly string[]> = {
	traces: ["service.name", "span.name", "status.code", "http.method", "none"],
	logs: ["service.name", "severity", "none"],
	metrics: ["service.name", "none"],
} satisfies Record<string, readonly string[]>

function validateGroupBy(rawGroupBy: string, source: string, widgetTitle: string): string | null {
	const validOptions = VALID_GROUP_BY[source] ?? []

	if (validOptions.includes(rawGroupBy)) return null
	if (source === "metrics" && rawGroupBy.startsWith("attr.") && rawGroupBy.length > 5) return null

	const optsList = [...validOptions, ...(source === "metrics" ? ["attr.<key>"] : [])]
	return `Widget "${widgetTitle}": invalid group_by "${rawGroupBy}" for source=${source}. Valid: ${optsList.join(", ")}. ${source === "metrics" ? "Example: attr.signal" : ""}`
}

/** The kinds `simpleSpecToWidget` actually knows how to build. */
const SIMPLE_SPEC_VISUALIZATIONS = ["chart", "stat", "table", "list"] as const
type SimpleSpecVisualization = (typeof SIMPLE_SPEC_VISUALIZATIONS)[number]

const isSimpleSpecVisualization = (value: string): value is SimpleSpecVisualization =>
	SIMPLE_SPEC_VISUALIZATIONS.some((candidate) => candidate === value)

interface SimpleWidgetSpec {
	title: string
	visualization?: string
	source: string
	metric?: string
	metric_name?: string
	metric_type?: string
	service_name?: string
	group_by?: string
	unit?: string
}

function simpleSpecToWidget(
	spec: SimpleWidgetSpec,
	id: string,
	layout: { x: number; y: number; w: number; h: number },
): WidgetDef | string {
	const viz = spec.visualization ?? "chart"
	const source = spec.source

	if (!spec.title || !source) {
		return `Widget "${spec.title ?? "(untitled)"}": title and source are required.`
	}

	// The simplified path builds four shapes and falls through to a timeseries
	// chart for anything else, so a `pie` or `heatmap` here would previously be
	// persisted with a timeseries data source it cannot draw. Reject instead of
	// silently mis-wiring; richer kinds go through `add_dashboard_widget`.
	if (!isSimpleSpecVisualization(viz)) {
		return `Widget "${spec.title}": visualization must be one of ${SIMPLE_SPEC_VISUALIZATIONS.join(", ")} for simplified specs. Use add_dashboard_widget for other kinds.`
	}

	const dataSource = toQueryBuilderDataSource(source)
	if (dataSource === null) {
		return `Widget "${spec.title}": source must be ${QUERY_BUILDER_DATA_SOURCES.join(", ")}.`
	}

	if (dataSource === "metrics" && (!spec.metric_name || !spec.metric_type)) {
		return `Widget "${spec.title}": source=metrics requires metric_name and metric_type. Use list_metrics to discover.`
	}

	// Narrowed rather than passed through: an unrecognised `metric_type` used to
	// be silently coerced to `gauge`, which draws a chart that looks fine and
	// aggregates a counter wrong.
	const metricType = spec.metric_type === undefined ? undefined : toQueryBuilderMetricType(spec.metric_type)
	if (spec.metric_type !== undefined && metricType === null) {
		return `Widget "${spec.title}": metric_type must be one of ${QUERY_BUILDER_METRIC_TYPES.join(", ")}.`
	}

	const metric = spec.metric ?? (source === "metrics" ? "avg" : "count")
	const where = spec.service_name ? `service.name = "${spec.service_name}"` : ""

	let groupBy: string[]
	if (spec.group_by) {
		const validationError = validateGroupBy(spec.group_by, source, spec.title)
		if (validationError) return validationError
		groupBy = [spec.group_by]
	} else {
		groupBy = viz === "stat" ? [] : ["service.name"]
	}

	const queryDraft = makeQueryDraft({
		id: `q-${id}`,
		name: spec.title,
		dataSource,
		aggregation: metric,
		whereClause: where,
		groupBy,
		metricName: spec.metric_name,
		...(!(metricType === null || metricType === undefined) ? { metricType } : undefined),
	})

	const display: Record<string, unknown> = { title: spec.title } satisfies Record<string, unknown>
	display.unit = spec.unit ?? inferUnit(metric)

	if (viz === "table") {
		if (groupBy.length === 0 || groupBy[0] === "none") {
			return `Widget "${spec.title}": table visualization requires a group_by field (e.g. service.name, span.name).`
		}
		const ds = makeQueryBuilderBreakdownDataSource([queryDraft])
		return {
			id,
			visualization: viz,
			dataSource: ds,
			display: {
				title: spec.title,
				columns: [
					{
						field: "name",
						header:
							groupBy[0]?.replace(".", " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ??
							"Name",
					},
					{ field: "value", header: spec.title, unit: display.unit as string, align: "right" },
				],
			},
			layout,
		}
	}

	if (viz === "list") {
		if (source === "logs") {
			return {
				id,
				visualization: viz,
				dataSource: makeRouteDataSource("list_logs", {
					...(spec.service_name ? { service: spec.service_name } : undefined),
					limit: 10,
				}),
				display: { title: spec.title, listDataSource: "logs", listLimit: 10 },
				layout,
			}
		}
		return {
			id,
			visualization: viz,
			dataSource: makeRouteDataSource("list_traces", {
				...(spec.service_name ? { service: spec.service_name } : undefined),
				limit: 10,
			}),
			display: { title: spec.title, listDataSource: "traces", listLimit: 10 },
			layout,
		}
	}

	if (viz === "stat") {
		// Same endpoint and query draft as every other kind here. This used to
		// build the legacy `custom_timeseries` shape with its own filter bag and a
		// `flattenSeries` step, so an agent-made stat was the one widget on a
		// dashboard that did not go through the query builder — and so the only one
		// `collectBlockingBuilderWarnings` could never inspect.
		//
		// `custom_query_builder_timeseries` returns wide rows (`{ bucket, <series>:
		// value }`), which `reduceToValue` reads directly — no flattening. Naming
		// the series after the widget title is a best effort; `resolveField` falls
		// back to the first numeric column, which for a single-query stat is the
		// only series.
		return {
			id,
			visualization: viz,
			dataSource: {
				...makeQueryBuilderTimeseriesDataSource([queryDraft]),
				transform: { reduceToValue: { field: spec.title, aggregate: "avg" } },
			},
			display,
			layout,
		}
	}

	const ds = makeQueryBuilderTimeseriesDataSource([queryDraft])
	Object.assign(display, chartDisplayForMetric(metric))

	return {
		id,
		visualization: viz,
		dataSource: ds,
		display,
		layout,
	}
}

/**
 * Grid rectangles for a run of simplified specs.
 *
 * Placement is the shared `findNextPosition`, so this agrees with the web store,
 * the MCP widget tools and the Perses importer instead of being a fourth
 * algorithm. What stays local is the *width* policy, which is genuinely this
 * tool's own: stats are quarter-width so a row of them reads as a strip of KPIs,
 * everything else is full-bleed because a simplified spec carries no layout
 * intent to honour.
 */
function computeAutoLayout(specs: SimpleWidgetSpec[]): Array<{ x: number; y: number; w: number; h: number }> {
	const placed: Array<{ layout: { x: number; y: number; w: number; h: number } }> = []

	for (const spec of specs) {
		const viz = spec.visualization ?? "chart"
		const { h } = defaultWidgetLayout(viz)
		const w = viz === "stat" ? 4 : 12
		placed.push({ layout: { ...findNextPosition(placed, w), w, h } })
	}

	return placed.map((widget) => widget.layout)
}

function parseSimpleWidgets(json: string): WidgetDef[] | string {
	let specs: SimpleWidgetSpec[]
	try {
		specs = JSON.parse(json)
	} catch {
		return "Invalid widgets JSON. Expected a JSON array of widget specs."
	}

	if (!Array.isArray(specs) || specs.length === 0) {
		return "widgets must be a non-empty JSON array."
	}

	const layouts = computeAutoLayout(specs)
	const widgets: WidgetDef[] = []
	const errors: string[] = []

	for (let i = 0; i < specs.length; i++) {
		const result = simpleSpecToWidget(specs[i], `w${i}`, layouts[i])
		if (typeof result === "string") {
			errors.push(result)
		} else {
			widgets.push(result)
		}
	}

	if (errors.length > 0) {
		return errors.join("\n")
	}

	return widgets
}

const DEFAULT_TIME_RANGE = "1h"

// Tool registration

export function registerCreateDashboardTool(server: McpToolRegistrar) {
	const templateList = DASHBOARD_TEMPLATES.map((t) => `  ${t.id} — ${t.description}`).join("\n")

	server.tool(
		"create_dashboard",
		"Create a dashboard from a template, simplified widget specs, or custom JSON.\n\n" +
			"Templates:\n" +
			templateList +
			"\n  custom — provide dashboard_json with full widget definitions\n\n" +
			"Each template accepts optional service_name (for app templates) or its own params (see list_dashboard_templates).\n\n" +
			"Simplified widgets (provide name + widgets JSON array, same params as query_data):\n" +
			'  Each: { title, visualization?: "chart"|"stat"|"table"|"list", source: "traces"|"logs"|"metrics", metric?, metric_name?, metric_type?, service_name?, group_by?, unit? }\n' +
			"  group_by: traces=service.name|span.name|status.code|http.method|none; logs=service.name|severity|none; metrics=service.name|attr.<key>|none\n" +
			"  Note: table requires a group_by field. list shows recent traces or logs.\n" +
			"Custom JSON: provide dashboard_json with full widget definitions (use get_dashboard to see schema). " +
			"For raw widget JSON, trace/log queries omit the metric-only fields (`metricName`/`metricType`/`isMonotonic`); `whereClause` is a custom grammar (use `exists` not SQL `IS NULL`). See `maple://instructions` for the full widget JSON shape.\n\n" +
			"After persistence, automatically validates every inspectable widget (custom_query_builder_timeseries/breakdown) and includes a per-widget verdict (looks_healthy/suspicious/broken) + sanity flags in the response. " +
			'Pass `validate: "false"` to skip validation when creating dashboards with many widgets.',
		Schema.Struct({
			name: requiredStringParam("Dashboard name"),
			template: optionalStringParam(
				"Template ID (kebab-case, e.g. `service-health`). Default: service-health (if no widgets/dashboard_json).",
			),
			service_name: optionalStringParam("Scope template widgets to a specific service"),
			time_range: optionalStringParam(
				`Dashboard time range as relative shorthand — e.g. 15m, 6h, 24h, 7d, 2w, 3mo, or "today". Up to ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)} (default: ${DEFAULT_TIME_RANGE}). Note that list widgets (recent traces/logs) only support ${formatRangeSeconds(MAX_LIST_RANGE_SECONDS)} and will ask the viewer to narrow their range on wider dashboards.`,
			),
			description: optionalStringParam("Dashboard description"),
			metric_name: optionalStringParam(
				"Metric name for metric-overview template (use list_metrics to discover). Example: http.server.duration",
			),
			metric_type: optionalStringParam(
				"Metric type for metric-overview template: sum, gauge, histogram, or exponential_histogram",
			),
			widgets: optionalStringParam(
				"JSON array of simplified widget specs (alternative to templates and dashboard_json).",
			),
			dashboard_json: optionalStringParam(
				"Full dashboard JSON string for complete control over widget configuration.",
			),
			validate: optionalStringParam(
				"Set to 'false' to skip automatic data validation on the created widgets. Default: validate.",
			),
		}),
		Effect.fn("McpTool.createDashboard")(function* (params) {
			let portable: PortableDashboardDocument

			if (params.time_range) {
				const timeRangeError = validateDashboardTimeRange(params.time_range)
				if (timeRangeError) {
					return {
						isError: true as const,
						content: [{ type: "text" as const, text: timeRangeError }],
					}
				}
			}

			const rawTemplate = params.template
			const templateName =
				rawTemplate ??
				(params.widgets ? undefined : params.dashboard_json ? "custom" : "service-health")

			if (templateName === "custom") {
				if (!params.dashboard_json) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text:
									"Provide dashboard_json for custom template, or use a different approach:\n\n" +
									"Simplified widgets example:\n" +
									'  widgets=\'[{"title":"HTTP Duration","visualization":"chart","source":"metrics","metric":"avg","metric_name":"http.server.duration","metric_type":"histogram"}]\'\n\n' +
									`Templates: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}\n\n` +
									"For full custom JSON, use get_dashboard on an existing dashboard to see the expected schema.",
							},
						],
					}
				}

				portable = yield* Schema.decodeEffect(PortableDashboardFromJson)(params.dashboard_json).pipe(
					Effect.mapError(
						(cause) =>
							new McpQueryError({
								message: "Invalid dashboard JSON",
								pipeName: "create_dashboard",
								cause,
							}),
					),
				)
			} else if (!templateName && params.widgets) {
				const result = parseSimpleWidgets(params.widgets)
				if (typeof result === "string") {
					return {
						isError: true,
						content: [{ type: "text" as const, text: result }],
					}
				}

				// The same pre-persist gate the widget mutation tools run. It never
				// ran here because this is a create rather than a mutate, so a
				// simplified spec that silently dropped a clause — an unsupported
				// group-by, an over-cap filter set — was persisted and only surfaced
				// as a confidently wrong chart in the browser.
				const blocking = yield* Effect.forEach(result, (widget) =>
					collectBlockingBuilderWarnings(widget.dataSource).pipe(
						Effect.map((warnings) =>
							warnings.map((w) => `${widget.display.title ?? widget.id}: ${w}`),
						),
					),
				).pipe(Effect.map((all) => all.flat()))

				if (blocking.length > 0) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `These widgets would not query what they describe:\n${blocking.map((w) => `  - ${w}`).join("\n")}`,
							},
						],
					}
				}

				const timeRangeValue = params.time_range ?? DEFAULT_TIME_RANGE

				portable = yield* decodePortableDashboard({
					name: params.name,
					...(params.description ? { description: params.description } : undefined),
					timeRange: { type: "relative", value: timeRangeValue },
					widgets: result,
				}).pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: `Widget generation error: ${String(error)}`,
								pipeName: "create_dashboard",
								cause: error,
							}),
					),
				)
			} else if (templateName) {
				const template = getTemplate(templateName)
				if (!template) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `Unknown template "${templateName}". Available: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}, custom`,
							},
						],
					}
				}

				const templateParams: TemplateParameterValues = {}
				if (params.service_name) {
					templateParams[decodeParamKey("service_name")] = params.service_name
				}
				if (params.metric_name) {
					templateParams[decodeParamKey("metric_name")] = params.metric_name
				}
				if (params.metric_type) {
					templateParams[decodeParamKey("metric_type")] = params.metric_type
				}

				const missingRequired = template.parameters
					.filter((p) => p.required && !templateParams[p.key])
					.map((p) => p.key)
				if (missingRequired.length > 0) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `Template "${template.id}" requires parameters: ${missingRequired.join(", ")}. Pass them as tool args (e.g. metric_name, metric_type).`,
							},
						],
					}
				}

				portable = yield* Effect.try({
					try: () => {
						const built = template.build(templateParams)
						const description = params.description ?? built.description
						return new PortableDashboardDocument({
							name: params.name || built.name,
							...(description ? { description } : undefined),
							...(built.tags ? { tags: built.tags } : undefined),
							// An explicit time_range wins over the template's default —
							// this branch used to drop the parameter entirely.
							timeRange: params.time_range
								? { type: "relative" as const, value: params.time_range }
								: built.timeRange,
							widgets: built.widgets,
						})
					},
					catch: (error) =>
						new McpQueryError({
							message: `Template generation error: ${String(error)}`,
							pipeName: "create_dashboard",
							cause: error,
						}),
				})
			} else {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text:
								"Provide a template, widgets, or dashboard_json.\n\n" +
								`Templates: ${DASHBOARD_TEMPLATES.map((t) => t.id).join(", ")}\n` +
								'Simplified widgets: widgets=\'[{"title":"...","source":"metrics","metric_name":"...","metric_type":"..."}]\'\n' +
								"Custom JSON: dashboard_json with full widget definitions",
						},
					],
				}
			}

			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const dashboard = yield* persistence.create(tenant.orgId, tenant.userId, portable).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "create_dashboard",
							cause: error,
						}),
				),
			)

			const validate = params.validate !== "false"
			const validation = yield* inspectWidgetsAfterMutation({
				tenant,
				dashboard,
				widgetIds: dashboard.widgets.map((w) => w.id),
				validate,
			})

			const lines: string[] = [
				`## Dashboard Created`,
				`ID: ${dashboard.id}`,
				`Name: ${dashboard.name}`,
				`Widgets: ${dashboard.widgets.length}`,
				`Created: ${dashboard.createdAt.slice(0, 19)}`,
			]

			if (dashboard.description) {
				lines.splice(3, 0, `Description: ${dashboard.description}`)
			}

			if (templateName && templateName !== "custom") {
				lines.push(`Template: ${templateName}`)
			} else if (params.widgets) {
				lines.push(`Source: simplified widget specs`)
			}

			const validationBlock = formatValidationSummary(validation, false)
			if (validationBlock) {
				lines.push("", validationBlock)
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "create_dashboard",
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
						...(validation.ran ? { validation } : undefined),
					},
				}),
			}
		}),
	)
}
