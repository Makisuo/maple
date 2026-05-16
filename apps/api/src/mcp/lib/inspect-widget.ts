import { Cause, Effect, Exit, Option, Schema } from "effect"
import { QueryEngineService } from "@/services/QueryEngineService"
import {
	QuerySpec,
	type QueryEngineResult,
	type BreakdownItem,
	type TimeseriesPoint,
} from "@maple/query-engine"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import {
	computeBreakdownStats,
	computeFlags,
	computeTimeseriesStats,
	verdictFromFlags,
	type ChartFlag,
	type QueryStats,
} from "./chart-statistics"
import { resolveDashboardTimeRange, type DashboardTimeRangeInput } from "./resolve-dashboard-time-range"
import { resolveTimeRange } from "./time"
import type { DashboardDocument, DashboardWidgetSchema } from "@maple/domain/http"
import type {
	InspectChartDataData,
	InspectChartQueryResult,
	InspectChartQueryStats,
	InspectChartSeriesStat,
	WidgetInspectionEntry,
	WidgetInspectionSummary,
	WidgetInspectionVerdict,
} from "@maple/domain"
import type { TenantContext } from "@/lib/tenant-context"

const TIMESERIES_ENDPOINT = "custom_query_builder_timeseries"
const BREAKDOWN_ENDPOINT = "custom_query_builder_breakdown"
const MAX_QUERIES = 5

export type DashboardWidget = typeof DashboardWidgetSchema.Type

const QueryBuilderParamsSchema = Schema.Struct({
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	formulas: Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown))),
})

const decodeQueryBuilderParamsSync = Schema.decodeUnknownSync(QueryBuilderParamsSchema)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

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

export interface InspectWidgetTimeRange {
	startTime: string
	endTime: string
	source: "override" | "dashboard" | "fallback"
}

export type InspectionOutcome =
	| { kind: "supported"; data: InspectChartDataData }
	| { kind: "unsupported"; endpoint: string }
	| {
			kind: "skipped"
			reason: "no_params" | "no_enabled_queries" | "too_many_queries" | "decode_failed"
			detail: string
	  }
	| { kind: "inspection_error"; message: string }

export interface InspectWidgetInput {
	tenant: TenantContext
	dashboardName: string
	widget: DashboardWidget
	timeRange: InspectWidgetTimeRange
}

/**
 * Run the validation pipeline for a single widget. Never fails the caller —
 * problems are encoded in the returned `InspectionOutcome` so post-mutation
 * callers can always finish their response.
 */
