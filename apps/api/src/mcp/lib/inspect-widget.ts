import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import { QueryEngineService } from "@/services/QueryEngineService"
import { WarehouseQueryService } from "@/lib/WarehouseQueryService"
import {
	QuerySpec,
	type QueryEngineResult,
	type BreakdownItem,
	type TimeseriesPoint,
} from "@maple/query-engine"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import {
	buildFormulaResults,
	type FormulaDraft,
	type QueryRunResult,
} from "@maple/query-engine/formula-results"
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
import { autoBucketSeconds, runRawSql } from "./run-raw-sql"
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
const RAW_SQL_ENDPOINT = "raw_sql_chart"
const MAX_QUERIES = 5
// Rows captured for a raw-SQL widget inspection — enough to spot-check, capped
// so a wide/long result doesn't bloat the response.
const RAW_SQL_INSPECT_ROWS = 50

export type DashboardWidget = typeof DashboardWidgetSchema.Type

const QueryBuilderParamsSchema = Schema.Struct({
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	formulas: Schema.optional(Schema.mutable(Schema.Array(Schema.Unknown))),
})

const decodeQueryBuilderParams = Schema.decodeUnknownEffect(QueryBuilderParamsSchema)
const decodeQuerySpec = Schema.decodeUnknownEffect(QuerySpec)

/**
 * Pre-persist guard for the widget mutation tools. Decodes a query-builder
 * widget's params and runs the PURE spec builder (no SQL executed) to surface
 * clauses the engine cannot honor — the >5 attr-filter cap, unsupported
 * logs/metrics filter keys, malformed/unsupported group-bys, invalid
 * boolean/metric-type values, unparseable where-clause syntax, etc. These all
 * mean "you wrote X and we silently ignored it", which changes what the chart
 * shows — the #1 confidently-wrong-dashboard footgun. Mutation tools reject the
 * write and echo these back so the caller can fix the query.
 *
 * Benign fallbacks that don't change scoping (e.g. an invalid step interval
 * falling back to auto) are intentionally excluded. Returns `[]` for
 * non-query-builder widgets (raw SQL / unsupported endpoints) and for params
 * that don't decode — those carry their own validation elsewhere.
 */
export const collectBlockingBuilderWarnings = Effect.fn("collectBlockingBuilderWarnings")(function* (
	dataSource: DashboardWidget["dataSource"],
) {
	const endpoint = dataSource.endpoint
	const isTimeseries = endpoint === TIMESERIES_ENDPOINT
	const isBreakdown = endpoint === BREAKDOWN_ENDPOINT
	if (!isTimeseries && !isBreakdown) return [] as string[]

	const rawParams = dataSource.params
	if (!rawParams || typeof rawParams !== "object") return [] as string[]

	const decoded = yield* Effect.result(decodeQueryBuilderParams(rawParams))
	if (Result.isFailure(decoded)) return [] as string[]

	const drafts = decoded.success.queries.filter((q) => q.enabled !== false)
	const warnings: string[] = []
	for (const draft of drafts) {
		const buildResult = isTimeseries ? buildTimeseriesQuerySpec(draft) : buildBreakdownQuerySpec(draft)
		for (const w of buildResult.warnings ?? []) {
			// Non-scoping fallback — auto bucket size is a fine default.
			if (w.toLowerCase().includes("step interval")) continue
			warnings.push(w)
		}
	}
	return warnings
})

// The first numeric series/value present in a result. Mirrors the client
// renderer's `resolveField` fallback so the inspector reduces the same field the
// stat tile actually shows.
function firstNumericField(result: QueryEngineResult): string | null {
	if (result.kind === "timeseries") {
		for (const point of result.data as ReadonlyArray<TimeseriesPoint>) {
			for (const [name, v] of Object.entries(point.series)) {
				if (typeof v === "number" && !Number.isNaN(v)) return name
			}
		}
		return null
	}
	if (result.kind === "breakdown") {
		return (result.data as ReadonlyArray<BreakdownItem>).length > 0 ? "value" : null
	}
	return null
}

