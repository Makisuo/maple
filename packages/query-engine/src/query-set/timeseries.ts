/**
 * The whole timeseries path: run the set, merge, apply the comparison window.
 *
 * Everything a chart needs from a stored `QuerySet`, given only a host that can
 * execute one `QuerySpec`.
 */

import { Effect } from "effect"
import type { QueryComparisonMode, QuerySet } from "@maple/query-model"
import { parseWarehouseDateTime, formatWarehouseDateTime } from "../datetime"
import type { FormulaDraft, QueryRunResult } from "../formula-results"
import type { EmptyRangeFallbackStrategy } from "./bucketing"
import { NO_QUERY_DATA_MESSAGE, QuerySetInputError, QuerySetNoDataError } from "./errors"
import type { QuerySetExecutor } from "./port"
import {
	appendPercentChangeSeries,
	collectHiddenResultIds,
	combineRows,
	countSuccessfulQuerySeries,
	hasAnySeriesData,
	mergeQueryRunResults,
	shiftRunResults,
	toDisplayNameById,
} from "./series-merge"
import { runQuerySetWindow, type QuerySetQueryDiagnostics } from "./window"

export interface TimeseriesQuerySetDiagnostics {
	readonly primaryWindow: { readonly startTime: string; readonly endTime: string }
	readonly comparison: {
		readonly mode: QueryComparisonMode
		readonly includePercentChange: boolean
		readonly shiftedByMs: number
		readonly previousStartTime: string | null
		readonly previousEndTime: string | null
	}
	readonly queries: ReadonlyArray<QuerySetQueryDiagnostics>
	readonly previousQueries: ReadonlyArray<QuerySetQueryDiagnostics>
}

export interface TimeseriesQuerySetResult {
	readonly rows: ReadonlyArray<Record<string, string | number>>
	readonly diagnostics: TimeseriesQuerySetDiagnostics
}

export interface RunTimeseriesQuerySetInput {
	readonly querySet: QuerySet
	readonly startTime: string
	readonly endTime: string
	/** Defaults to no widening. Only explore surfaces pass one. */
	readonly fallback?: EmptyRangeFallbackStrategy
}

const OPERATION = "runTimeseriesQuerySet"

/**
 * Diagnostics are always computed, never gated behind a `debug` flag.
 *
 * They were already assembled unconditionally and then thrown away unless the
 * caller asked; and since both hosts of this runner already hold the result
 * in-process, returning them costs nothing on the wire.
 */