export const inspectWidget = (input: InspectWidgetInput) => {
	const program = Effect.gen(function* () {
		const { tenant, widget, timeRange } = input

		const endpoint = widget.dataSource.endpoint
		const isTimeseries = endpoint === TIMESERIES_ENDPOINT
		const isBreakdown = endpoint === BREAKDOWN_ENDPOINT

		if (!isTimeseries && !isBreakdown) {
			return { kind: "unsupported", endpoint } satisfies InspectionOutcome
		}

		const rawParams = widget.dataSource.params
		if (!rawParams || typeof rawParams !== "object") {
			return {
				kind: "skipped",
				reason: "no_params",
				detail: "Widget has no dataSource.params; cannot inspect.",
			} satisfies InspectionOutcome
		}

		let decodedParams: Schema.Schema.Type<typeof QueryBuilderParamsSchema>
		try {
			decodedParams = decodeQueryBuilderParamsSync(rawParams)
		} catch (error) {
			return {
				kind: "skipped",
				reason: "decode_failed",
				detail: `Failed to decode widget params: ${String(error)}. The widget's queries[] does not match the query-builder shape.`,
			} satisfies InspectionOutcome
		}

		const enabledRawDrafts = decodedParams.queries.filter((q) => q.enabled !== false)
		if (enabledRawDrafts.length === 0) {
			return {
				kind: "skipped",
				reason: "no_enabled_queries",
				detail: "Widget has no enabled queries to inspect.",
			} satisfies InspectionOutcome
		}
		if (enabledRawDrafts.length > MAX_QUERIES) {
			return {
				kind: "skipped",
				reason: "too_many_queries",
				detail: `Widget has ${enabledRawDrafts.length} enabled queries; inspect_chart_data caps at ${MAX_QUERIES}.`,
			} satisfies InspectionOutcome
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

		for (const draft of enabledRawDrafts) {
			const buildResult = isTimeseries
				? buildTimeseriesQuerySpec(draft)
				: buildBreakdownQuerySpec(draft)

			const builderWarnings =
				buildResult.warnings && buildResult.warnings.length > 0
					? [...buildResult.warnings]
					: undefined
			const builderWarningFlags: ChartFlag[] = builderWarnings ? ["BUILDER_WARNINGS"] : []

			if (!buildResult.query) {
				const preFlags: ChartFlag[] = isBreakdown ? ["BROKEN_BREAKDOWN"] : ["EMPTY"]
				queryResults.push({
					queryId: draft.id,
					queryName: draft.name,
					status: "error",
					error: buildResult.error ?? "Failed to build query spec",
					stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
					flags: [...preFlags, ...builderWarningFlags],
					...(builderWarnings && { builderWarnings }),
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
					flags: ["EMPTY", ...builderWarningFlags],
					...(builderWarnings && { builderWarnings }),
				})
				continue
			}

			const exit = yield* queryEngine
				.execute(tenant, {
					startTime: timeRange.startTime,
					endTime: timeRange.endTime,
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
					flags: ["EMPTY", ...builderWarningFlags],
					...(builderWarnings && { builderWarnings }),
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
				...(builderWarningFlags.length > 0 && { preFlags: builderWarningFlags }),
			})

			queryResults.push({
				queryId: draft.id,
				queryName: draft.name,
				status: "ok",
				spec: buildResult.query,
				stats: statsToData(stats),
				...(reducedValue !== undefined && { reducedValue }),
				flags,
				...(builderWarnings && { builderWarnings }),
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
		if (timeRange.source === "fallback") {
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
				startTime: timeRange.startTime,
				endTime: timeRange.endTime,
				source: timeRange.source,
			},
			queries: queryResults,
			verdict,
			flags: allFlags,
			notes,
		}

		return { kind: "supported", data } satisfies InspectionOutcome
	})

	return program.pipe(
		Effect.catchCause((cause) =>
			Effect.succeed<InspectionOutcome>({
				kind: "inspection_error",
				message: Cause.pretty(cause),
			}),
		),
	)
}

function summarizeOutcome(widget: DashboardWidget, outcome: InspectionOutcome): WidgetInspectionEntry {
	if (outcome.kind === "supported") {
		return {
			widgetId: widget.id,
			...(widget.display.title !== undefined && { title: widget.display.title }),
			visualization: widget.visualization,
			verdict: outcome.data.verdict satisfies WidgetInspectionVerdict,
			flags: [...outcome.data.flags],
		}
	}
	if (outcome.kind === "unsupported") {
		return {
			widgetId: widget.id,
			...(widget.display.title !== undefined && { title: widget.display.title }),
			visualization: widget.visualization,
			verdict: "unsupported",
			flags: [],
			note: `Predefined endpoint (${outcome.endpoint}); inspect with query_data if needed.`,
		}
	}
	if (outcome.kind === "skipped") {
		return {
			widgetId: widget.id,
			...(widget.display.title !== undefined && { title: widget.display.title }),
			visualization: widget.visualization,
			verdict: "skipped",
			flags: [],
			note: outcome.detail,
		}
	}
	return {
		widgetId: widget.id,
		...(widget.display.title !== undefined && { title: widget.display.title }),
		visualization: widget.visualization,
		verdict: "error",
		flags: [],
		note: `Inspection failed: ${outcome.message}`,
	}
}

export interface InspectWidgetsAfterMutationInput {
	tenant: TenantContext
	dashboard: DashboardDocument
	widgetIds: ReadonlyArray<string>
	validate: boolean
	maxWidgets?: number
	maxConcurrent?: number
}

const DEFAULT_MAX_WIDGETS = 12
const DEFAULT_MAX_CONCURRENT = 4

const SKIPPED_SUMMARY: WidgetInspectionSummary = {
	ran: false,
	inspected: [],
	healthyCount: 0,
	suspiciousCount: 0,
	brokenCount: 0,
	skippedCount: 0,
	capped: false,
}

/**
 * Inspect the specified widgets after a dashboard mutation has persisted.
 * Resolves the dashboard time range once, then runs `inspectWidget` per
 * widget with bounded concurrency. Returns a compact `WidgetInspectionSummary`
 * suitable for inclusion in tool responses.
 */
export const inspectWidgetsAfterMutation = (input: InspectWidgetsAfterMutationInput) => {
	const program = Effect.gen(function* () {
		const {
			tenant,
			dashboard,
			widgetIds,
			validate,
			maxWidgets = DEFAULT_MAX_WIDGETS,
			maxConcurrent = DEFAULT_MAX_CONCURRENT,
		} = input

		if (!validate) {
			return SKIPPED_SUMMARY
		}

		const widgetById = new Map<string, DashboardWidget>()
		for (const w of dashboard.widgets) widgetById.set(w.id, w)

		const targets: DashboardWidget[] = []
		for (const id of widgetIds) {
			const w = widgetById.get(id)
			if (w) targets.push(w)
		}

		const capped = targets.length > maxWidgets
		const toInspect = capped ? targets.slice(0, maxWidgets) : targets

		const resolved = resolveDashboardTimeRange(dashboard.timeRange as DashboardTimeRangeInput)
		const timeRange: InspectWidgetTimeRange = resolved
			? { startTime: resolved.startTime, endTime: resolved.endTime, source: "dashboard" }
			: (() => {
					const fallback = resolveTimeRange(undefined, undefined, 6)
					return { startTime: fallback.st, endTime: fallback.et, source: "fallback" as const }
				})()

		const outcomes = yield* Effect.all(
			toInspect.map((widget) =>
				inspectWidget({
					tenant,
					dashboardName: dashboard.name,
					widget,
					timeRange,
				}),
			),
			{ concurrency: maxConcurrent },
		)

		const inspected: WidgetInspectionEntry[] = toInspect.map((widget, i) =>
			summarizeOutcome(widget, outcomes[i]),
		)

		let healthyCount = 0
		let suspiciousCount = 0
		let brokenCount = 0
		let skippedCount = 0
		for (const entry of inspected) {
			switch (entry.verdict) {
				case "looks_healthy":
					healthyCount++
					break
				case "suspicious":
					suspiciousCount++
					break
				case "broken":
					brokenCount++
					break
				default:
					skippedCount++
			}
		}

		const summary: WidgetInspectionSummary = {
			ran: true,
			inspected,
			healthyCount,
			suspiciousCount,
			brokenCount,
			skippedCount,
			capped,
			timeRange,
		}
		return summary
	})

	return program.pipe(Effect.catchCause(() => Effect.succeed(SKIPPED_SUMMARY)))
}

/**
 * Format a `WidgetInspectionSummary` into a markdown block for inclusion in
 * tool responses. For single-widget mutations (add/update), collapses to a
 * compact one-liner plus flags when not `looks_healthy`.
 */
export function formatValidationSummary(summary: WidgetInspectionSummary, isSingleWidget: boolean): string {
	if (!summary.ran) return ""

	if (isSingleWidget && summary.inspected.length === 1) {
		const entry = summary.inspected[0]
		const flagPart = entry.flags.length > 0 ? `  (${entry.flags.join(", ")})` : ""
		const notePart = entry.note ? `\n${entry.note}` : ""
		const lines = [
			`### Validation: ${entry.verdict.toUpperCase()}`,
			`${verdictIcon(entry.verdict)} "${entry.title ?? entry.widgetId}" — ${entry.verdict}${flagPart}${notePart}`,
		]
		if (entry.verdict === "suspicious" || entry.verdict === "broken") {
			lines.push(
				"Fix the widget via update_dashboard_widget and re-run — the chart will not render meaningfully as-is.",
			)
		}
		return lines.join("\n")
	}

	const header = `### Validation: ${summary.healthyCount} healthy, ${summary.suspiciousCount} suspicious, ${summary.brokenCount} broken (${summary.skippedCount} skipped)`
	const lines: string[] = [header]
	if (summary.timeRange) {
		lines.push(
			`Time range: ${summary.timeRange.startTime} → ${summary.timeRange.endTime} (source: ${summary.timeRange.source})`,
		)
	}
	for (const entry of summary.inspected) {
		const flagPart = entry.flags.length > 0 ? `  (${entry.flags.join(", ")})` : ""
		const notePart = entry.note ? ` — ${entry.note}` : ""
		lines.push(
			`- ${verdictIcon(entry.verdict)} ${entry.widgetId} "${entry.title ?? ""}" — ${entry.verdict}${flagPart}${notePart}`,
		)
	}
	if (summary.capped) {
		lines.push(
			`Note: widget list capped at ${summary.inspected.length}; inspect remaining widgets manually with inspect_chart_data.`,
		)
	}
	if (summary.brokenCount > 0 || summary.suspiciousCount > 0) {
		lines.push(
			`Fix suspicious/broken widgets via update_dashboard_widget. Skipped widgets use predefined endpoints; verify with query_data if needed.`,
		)
	}
	return lines.join("\n")
}

function verdictIcon(verdict: WidgetInspectionVerdict): string {
	switch (verdict) {
		case "looks_healthy":
			return "ok"
		case "suspicious":
			return "warn"
		case "broken":
			return "broken"
		case "unsupported":
			return "skip"
		case "skipped":
			return "skip"
		case "error":
			return "err"
	}
}
