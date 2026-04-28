import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { QueryEngineService } from "@/services/QueryEngineService"
import {
	QuerySpec,
	type QueryEngineResult,
	type BreakdownItem,
	type TimeseriesPoint,
} from "@maple/query-engine"
import {
	buildBreakdownQuerySpec,
	buildTimeseriesQuerySpec,
	type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"
import { createDualContent } from "../lib/structured-output"
import {
	computeBreakdownStats,
	computeFlags,
	computeTimeseriesStats,
	verdictFromFlags,
	type ChartFlag,
	type QueryStats,
} from "../lib/chart-statistics"
import { resolveDashboardTimeRange, type DashboardTimeRangeInput } from "../lib/resolve-dashboard-time-range"
import { resolveTimeRange } from "../lib/time"
import type {
	InspectChartDataData,
	InspectChartQueryResult,
	InspectChartQueryStats,
	InspectChartSeriesStat,
} from "@maple/domain"

const TIMESERIES_ENDPOINT = "custom_query_builder_timeseries"
const BREAKDOWN_ENDPOINT = "custom_query_builder_breakdown"
const MAX_QUERIES = 5

const QueryDraftSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.optional(Schema.Boolean),
	hidden: Schema.optional(Schema.Boolean),
	dataSource: Schema.Literals(["traces", "logs", "metrics"]),
	signalSource: Schema.optional(Schema.Literals(["default", "meter"])),
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])),
	isMonotonic: Schema.optional(Schema.Boolean),
	whereClause: Schema.optional(Schema.String),
	aggregation: Schema.String,
	stepInterval: Schema.optional(Schema.String),
	orderByDirection: Schema.optional(Schema.Literals(["desc", "asc"])),
	addOns: Schema.optional(
		Schema.Struct({
			groupBy: Schema.optional(Schema.Boolean),
			having: Schema.optional(Schema.Boolean),
			orderBy: Schema.optional(Schema.Boolean),
			limit: Schema.optional(Schema.Boolean),
			legend: Schema.optional(Schema.Boolean),
		}),
	),
	groupBy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	having: Schema.optional(Schema.String),
	orderBy: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	legend: Schema.optional(Schema.String),
})

const QueryBuilderParamsSchema = Schema.Struct({
	queries: Schema.mutable(Schema.Array(QueryDraftSchema)),
	formulas: Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown))),
})

const decodeQueryBuilderParamsSync = Schema.decodeUnknownSync(QueryBuilderParamsSchema)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

type RawQueryDraft = Schema.Schema.Type<typeof QueryDraftSchema>

function normalizeDraft(raw: RawQueryDraft): QueryBuilderQueryDraft {
	const groupByList = raw.groupBy ? [...raw.groupBy] : []
	return {
		id: raw.id,
		name: raw.name,
		enabled: raw.enabled ?? true,
		hidden: raw.hidden ?? false,
		dataSource: raw.dataSource,
		signalSource: raw.signalSource ?? "default",
		metricName: raw.metricName ?? "",
		metricType: raw.metricType ?? "sum",
		isMonotonic: raw.isMonotonic ?? false,
		whereClause: raw.whereClause ?? "",
		aggregation: raw.aggregation,
		stepInterval: raw.stepInterval ?? "",
		orderByDirection: raw.orderByDirection ?? "desc",
		addOns: {
			groupBy: raw.addOns?.groupBy ?? groupByList.length > 0,
			having: raw.addOns?.having ?? false,
			orderBy: raw.addOns?.orderBy ?? false,
			limit: raw.addOns?.limit ?? false,
			legend: raw.addOns?.legend ?? false,
		},
		groupBy: groupByList,
		having: raw.having ?? "",
		orderBy: raw.orderBy ?? "",
		limit: raw.limit ?? "",
		legend: raw.legend ?? "",
	}
}