export const runTimeseriesQuerySet = Effect.fnUntraced(function* <E>(
	executor: QuerySetExecutor<E>,
	input: RunTimeseriesQuerySetInput,
) {
	const { querySet } = input

	const formulas: FormulaDraft[] = (querySet.formulas ?? []).map((formula) => ({
		id: formula.id,
		name: formula.name,
		expression: formula.expression,
		legend: formula.legend,
	}))
	const hiddenResultIds = collectHiddenResultIds({
		queries: querySet.queries,
		formulas: querySet.formulas,
	})
	const isPlotted = (result: QueryRunResult): boolean => !hiddenResultIds.has(result.queryId)
	const comparison = {
		mode: querySet.comparison?.mode ?? ("none" as QueryComparisonMode),
		includePercentChange: querySet.comparison?.includePercentChange ?? true,
	}

	// `hidden` queries still run — a formula that references one needs its
	// numbers — so only `enabled` filters here.
	const enabledQueries = querySet.queries.filter((query) => query.enabled !== false)
	if (enabledQueries.length === 0) {
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: "No enabled queries to run",
		})
	}

	const currentWindow = yield* runQuerySetWindow(executor, {
		queries: enabledQueries,
		formulas,
		startTime: input.startTime,
		endTime: input.endTime,
		...(input.fallback === undefined ? {} : { fallback: input.fallback }),
	})

	if (countSuccessfulQuerySeries(currentWindow.queryResults) === 0) {
		const details = currentWindow.queryResults.flatMap((result) =>
			typeof result.error === "string" && result.error.length > 0 ? [result.error] : [],
		)
		return yield* new QuerySetNoDataError({
			message: details[0] ?? NO_QUERY_DATA_MESSAGE,
			details,
		})
	}

	const allResults = currentWindow.allResults

	if (!allResults.some((result) => result.status === "success" && hasAnySeriesData(result.data))) {
		const firstError = allResults.find((result) => result.error)?.error
		return yield* new QuerySetNoDataError({
			message: firstError ?? "No successful query results",
			details: firstError === undefined || firstError === null ? [] : [firstError],
		})
	}

	// Data came back, but nothing plottable did — say why rather than drawing an empty chart the
	// reader would blame on the time range. On a ratio widget the plotted series is the formula,
	// so its own failure (an unknown reference, no overlapping buckets) is the useful message.
	if (!allResults.some((result) => isPlotted(result) && hasAnySeriesData(result.data))) {
		const plottedError = allResults.find((result) => isPlotted(result) && result.error)?.error
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: plottedError ?? "Every query and formula with data is hidden — nothing to plot",
		})
	}

	const displayNameById = toDisplayNameById([
		...enabledQueries,
		...formulas.map((formula) => ({
			id: formula.id,
			name: formula.name,
			legend: formula.legend,
		})),
	])

	// ORDER MATTERS: `usedSeriesNames` is shared, and the current window must
	// claim its names before the previous one, or ` (prev)` series would take the
	// unsuffixed spellings.
	const usedSeriesNames = new Set<string>()
	const mergedCurrent = mergeQueryRunResults(allResults.filter(isPlotted), displayNameById, {
		usedSeriesNames,
	})
	const mergedSets = [mergedCurrent]

	const startMs = parseWarehouseDateTime(input.startTime)
	const endMs = parseWarehouseDateTime(input.endTime)
	const shiftMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0

	let mergedPrevious: ReturnType<typeof mergeQueryRunResults> | null = null
	let previousStartTime: string | null = null
	let previousEndTime: string | null = null
	let previousDiagnostics: ReadonlyArray<QuerySetQueryDiagnostics> = []

	if (comparison.mode === "previous_period" && shiftMs > 0) {
		previousStartTime = formatWarehouseDateTime(startMs - shiftMs)
		previousEndTime = formatWarehouseDateTime(endMs - shiftMs)

		// `allowFallback: false`: widening the comparison window would compare the
		// requested period against a differently-sized one.
		const previousWindow = yield* runQuerySetWindow(executor, {
			queries: enabledQueries,
			formulas,
			startTime: previousStartTime,
			endTime: previousEndTime,
			allowFallback: false,
			...(input.fallback === undefined ? {} : { fallback: input.fallback }),
		})
		previousDiagnostics = previousWindow.diagnostics

		const shiftedPreviousResults = shiftRunResults(previousWindow.allResults.filter(isPlotted), shiftMs)
		mergedPrevious = mergeQueryRunResults(shiftedPreviousResults, displayNameById, {
			seriesSuffix: " (prev)",
			usedSeriesNames,
		})
		mergedSets.push(mergedPrevious)
	}

	const rows = combineRows(mergedSets)
	if (comparison.mode === "previous_period" && comparison.includePercentChange && mergedPrevious) {
		appendPercentChangeSeries(
			rows,
			mergedCurrent.seriesNameByStableKey,
			mergedPrevious.seriesNameByStableKey,
		)
	}

	return {
		rows,
		diagnostics: {
			primaryWindow: { startTime: input.startTime, endTime: input.endTime },
			comparison: {
				mode: comparison.mode,
				includePercentChange: comparison.includePercentChange,
				shiftedByMs: shiftMs > 0 ? shiftMs : 0,
				previousStartTime,
				previousEndTime,
			},
			queries: currentWindow.diagnostics,
			previousQueries: previousDiagnostics,
		},
	} satisfies TimeseriesQuerySetResult
})
