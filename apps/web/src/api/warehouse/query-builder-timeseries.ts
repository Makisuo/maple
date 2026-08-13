import { Effect, Result, Schema } from "effect"
import {
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	QueryEngineExecuteRequest,
	type QuerySpec,
} from "@maple/query-engine"
import { NO_QUERY_DATA_MESSAGE } from "@/lib/alerts/preview-failure"
import {
	buildFormulaResults,
	type FormulaDraft,
	type QueryRunResult,
	type TimeseriesPoint,
} from "@/components/query-builder/formula-results"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import {
	QueryBuilderFormulaSchema,
	type QueryComparisonMode,
	QueryComparisonSchema,
} from "@maple/query-model"
import { buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"
import {
	appendPercentChangeSeries,
	buildExecutionWindows,
	collectHiddenResultIds,
	combineRows,
	countSuccessfulQuerySeries,
	type EmptyRangeFallbackStrategy,
	hasAnySeriesData,
	LAB_EMPTY_RANGE_STRATEGY,
	mergeQueryRunResults,
	resolveExecutionSpecForWindow,
	resolveFallbackStrategy,
	resolveTimeseriesBucketSpec,
	shiftRunResults,
	toDisplayNameById,
} from "@maple/query-engine/query-set"
import {
	decodeInput,
	executeQueryEngine,
	invalidWarehouseInput,
	type BackendError,
	type WarehouseApiError,
} from "@/api/warehouse/effect-utils"
import { displayError } from "@/lib/error-messages"

type ExecuteError = WarehouseApiError | BackendError

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const StrategySchema = Schema.Struct({
	enableEmptyRangeFallback: Schema.optional(Schema.Boolean),
	fallbackWindowSeconds: Schema.optional(
		Schema.mutable(Schema.Array(Schema.Int.check(Schema.isGreaterThan(0)))),
	),
	maxFallbackRangeSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

const QueryBuilderTimeseriesInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	formulas: Schema.optional(Schema.mutable(Schema.Array(QueryBuilderFormulaSchema))),
	comparison: Schema.optional(QueryComparisonSchema),
	strategy: Schema.optional(StrategySchema),
	debug: Schema.optional(Schema.Boolean),
})

export type QueryBuilderTimeseriesInput = Schema.Schema.Type<typeof QueryBuilderTimeseriesInputSchema>

interface QueryExecutionAttempt {
	startTime: string
	endTime: string
	kind: "primary" | "fallback"
	points: number
	hasSeries: boolean
	error?: string
}

interface QueryExecutionDebug {
	queryId: string
	queryName: string
	source: string
	spec: QuerySpec | null
	attempts: QueryExecutionAttempt[]
	fallbackUsed: boolean
}

interface QueryBuilderTimeseriesDebug {
	primaryWindow: {
		startTime: string
		endTime: string
	}
	comparison: {
		mode: QueryComparisonMode
		includePercentChange: boolean
		shiftedByMs: number
		previousStartTime: string | null
		previousEndTime: string | null
	}
	strategy: {
		enableEmptyRangeFallback: boolean
		fallbackWindowSeconds: number[]
		maxFallbackRangeSeconds: number
	}
	queries: QueryExecutionDebug[]
	previousQueries: QueryExecutionDebug[]
}

interface QueryBuilderTimeseriesResponse {
	data: Array<Record<string, string | number>>
	debug?: QueryBuilderTimeseriesDebug
}

const toEpochMs = parseWarehouseDateTime

function noQueryDataMessage(queryResults: QueryRunResult[]): string {
	const firstQueryError = queryResults.find(
		(result) => typeof result.error === "string" && result.error.length > 0,
	)?.error

	return firstQueryError ?? NO_QUERY_DATA_MESSAGE
}

/**
 * The wire strategy shape (`enableEmptyRangeFallback` / `fallbackWindowSeconds` /
 * `maxFallbackRangeSeconds`) mapped onto the package's.
 *
 * The wire names stay as they are: `use-widget-data` sends them on every widget
 * fetch, so renaming them would be a behaviour change dressed as a refactor.
 */
function resolveStrategy(input: QueryBuilderTimeseriesInput): EmptyRangeFallbackStrategy {
	return resolveFallbackStrategy(
		{
			...(input.strategy?.enableEmptyRangeFallback === undefined
				? {}
				: { enabled: input.strategy.enableEmptyRangeFallback }),
			...(input.strategy?.fallbackWindowSeconds === undefined
				? {}
				: { windowSeconds: input.strategy.fallbackWindowSeconds }),
			...(input.strategy?.maxFallbackRangeSeconds === undefined
				? {}
				: { maxRangeSeconds: input.strategy.maxFallbackRangeSeconds }),
		},
		LAB_EMPTY_RANGE_STRATEGY,
	)
}

const executeTimeseriesQuery = Effect.fn("QueryEngine.executeTimeseriesQuery")(function* (
	startTime: string,
	endTime: string,
	spec: QuerySpec,
) {
	const request = yield* decodeInput(
		QueryEngineExecuteRequest,
		{ startTime, endTime, query: spec },
		"executeTimeseriesQuery.request",
	)

	const response = yield* executeQueryEngine("queryEngine.timeseriesQuery", request)

	if (response.result.kind !== "timeseries") {
		return yield* invalidWarehouseInput("executeTimeseriesQuery", "Unexpected non-timeseries result")
	}

	return response.result.data.map((point) => ({
		bucket: point.bucket,
		series: { ...point.series },
	})) satisfies TimeseriesPoint[]
})

type ExecuteTimeseriesFn = (
	startTime: string,
	endTime: string,
	spec: QuerySpec,
) => Effect.Effect<TimeseriesPoint[], ExecuteError>

function executeTimeseriesQueryWithFallback(
	startTime: string,
	endTime: string,
	spec: QuerySpec,
	strategy: ReturnType<typeof resolveStrategy>,
	allowFallback: boolean,
) {
	return executeTimeseriesQueryWithFallbackUsing(
		startTime,
		endTime,
		spec,
		strategy,
		allowFallback,
		executeTimeseriesQuery,
	)
}

const executeTimeseriesQueryWithFallbackUsing = Effect.fn("QueryEngine.executeTimeseriesQueryWithFallback")(
	function* (
		startTime: string,
		endTime: string,
		spec: QuerySpec,
		strategy: ReturnType<typeof resolveStrategy>,
		allowFallback: boolean,
		executeFn: ExecuteTimeseriesFn,
	) {
		const windows = buildExecutionWindows(startTime, endTime, strategy, allowFallback)
		const attempts: QueryExecutionAttempt[] = []
		let lastPoints: TimeseriesPoint[] = []

		for (const [index, window] of windows.entries()) {
			const windowSpec = resolveExecutionSpecForWindow(spec, window)

			const outcome = yield* Effect.result(executeFn(window.startTime, window.endTime, windowSpec))

			if (Result.isFailure(outcome)) {
				const error = outcome.failure
				const message = displayError(error).message

				attempts.push({
					startTime: window.startTime,
					endTime: window.endTime,
					kind: window.kind,
					points: 0,
					hasSeries: false,
					error: message,
				})

				if (window.kind === "primary") {
					return yield* Effect.fail(error)
				}
				continue
			}

			const points = outcome.success
			const hasSeries = hasAnySeriesData(points)

			attempts.push({
				startTime: window.startTime,
				endTime: window.endTime,
				kind: window.kind,
				points: points.length,
				hasSeries,
			})
			lastPoints = points

			if (hasSeries) {
				return {
					points,
					attempts,
					fallbackUsed: index > 0,
				}
			}
		}

		return {
			points: lastPoints,
			attempts,
			fallbackUsed: false,
		}
	},
)

const runQueryWindow = Effect.fn("QueryEngine.runQueryWindow")(function* (
	startTime: string,
	endTime: string,
	enabledQueries: QueryBuilderTimeseriesInput["queries"],
	formulas: FormulaDraft[],
	strategy: ReturnType<typeof resolveStrategy>,
	allowFallback: boolean,
) {
	const debug: QueryExecutionDebug[] = []

	const queryResults = yield* Effect.forEach(
		enabledQueries,
		(query) =>
			Effect.gen(function* () {
				const built = buildTimeseriesQuerySpec(query)

				if (!built.query) {
					debug.push({
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						spec: null,
						attempts: [],
						fallbackUsed: false,
					})

					return {
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						status: "error",
						error: built.error ?? "Failed to build query",
						warnings: built.warnings,
						data: [],
					} satisfies QueryRunResult
				}

				const querySpec = resolveTimeseriesBucketSpec(built.query, startTime, endTime)

				const outcome = yield* Effect.result(
					executeTimeseriesQueryWithFallback(
						startTime,
						endTime,
						querySpec,
						strategy,
						allowFallback,
					),
				)

				if (Result.isFailure(outcome)) {
					const error = outcome.failure
					debug.push({
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						spec: querySpec,
						attempts: [],
						fallbackUsed: false,
					})

					return {
						queryId: query.id,
						queryName: query.name,
						source: query.dataSource,
						status: "error",
						error: displayError(error).message,
						warnings: built.warnings,
						data: [],
					} satisfies QueryRunResult
				}

				const execution = outcome.success
				debug.push({
					queryId: query.id,
					queryName: query.name,
					source: query.dataSource,
					spec: querySpec,
					attempts: execution.attempts,
					fallbackUsed: execution.fallbackUsed,
				})

				const warnings = [...built.warnings]
				if (execution.fallbackUsed) {
					const selectedAttempt = execution.attempts[execution.attempts.length - 1]
					warnings.push(
						`No data in requested range; used fallback window ${selectedAttempt.startTime} -> ${selectedAttempt.endTime}`,
					)
				}

				return {
					queryId: query.id,
					queryName: query.name,
					source: query.dataSource,
					status: "success",
					error: null,
					warnings,
					// error_rate arrives from the query engine as a 0–1 ratio — the
					// canonical unit everywhere (the "percent" display unit multiplies
					// by 100 when formatting). No rescaling here.
					data: execution.points,
				} satisfies QueryRunResult
			}),
		{ concurrency: enabledQueries.length },
	)

	const formulaResults =
		countSuccessfulQuerySeries(queryResults) > 0 ? buildFormulaResults(formulas, queryResults) : []
	return {
		queryResults,
		allResults: [...queryResults, ...formulaResults],
		debug,
	}
})

// The pure shaping — bucket sizing, execution windows, the series merge, percent
// change, hidden-id collection — moved to `@maple/query-engine/query-set` and is
// tested there. What remains here is this module's own: the wire strategy
// mapping, the fallback loop that drives the HTTP executor, and the "why is
// there no data" message.
export const __testables = {
	resolveStrategy,
	executeTimeseriesQueryWithFallbackUsing,
	noQueryDataMessage,
}

export function getQueryBuilderTimeseries({ data }: { data: QueryBuilderTimeseriesInput }) {
	return getQueryBuilderTimeseriesEffect({ data })
}

const getQueryBuilderTimeseriesEffect = Effect.fn("QueryEngine.getQueryBuilderTimeseries")(function* ({
	data,
}: {
	data: QueryBuilderTimeseriesInput
}) {
	const input = yield* decodeInput(QueryBuilderTimeseriesInputSchema, data, "getQueryBuilderTimeseries")

	const formulas: FormulaDraft[] = (input.formulas ?? []).map((formula) => ({
		id: formula.id,
		name: formula.name,
		expression: formula.expression,
		legend: formula.legend,
	}))
	const hiddenResultIds = collectHiddenResultIds(input)
	const isPlotted = (result: QueryRunResult): boolean => !hiddenResultIds.has(result.queryId)
	const strategy = resolveStrategy(input)
	const comparison = {
		mode: input.comparison?.mode ?? "none",
		includePercentChange: input.comparison?.includePercentChange ?? true,
	} as const

	const enabledQueries = input.queries.filter((query) => query.enabled !== false)
	if (enabledQueries.length === 0) {
		return yield* invalidWarehouseInput("getQueryBuilderTimeseries", "No enabled queries to run")
	}

	const currentWindow = yield* runQueryWindow(
		input.startTime,
		input.endTime,
		enabledQueries,
		formulas,
		strategy,
		true,
	)
	const successfulQueryCount = countSuccessfulQuerySeries(currentWindow.queryResults)
	if (successfulQueryCount === 0) {
		return yield* invalidWarehouseInput(
			"getQueryBuilderTimeseries",
			noQueryDataMessage(currentWindow.queryResults),
		)
	}

	const allResults = currentWindow.allResults

	const successfulCount = allResults.filter(
		(result) => result.status === "success" && hasAnySeriesData(result.data),
	).length

	if (successfulCount === 0) {
		const firstError = allResults.find((result) => result.error)?.error
		return yield* invalidWarehouseInput(
			"getQueryBuilderTimeseries",
			firstError ?? "No successful query results",
		)
	}

	// Data came back, but nothing plottable did — say why rather than drawing an empty chart the
	// reader would blame on the time range. On a ratio widget the plotted series is the formula,
	// so its own failure (an unknown reference, no overlapping buckets) is the useful message.
	if (!allResults.some((result) => isPlotted(result) && hasAnySeriesData(result.data))) {
		const plottedError = allResults.find((result) => isPlotted(result) && result.error)?.error
		return yield* invalidWarehouseInput(
			"getQueryBuilderTimeseries",
			plottedError ?? "Every query and formula with data is hidden — nothing to plot",
		)
	}

	const displayNameById = toDisplayNameById([
		...enabledQueries,
		...formulas.map((formula) => ({
			id: formula.id,
			name: formula.name,
			legend: formula.legend,
		})),
	])
	const usedSeriesNames = new Set<string>()
	const mergedCurrent = mergeQueryRunResults(allResults.filter(isPlotted), displayNameById, {
		usedSeriesNames,
	})
	const mergedSets = [mergedCurrent]
	let mergedPrevious: {
		rowsByBucket: Map<string, Record<string, string | number>>
		seriesNameByStableKey: Map<string, string>
		seriesNames: string[]
	} | null = null

	const startMs = toEpochMs(input.startTime)
	const endMs = toEpochMs(input.endTime)
	const shiftMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0
	let previousStartTime: string | null = null
	let previousEndTime: string | null = null
	let previousDebug: QueryExecutionDebug[] = []

	if (comparison.mode === "previous_period" && shiftMs > 0) {
		previousStartTime = formatWarehouseDateTime(startMs - shiftMs)
		previousEndTime = formatWarehouseDateTime(endMs - shiftMs)

		const previousWindow = yield* runQueryWindow(
			previousStartTime,
			previousEndTime,
			enabledQueries,
			formulas,
			strategy,
			false,
		)
		previousDebug = previousWindow.debug

		const shiftedPreviousResults = shiftRunResults(previousWindow.allResults.filter(isPlotted), shiftMs)
		mergedPrevious = mergeQueryRunResults(shiftedPreviousResults, displayNameById, {
			seriesSuffix: " (prev)",
			usedSeriesNames,
		})
		mergedSets.push(mergedPrevious)
	}

	const mergedRows = combineRows(mergedSets)
	if (comparison.mode === "previous_period" && comparison.includePercentChange && mergedPrevious) {
		appendPercentChangeSeries(
			mergedRows,
			mergedCurrent.seriesNameByStableKey,
			mergedPrevious.seriesNameByStableKey,
		)
	}

	const debugInfo: QueryBuilderTimeseriesDebug = {
		primaryWindow: {
			startTime: input.startTime,
			endTime: input.endTime,
		},
		comparison: {
			mode: comparison.mode,
			includePercentChange: comparison.includePercentChange,
			shiftedByMs: shiftMs > 0 ? shiftMs : 0,
			previousStartTime,
			previousEndTime,
		},
		// Reported under the wire spelling, which is what the caller sent and what
		// the lab's debug panel labels its rows with.
		strategy: {
			enableEmptyRangeFallback: strategy.enabled,
			fallbackWindowSeconds: [...strategy.windowSeconds],
			maxFallbackRangeSeconds: strategy.maxRangeSeconds,
		},
		queries: currentWindow.debug,
		previousQueries: previousDebug,
	}

	if (input.debug === true) {
		yield* Effect.logInfo("timeseries execution", debugInfo)
	}

	return {
		data: mergedRows,
		...(input.debug === true ? { debug: debugInfo } : {}),
	} satisfies QueryBuilderTimeseriesResponse
})