function applyReduceToValue(
	result: QueryEngineResult,
	field: string,
	aggregate: string,
): { value: number | null; reason?: string } {
	const values: number[] = []

	if (result.kind === "timeseries") {
		for (const point of result.data as ReadonlyArray<TimeseriesPoint>) {
			const v = point.series[field]
			if (typeof v === "number" && !Number.isNaN(v)) values.push(v)
		}
	} else if (result.kind === "breakdown") {
		if (field === "value") {
			for (const row of result.data as ReadonlyArray<BreakdownItem>) {
				if (typeof row.value === "number") values.push(row.value)
			}
		} else {
			for (const row of result.data as ReadonlyArray<BreakdownItem>) {
				if (row.name === field && typeof row.value === "number") values.push(row.value)
			}
		}
	} else {
		return { value: null, reason: `cannot reduce ${result.kind} result` }
	}

	if (values.length === 0) {
		return { value: null, reason: `no values found for field "${field}"` }
	}

	switch (aggregate) {
		case "sum":
			return { value: values.reduce((a, b) => a + b, 0) }
		case "avg":
			return { value: values.reduce((a, b) => a + b, 0) / values.length }
		case "min":
			return { value: Math.min(...values) }
		case "max":
			return { value: Math.max(...values) }
		case "first":
			return { value: values[0] }
		case "count":
			return { value: values.length }
		default:
			return { value: null, reason: `unknown aggregate "${aggregate}"` }
	}
}

function statsToData(stats: QueryStats): InspectChartQueryStats {
	return {
		rowCount: stats.rowCount,
		seriesCount: stats.seriesCount,
		...(stats.firstBucket !== undefined && { firstBucket: stats.firstBucket }),
		...(stats.lastBucket !== undefined && { lastBucket: stats.lastBucket }),
		seriesStats: stats.seriesStats.map(
			(s): InspectChartSeriesStat => ({
				name: s.name,
				min: s.min,
				max: s.max,
				avg: s.avg,
				validCount: s.validCount,
				nullCount: s.nullCount,
				zeroCount: s.zeroCount,
				negativeCount: s.negativeCount,
				samples: s.samples.map((sample) => ({
					...(sample.bucket !== undefined && { bucket: sample.bucket }),
					value: sample.value,
				})),
			}),
		),
	}
}

function formatNumber(value: number | null): string {
	if (value === null) return "null"
	if (!Number.isFinite(value)) return String(value)
	if (Math.abs(value) >= 1000) return value.toFixed(0)
	if (Math.abs(value) >= 1) return value.toFixed(2)
	return value.toFixed(4)
}

function formatQueryBlock(query: InspectChartQueryResult): string {
	const lines: string[] = []
	lines.push(`### Query ${query.queryName} (${query.queryId})`)
	lines.push(`Status: ${query.status}`)
	if (query.status === "error" && query.error) {
		lines.push(`Error: ${query.error}`)
		return lines.join("\n")
	}
	lines.push(`Rows: ${query.stats.rowCount}, Series: ${query.stats.seriesCount}`)
	if (query.stats.firstBucket && query.stats.lastBucket) {
		lines.push(`Time span: ${query.stats.firstBucket} → ${query.stats.lastBucket}`)
	}
	if (query.reducedValue !== undefined) {
		lines.push(`Reduced value: ${formatNumber(query.reducedValue ?? null)}`)
	}
	if (query.stats.seriesStats.length > 0) {
		lines.push(`Series stats:`)
		for (const series of query.stats.seriesStats.slice(0, 10)) {
			lines.push(
				`  - ${series.name}: min=${formatNumber(series.min)} max=${formatNumber(series.max)} avg=${formatNumber(series.avg)} (valid=${series.validCount}, null=${series.nullCount}, zero=${series.zeroCount})`,
			)
		}
		if (query.stats.seriesStats.length > 10) {
			lines.push(`  … +${query.stats.seriesStats.length - 10} more series`)
		}
	}
	if (query.flags.length > 0) {
		lines.push(`Flags: ${query.flags.join(", ")}`)
	}
	return lines.join("\n")
}

