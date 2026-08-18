/**
 * The breakdown path: run each enabled query, merge into rows.
 *
 * Shaped differently from the timeseries path on purpose, and the difference is
 * behavioural rather than stylistic — see the error note on
 * `runBreakdownQuerySet`.
 */

import { Effect, Result } from "effect"
import type { QuerySet } from "@maple/query-model"
import { buildBreakdownQuerySpec } from "../query-builder/model"
import { type BreakdownQueryResult, mergeBreakdownResults } from "./breakdown-merge"
import { QuerySetInputError, QuerySetNoDataError } from "./errors"
import type { QuerySetExecutor } from "./port"

export interface BreakdownQuerySetResult {
	readonly rows: ReadonlyArray<Record<string, string | number>>
	readonly diagnostics: ReadonlyArray<BreakdownQueryResult>
}

export interface RunBreakdownQuerySetInput {
	readonly querySet: QuerySet
	readonly startTime: string
	readonly endTime: string
	/**
	 * Rows to fetch per query when the author set no explicit limit add-on.
	 * A panel that collapses its long tail into an "Other" bucket asks for more
	 * rows than it draws, so that bucket is a real sum rather than absent; one
	 * that plots every row it receives omits this and keeps the warehouse default.
	 */
	readonly defaultLimit?: number
}

const OPERATION = "runBreakdownQuerySet"

/**
 * Run a query set as a breakdown.
 *
 * NOTE the error asymmetry with `runTimeseriesQuerySet`, which is deliberate and
 * predates this package: here EVERY per-query failure folds into
 * `status: "error"`, including the first window's, so one bad query cannot blank
 * a chart that has working ones. The timeseries path instead lets a
 * primary-window failure escape. Making the two uniform is a behaviour change
 * for one surface or the other and belongs in its own change, not in a move.
 */
export const runBreakdownQuerySet = Effect.fnUntraced(function* <E>(
	executor: QuerySetExecutor<E>,
	input: RunBreakdownQuerySetInput,
) {
	// Hidden breakdown queries feed no formulas, so — unlike timeseries — there is
	// nothing to run them for.
	const enabledQueries = input.querySet.queries.filter((query) => query.enabled !== false && !query.hidden)
	if (enabledQueries.length === 0) {
		return yield* new QuerySetInputError({
			operation: OPERATION,
			message: "No enabled queries to run",
		})
	}

	const results = yield* Effect.forEach(
		enabledQueries,
		(query) =>
			Effect.gen(function* () {
				const built = buildBreakdownQuerySpec(
					query,
					input.defaultLimit === undefined ? undefined : { defaultLimit: input.defaultLimit },
				)

				if (!built.query) {
					return {
						queryId: query.id,
						queryName: query.name,
						status: "error",
						error: built.error ?? "Failed to build breakdown query",
						data: [],
					} satisfies BreakdownQueryResult
				}

				const outcome = yield* Effect.result(
					executor.execute({
						startTime: input.startTime,
						endTime: input.endTime,
						query: built.query,
					}),
				)

				if (Result.isFailure(outcome)) {
					return {
						queryId: query.id,
						queryName: query.name,
						status: "error",
						error: executor.describeError(outcome.failure),
						data: [],
					} satisfies BreakdownQueryResult
				}

				const result = outcome.success
				if (result.kind !== "breakdown") {
					return {
						queryId: query.id,
						queryName: query.name,
						status: "error",
						error: `Unexpected result kind: ${result.kind}`,
						data: [],
					} satisfies BreakdownQueryResult
				}

				return {
					queryId: query.id,
					queryName: query.name,
					status: "success",
					error: null,
					// error_rate arrives from the query engine as a 0–1 ratio — the
					// canonical unit everywhere (the "percent" display unit multiplies
					// by 100 when formatting). No rescaling here.
					data: result.data.map((item) => ({ name: item.name, value: item.value })),
				} satisfies BreakdownQueryResult
			}),
		{ concurrency: Math.max(enabledQueries.length, 1) },
	)

	if (!results.some((r) => r.status === "success" && r.data.length > 0)) {
		const details = results.flatMap((r) =>
			typeof r.error === "string" && r.error.length > 0 ? [r.error] : [],
		)
		return yield* new QuerySetNoDataError({
			message: details[0] ?? "No breakdown data found in selected time range",
			details,
		})
	}

	return {
		rows: mergeBreakdownResults(results, enabledQueries),
		diagnostics: results,
	} satisfies BreakdownQuerySetResult
})