function collectReduceValues(result: QueryEngineResult, field: string): number[] {
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
	}
	return values
}

function applyReduceToValue(
	result: QueryEngineResult,
	field: string,
	aggregate: string,
): { value: number | null; reason?: string } {
	if (result.kind !== "timeseries" && result.kind !== "breakdown") {
		return { value: null, reason: `cannot reduce ${result.kind} result` }
	}

	let values = collectReduceValues(result, field)

	// The configured field may not match a column name (the renderer auto-picks
	// the first numeric column for stat tiles). Fall back to that same field so
	// the inspector's reducedValue matches what renders — previously this
	// returned a false `null` for every such stat widget.
	if (values.length === 0) {
		const fallback = firstNumericField(result)
		if (fallback && fallback !== field) {
			values = collectReduceValues(result, fallback)
		}
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

// A real grouping was requested when the draft enables groupBy and lists at
// least one token that isn't the ungrouped sentinel (`none`/`all`). Used to
// distinguish an intentional ungrouped chart from a grouping that collapsed.
function isGroupByRequested(draft: { addOns?: { groupBy?: boolean }; groupBy?: readonly string[] }): boolean {
	if (!draft.addOns?.groupBy) return false
	return (draft.groupBy ?? []).some((g) => {
		const t = g.trim().toLowerCase()
		return t.length > 0 && t !== "none" && t !== "all"
	})
}

// The query-builder coalesces an empty group key to the literal "all", so a
// groupBy on an attribute/column with zero distinct values silently becomes the
// ungrouped total — one series named "all" — with no signal. Detect that.
function isSingleAllGroup(result: QueryEngineResult): boolean {
	if (result.kind === "timeseries") {
		const names = new Set<string>()
		for (const point of result.data as ReadonlyArray<TimeseriesPoint>) {
			for (const name of Object.keys(point.series)) names.add(name)
		}
		return names.size === 1 && names.has("all")
	}
	if (result.kind === "breakdown") {
		const rows = result.data as ReadonlyArray<BreakdownItem>
		return rows.length === 1 && rows[0]?.name === "all"
	}
	return false
}

// Distinguishes "metric isn't in the warehouse at all" from "metric exists but
// has no data in this window" — both otherwise surface as EMPTY/ALL_NULLS. On
// any lookup error we assume the metric exists, so we never raise a false
// METRIC_NOT_FOUND.
const metricExistsInCatalog = Effect.fn("metricExistsInCatalog")(function* (
	tenant: TenantContext,
	metricName: string,
	metricType: string | undefined,
	startTime: string,
	endTime: string,
) {
	const warehouse = yield* WarehouseQueryService
	return yield* warehouse
		.query(tenant, {
			pipeName: "list_metrics",
			params: {
				start_time: startTime,
				end_time: endTime,
				search: metricName,
				...(metricType ? { metric_type: metricType } : {}),
				limit: 200,
				offset: 0,
			},
		})
		.pipe(
			Effect.map((resp) =>
				(resp.data as ReadonlyArray<{ metricName?: string }>).some(
					(m) => m.metricName === metricName,
				),
			),
			Effect.orElseSucceed(() => true),
		)
})

export interface InspectWidgetTimeRange {
	startTime: string
	endTime: string
	source: "override" | "dashboard" | "fallback"
}

/** Result of executing a raw_sql_chart widget's stored SQL during inspection. */
export interface RawSqlInspectionData {
	endpoint: string
	sql: string
	/** Macro-expanded SQL actually executed; absent when expansion/validation failed. */
	expandedSql?: string
	status: "ok" | "error"
	/** Validation/execution error message when status is "error". */
	error?: string
	rowCount: number
	columns: ReadonlyArray<string>
	rows: ReadonlyArray<Record<string, unknown>>
	truncated: boolean
	timeRange: InspectWidgetTimeRange
}

export type InspectionOutcome =
	| { kind: "supported"; data: InspectChartDataData }
	| { kind: "raw_sql"; data: RawSqlInspectionData }
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
 * Inspect a raw_sql_chart widget by running its stored SQL through the exact
 * same macro-expansion + safety pass + warehouse execution as the dashboard UI,
 * returning a rows preview. Never fails the caller — validation/execution
 * errors are encoded as `status: "error"` in the returned data.
 */
const inspectRawSqlWidget = Effect.fn("inspectRawSqlWidget")(function* (
	tenant: TenantContext,
	widget: DashboardWidget,
	timeRange: InspectWidgetTimeRange,
) {
	const rawParams = widget.dataSource.params as Record<string, unknown> | undefined
	const sql = typeof rawParams?.sql === "string" ? rawParams.sql : undefined

	if (!sql) {
		return {
			kind: "skipped",
			reason: "no_params",
			detail: "raw_sql_chart widget has no `params.sql` to inspect.",
		} satisfies InspectionOutcome
	}

	const granularitySeconds =
		typeof rawParams?.granularitySeconds === "number"
			? rawParams.granularitySeconds
			: autoBucketSeconds(timeRange.startTime, timeRange.endTime)

	const result = yield* runRawSql({
		tenant,
		sql,
		startTime: timeRange.startTime,
		endTime: timeRange.endTime,
		granularitySeconds,
	}).pipe(
		Effect.map((value) => ({ ok: true as const, value })),
		Effect.catchTag("@maple/http/errors/RawSqlValidationError", (error) =>
			Effect.succeed({ ok: false as const, error: `${error.code}: ${error.message}` }),
		),
		Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
	)

	if (!result.ok) {
		return {
			kind: "raw_sql",
			data: {
				endpoint: RAW_SQL_ENDPOINT,
				sql,
				status: "error",
				error: result.error,
				rowCount: 0,
				columns: [],
				rows: [],
				truncated: false,
				timeRange,
			},
		} satisfies InspectionOutcome
	}

	const rendered = result.value.rows.slice(0, RAW_SQL_INSPECT_ROWS)
	return {
		kind: "raw_sql",
		data: {
			endpoint: RAW_SQL_ENDPOINT,
			sql,
			expandedSql: result.value.expandedSql,
			status: "ok",
			rowCount: result.value.rowCount,
			columns: result.value.columns,
			rows: rendered,
			truncated: result.value.rowCount > rendered.length,
			timeRange,
		},
	} satisfies InspectionOutcome
})

/**
 * Run the validation pipeline for a single widget. Never fails the caller —
 * problems are encoded in the returned `InspectionOutcome` so post-mutation
 * callers can always finish their response.
 */
export const inspectWidget = Effect.fn("inspectWidget")(
	function* (input: InspectWidgetInput) {
		const { tenant, widget, timeRange } = input

		const endpoint = widget.dataSource.endpoint
		const isTimeseries = endpoint === TIMESERIES_ENDPOINT
		const isBreakdown = endpoint === BREAKDOWN_ENDPOINT

		if (endpoint === RAW_SQL_ENDPOINT) {
			return yield* inspectRawSqlWidget(tenant, widget, timeRange)
		}

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

		const decodedParamsResult = yield* Effect.result(decodeQueryBuilderParams(rawParams))
		if (Result.isFailure(decodedParamsResult)) {
			return {
				kind: "skipped",
				reason: "decode_failed",
				detail: `Failed to decode widget params: ${decodedParamsResult.failure.message}. The widget's queries[] does not match the query-builder shape.`,
			} satisfies InspectionOutcome
		}
		const decodedParams = decodedParamsResult.success

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

		// Base timeseries data captured for formula evaluation. `concurrency: 1`
		// below makes the push order deterministic with no race.
		const formulaBaseInputs: QueryRunResult[] = []

		const queryResults: InspectChartQueryResult[] = yield* Effect.forEach(
			enabledRawDrafts,
			(draft) =>
				Effect.gen(function* () {
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
						return {
							queryId: draft.id,
							queryName: draft.name,
							status: "error",
							error: buildResult.error ?? "Failed to build query spec",
							stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
							flags: [...preFlags, ...builderWarningFlags],
							...(builderWarnings && { builderWarnings }),
						} satisfies InspectChartQueryResult
					}

					const decodedSpecResult = yield* Effect.result(decodeQuerySpec(buildResult.query))
					if (Result.isFailure(decodedSpecResult)) {
						return {
							queryId: draft.id,
							queryName: draft.name,
							status: "error",
							error: `Invalid query specification: ${decodedSpecResult.failure.message}`,
							stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
							flags: ["EMPTY", ...builderWarningFlags],
							...(builderWarnings && { builderWarnings }),
						} satisfies InspectChartQueryResult
					}
					const decodedSpec = decodedSpecResult.success

					const exit = yield* queryEngine
						.execute(tenant, {
							startTime: timeRange.startTime,
							endTime: timeRange.endTime,
							query: decodedSpec,
						})
						.pipe(Effect.exit)

					if (Exit.isFailure(exit)) {
						// `execute` fails with a `QueryEngineRouteError` union — every member
						// carries a `message`. A defect (no typed failure) falls back to the
						// pretty-printed cause.
						const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
						const errorMessage = failure ? failure.message : Cause.pretty(exit.cause)
						return {
							queryId: draft.id,
							queryName: draft.name,
							status: "error",
							error: errorMessage,
							stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
							flags: ["EMPTY", ...builderWarningFlags],
							...(builderWarnings && { builderWarnings }),
						} satisfies InspectChartQueryResult
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

					// A requested grouping that produced one "all" series found zero
					// distinct group values — flag it instead of passing off the
					// ungrouped total as a breakdown.
					const emptyGroupingFlags: ChartFlag[] =
						stats.rowCount > 0 && isGroupByRequested(draft) && isSingleAllGroup(result)
							? ["EMPTY_GROUPING"]
							: []
					const preFlags = [...builderWarningFlags, ...emptyGroupingFlags]

					const baseFlags = computeFlags(stats, {
						metric: draft.aggregation,
						source: draft.dataSource,
						kind: isTimeseries ? "timeseries" : "breakdown",
						...(widget.display.unit !== undefined && { displayUnit: widget.display.unit }),
						...(preFlags.length > 0 && { preFlags }),
					})

					// An empty/all-null metrics query might be a typo'd metric name
					// rather than a real metric with no recent data — check the catalog
					// so the verdict says which it is.
					let flags = baseFlags
					if (
						draft.dataSource === "metrics" &&
						(baseFlags.includes("EMPTY") || baseFlags.includes("ALL_NULLS"))
					) {
						const metricName = (draft as { metricName?: string }).metricName
						if (metricName) {
							const exists = yield* metricExistsInCatalog(
								tenant,
								metricName,
								(draft as { metricType?: string }).metricType,
								timeRange.startTime,
								timeRange.endTime,
							)
							if (!exists) {
								flags = [
									...baseFlags.filter((f) => f !== "EMPTY" && f !== "ALL_NULLS"),
									"METRIC_NOT_FOUND",
								]
							}
						}
					}

					if (result.kind === "timeseries") {
						formulaBaseInputs.push({
							queryId: draft.id,
							queryName: draft.name,
							source: draft.dataSource,
							status: "success",
							error: null,
							warnings: [],
							data: (result.data as ReadonlyArray<TimeseriesPoint>).map((p) => ({
								bucket: p.bucket,
								series: { ...p.series },
							})),
						})
					}

					return {
						queryId: draft.id,
						queryName: draft.name,
						status: "ok",
						spec: buildResult.query,
						stats: statsToData(stats),
						...(reducedValue !== undefined && { reducedValue }),
						flags,
						...(builderWarnings && { builderWarnings }),
					} satisfies InspectChartQueryResult
				}),
			{ concurrency: 1 },
		)

		// Evaluate `formulas[]` with the SAME engine the renderer uses so the
		// verdict reflects what the chart actually shows. Formulas combine the
		// base timeseries by alias, so only the timeseries endpoint supports them.
		const formulaEvaluated = hasFormulaWarning && isTimeseries
		if (formulaEvaluated) {
			const formulaDrafts: FormulaDraft[] = formulas.map((f, i) => {
				const obj = (f ?? {}) as Record<string, unknown>
				return {
					id: typeof obj.id === "string" ? obj.id : `formula-${i}`,
					name: typeof obj.name === "string" ? obj.name : `Formula ${i + 1}`,
					expression: typeof obj.expression === "string" ? obj.expression : "",
					legend: typeof obj.legend === "string" ? obj.legend : "",
				}
			})

			for (const fr of buildFormulaResults(formulaDrafts, formulaBaseInputs)) {
				if (fr.status === "error") {
					queryResults.push({
						queryId: fr.queryId,
						queryName: fr.queryName,
						status: "error",
						error: fr.error ?? "Formula evaluation failed",
						stats: { rowCount: 0, seriesCount: 0, seriesStats: [] },
						flags: ["EMPTY"],
					})
					continue
				}

				const fstats = computeTimeseriesStats(fr.data)
				let fReduced: number | null | undefined
				if (reduceToValue && typeof reduceToValue.field === "string") {
					const reduced = applyReduceToValue(
						{ kind: "timeseries", source: "traces", data: fr.data },
						reduceToValue.field,
						typeof reduceToValue.aggregate === "string" ? reduceToValue.aggregate : "avg",
					)
					fReduced = reduced.value
				}
				const fFlags = computeFlags(fstats, {
					kind: "timeseries",
					...(widget.display.unit !== undefined && { displayUnit: widget.display.unit }),
				})

				queryResults.push({
					queryId: fr.queryId,
					queryName: fr.queryName,
					status: "ok",
					stats: statsToData(fstats),
					...(fReduced !== undefined && { reducedValue: fReduced }),
					flags: fFlags,
					...(fr.warnings.length > 0 && { builderWarnings: fr.warnings }),
				})
			}
		}

		const allFlags = queryResults.flatMap((r) => r.flags)
		const verdict = verdictFromFlags(allFlags)

		const notes: string[] = []
		if (hasFormulaWarning && !formulaEvaluated) {
			// Only true for non-timeseries widgets, where formulas don't apply.
			notes.push(
				"This widget defines `formulas[]`, but formulas are only evaluated for timeseries widgets; the base queries above are shown as-is.",
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
				// True only when formulas are present but NOT evaluated (non-timeseries
				// widgets). Timeseries formulas are now evaluated and appear as their
				// own entries in `queries`, so there's no warning to raise.
				hasFormulaWarning: hasFormulaWarning && !formulaEvaluated,
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
	},
	Effect.catchCause((cause) =>
		Effect.succeed<InspectionOutcome>({
			kind: "inspection_error",
			message: Cause.pretty(cause),
		}),
	),
)

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
	if (outcome.kind === "raw_sql") {
		const verdict: WidgetInspectionVerdict =
			outcome.data.status === "error" ? "broken" : outcome.data.rowCount === 0 ? "suspicious" : "looks_healthy"
		const note =
			outcome.data.status === "error"
				? `Raw SQL failed: ${outcome.data.error ?? "unknown error"}`
				: outcome.data.rowCount === 0
					? "Raw SQL returned no rows for this window."
					: `Raw SQL returned ${outcome.data.rowCount} row(s).`
		return {
			widgetId: widget.id,
			...(widget.display.title !== undefined && { title: widget.display.title }),
			visualization: widget.visualization,
			verdict,
			flags: [],
			note,
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
export const inspectWidgetsAfterMutation = Effect.fn("inspectWidgetsAfterMutation")(
	function* (input: InspectWidgetsAfterMutationInput) {
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

		const outcomes = yield* Effect.forEach(
			toInspect,
			(widget) =>
				inspectWidget({
					tenant,
					dashboardName: dashboard.name,
					widget,
					timeRange,
				}),
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
	},
	Effect.catchCause(() => Effect.succeed(SKIPPED_SUMMARY)),
)

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