function unsupportedEndpointResult(
	widget: {
		id: string
		visualization: string
		dataSource: {
			endpoint: string
			params?: Record<string, unknown>
			transform?: Record<string, unknown>
		}
		display: { title?: string; unit?: string }
	},
	dashboardName: string,
): McpToolResult {
	const text = [
		`## Widget inspection: ${widget.display.title ?? widget.id}`,
		`Dashboard: ${dashboardName}`,
		`Visualization: ${widget.visualization}`,
		`Endpoint: ${widget.dataSource.endpoint}`,
		``,
		`This endpoint is not yet supported by inspect_chart_data.`,
		`Use the \`query_data\` tool directly to verify, with the params shown below.`,
		``,
		`Widget definition:`,
		JSON.stringify(
			{
				endpoint: widget.dataSource.endpoint,
				params: widget.dataSource.params,
				transform: widget.dataSource.transform,
			},
			null,
			2,
		),
	].join("\n")

	return { content: [{ type: "text" as const, text }] }
}

const inspectChartDataDescription =
	"Inspect the actual data a dashboard chart will render. Use this tool **after every create_dashboard or update_dashboard call**, once per chart widget you created or modified, to verify the query produces meaningful data before reporting completion to the user. " +
	"Returns row counts, series statistics, sample data points, and sanity flags (EMPTY, ALL_ZEROS, FLAT_LINE, UNIT_MISMATCH, NEGATIVE_VALUES, UNREALISTIC_MAGNITUDE, SINGLE_SERIES_DOMINATES, CARDINALITY_EXPLOSION, SUSPICIOUS_GAP, BROKEN_BREAKDOWN, SINGLE_POINT, ALL_NULLS). " +
	"The verdict is one of `looks_healthy`, `suspicious`, or `broken`. **If the verdict is not `looks_healthy`, fix the widget via update_dashboard and re-inspect.** Triple-check critical charts. " +
	"Limitations: only supports custom_query_builder_timeseries and custom_query_builder_breakdown widgets (the kinds you typically create); formula expressions in `formulas[]` are NOT evaluated server-side — only the base queries are inspected; " +
	"checks only the requested window without the dashboard UI's auto-fallback. For predefined-endpoint widgets (service_overview, errors_summary, etc.), this tool returns guidance to use `query_data` directly with the widget's params."

export function registerInspectChartDataTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_chart_data",
		inspectChartDataDescription,
		Schema.Struct({
			dashboard_id: requiredStringParam("Dashboard ID containing the widget"),
			widget_id: requiredStringParam("Widget ID to inspect"),
			start_time: optionalStringParam(
				"Override start time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601). Defaults to the dashboard's configured timeRange.",
			),
			end_time: optionalStringParam(
				"Override end time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601). Defaults to the dashboard's configured timeRange.",
			),
		}),
		Effect.fn("McpTool.inspectChartData")(function* ({ dashboard_id, widget_id, start_time, end_time }) {
			const tenant = yield* resolveTenant
			const persistence = yield* DashboardPersistenceService

			const list = yield* persistence.list(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "inspect_chart_data",
						}),
				),
			)

			const dashboard = list.dashboards.find((d) => d.id === dashboard_id)
			if (!dashboard) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Dashboard not found: ${dashboard_id}. Use list_dashboards to discover valid IDs.`,
						},
					],
				}
			}

			const widget = dashboard.widgets.find((w) => w.id === widget_id)
			if (!widget) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Widget not found: ${widget_id} in dashboard ${dashboard_id}. Use get_dashboard to list widget IDs.`,
						},
					],
				}
			}

			// Resolve time range
			let resolvedStart: string
			let resolvedEnd: string
			let timeRangeSource: "override" | "dashboard" | "fallback"
			if (start_time && end_time) {
				const range = resolveTimeRange(start_time, end_time)
				resolvedStart = range.st
				resolvedEnd = range.et
				timeRangeSource = "override"
			} else {
				const resolved = resolveDashboardTimeRange(dashboard.timeRange as DashboardTimeRangeInput)
				if (resolved) {
					resolvedStart = resolved.startTime
					resolvedEnd = resolved.endTime
					timeRangeSource = "dashboard"
				} else {
					const fallback = resolveTimeRange(undefined, undefined, 6)
					resolvedStart = fallback.st
					resolvedEnd = fallback.et
					timeRangeSource = "fallback"
				}
			}

			const endpoint = widget.dataSource.endpoint
			const isTimeseries = endpoint === TIMESERIES_ENDPOINT
			const isBreakdown = endpoint === BREAKDOWN_ENDPOINT

			if (!isTimeseries && !isBreakdown) {
				return unsupportedEndpointResult(
					{
						id: widget.id,
						visualization: widget.visualization,
						dataSource: {
							endpoint: widget.dataSource.endpoint,
							...(widget.dataSource.params && {
								params: widget.dataSource.params as Record<string, unknown>,
							}),
							...(widget.dataSource.transform && {
								transform: widget.dataSource.transform as Record<string, unknown>,
							}),
						},
						display: {
							...(widget.display.title !== undefined && { title: widget.display.title }),
							...(widget.display.unit !== undefined && { unit: widget.display.unit }),
						},
					},
					dashboard.name,
				)
			}

			// Decode params
			const rawParams = widget.dataSource.params
			if (!rawParams || typeof rawParams !== "object") {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Widget has no dataSource.params; cannot inspect.`,
						},
					],
				}
			}

			let decodedParams: Schema.Schema.Type<typeof QueryBuilderParamsSchema>
			try {
				decodedParams = decodeQueryBuilderParamsSync(rawParams)
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Failed to decode widget params: ${String(error)}. The widget's queries[] does not match the query-builder shape.`,
						},
					],
				}
			}

			const enabledRawDrafts = decodedParams.queries.filter((q) => q.enabled !== false)
			if (enabledRawDrafts.length === 0) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Widget has no enabled queries to inspect.`,
						},
					],
				}
			}
			if (enabledRawDrafts.length > MAX_QUERIES) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Widget has ${enabledRawDrafts.length} enabled queries; inspect_chart_data caps at ${MAX_QUERIES}. Refactor the widget to use fewer queries.`,
						},
					],
				}
			}

			const formulas = decodedParams.formulas ?? []
			const hasFormulaWarning = formulas.length > 0
			const transformObj = widget.dataSource.transform as Record<string, unknown> | undefined
			const reduceToValue = transformObj?.reduceToValue as
				| { field?: unknown; aggregate?: unknown }
				| undefined
			const hasUnsupportedTransform =
				transformObj !== undefined && Object.keys(transformObj).some((k) => k !== "reduceToValue")

			const queryEngine = yield* QueryEngineService
			const queryResults: InspectChartQueryResult[] = []

			for (const rawDraft of enabledRawDrafts) {
				const draft = normalizeDraft(rawDraft)
				const buildResult = isTimeseries
					? buildTimeseriesQuerySpec(draft)
					: buildBreakdownQuerySpec(draft)

				if (!buildResult.query) {
					const preFlags: ChartFlag[] = isBreakdown ? ["BROKEN_BREAKDOWN"] : ["EMPTY"]
					queryResults.push({
						queryId: draft.id,
						queryName: draft.name,
						status: "error",
						error: buildResult.error ?? "Failed to build query spec",
						stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
						flags: preFlags,
					})
					continue
				}

				let decodedSpec
				try {
					decodedSpec = decodeQuerySpecSync(buildResult.query)
				} catch (error) {
					queryResults.push({
						queryId: draft.id,
						queryName: draft.name,
						status: "error",
						error: `Invalid query specification: ${String(error)}`,
						stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
						flags: ["EMPTY"],
					})
					continue
				}

				const exit = yield* queryEngine
					.execute(tenant, {
						startTime: resolvedStart,
						endTime: resolvedEnd,
						query: decodedSpec,
					})
					.pipe(Effect.exit)

				if (Exit.isFailure(exit)) {
					const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
					const errorMessage =
						failure && typeof failure === "object" && "message" in failure
							? String((failure as { message: unknown }).message)
							: Cause.pretty(exit.cause)
					queryResults.push({
						queryId: draft.id,
						queryName: draft.name,
						status: "error",
						error: errorMessage,
						stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
						flags: ["EMPTY"],
					})
					continue
				}

				const result = exit.value.result
				let stats: QueryStats = { rowCount: 0, seriesCount: 0, seriesStats: [] }
				if (result.kind === "timeseries") {
					stats = computeTimeseriesStats(result.data)
				} else if (result.kind === "breakdown") {
					stats = computeBreakdownStats(result.data)
				}

				let reducedValue: number | null | undefined
				if (reduceToValue && typeof reduceToValue.field === "string") {
					const reduced = applyReduceToValue(
						result,
						reduceToValue.field,
						typeof reduceToValue.aggregate === "string" ? reduceToValue.aggregate : "avg",
					)
					reducedValue = reduced.value
				}

				const flags = computeFlags(stats, {
					metric: draft.aggregation,
					source: draft.dataSource,
					kind: isTimeseries ? "timeseries" : "breakdown",
					...(widget.display.unit !== undefined && { displayUnit: widget.display.unit }),
				})

				queryResults.push({
					queryId: draft.id,
					queryName: draft.name,
					status: "ok",
					spec: buildResult.query,
					stats: statsToData(stats),
					...(reducedValue !== undefined && { reducedValue }),
					flags,
				})
			}

			const allFlags = queryResults.flatMap((r) => r.flags)
			const verdict = verdictFromFlags(allFlags)

			const notes: string[] = []
			if (hasFormulaWarning) {
				notes.push(
					"WARNING: this widget uses formula expressions in `formulas[]` which are NOT evaluated by inspect_chart_data. Only the base queries are shown. Verify base data is sane, but the rendered chart may still differ.",
				)
			}
			if (hasUnsupportedTransform) {
				notes.push(
					"Widget transform contains operations beyond `reduceToValue` (e.g. fieldMap, flattenSeries, computeRatio); these are not applied during inspection.",
				)
			}
			if (timeRangeSource === "fallback") {
				notes.push("Could not parse the dashboard's timeRange; falling back to last 6 hours.")
			}
			notes.push(
				"Inspection only checks the requested time window; the dashboard UI may auto-extend to a wider window if data is sparse.",
			)

			const data: InspectChartDataData = {
				widget: {
					id: widget.id,
					...(widget.display.title !== undefined && { title: widget.display.title }),
					visualization: widget.visualization,
					endpoint,
					...(widget.display.unit !== undefined && { displayUnit: widget.display.unit }),
					hasFormulaWarning,
					hasUnsupportedTransform,
				},
				timeRange: {
					startTime: resolvedStart,
					endTime: resolvedEnd,
					source: timeRangeSource,
				},
				queries: queryResults,
				verdict,
				flags: allFlags,
				notes,
			}

			const lines: string[] = []
			lines.push(`## Widget inspection: ${widget.display.title ?? widget.id}`)
			lines.push(`Dashboard: ${dashboard.name}`)
			lines.push(`Visualization: ${widget.visualization} | Endpoint: ${endpoint}`)
			if (widget.display.unit) lines.push(`Display unit: ${widget.display.unit}`)
			lines.push(`Time range: ${resolvedStart} → ${resolvedEnd} (source: ${timeRangeSource})`)
			lines.push(``)
			lines.push(`### Verdict: ${verdict.toUpperCase()}`)
			if (allFlags.length > 0) {
				lines.push(`Flags: ${allFlags.join(", ")}`)
			} else {
				lines.push(`No issues detected.`)
			}
			lines.push(``)
			for (const query of queryResults) {
				lines.push(formatQueryBlock(query))
				lines.push(``)
			}
			if (notes.length > 0) {
				lines.push(`### Notes`)
				for (const note of notes) lines.push(`- ${note}`)
			}
			if (verdict !== "looks_healthy") {
				lines.push(``)
				lines.push(
					`### Next step\nVerdict is '${verdict}'. Refine the widget via update_dashboard and re-run inspect_chart_data to verify.`,
				)
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "inspect_chart_data",
					data,
				}),
			}
		}),
	)
}
