import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { QueryBuilderFormulaSchema, QueryComparisonSchema } from "@maple/query-model"
import {
	LAB_EMPTY_RANGE_STRATEGY,
	type EmptyRangeFallbackStrategy,
	type TimeseriesQuerySetDiagnostics,
	type TimeseriesQuerySetResult,
	fallbackStrategyFromWire,
	runTimeseriesQuerySet,
} from "@maple/query-engine/query-set"
import { decodeInput, invalidWarehouseInput, querySetFailure } from "@/api/warehouse/effect-utils"
import { makeWarehouseExecutor } from "@/api/warehouse/query-set-executor"

/**
 * The browser-side adapter for `runTimeseriesQuerySet`.
 *
 * Everything that shapes a query set into chart rows lives in
 * `@maple/query-engine/query-set`, shared with the MCP widget inspector. What is
 * left here is the three things that are genuinely this app's:
 *
 *   1. decoding the wire input,
 *   2. naming the executor's span,
 *   3. mapping the runner's tagged failures back onto `WarehouseInvalidInputError`
 *      with byte-identical messages, because `mapBuilderChartFailure` in the
 *      alert-preview path still string-matches them.
 */

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
	/**
	 * How many points the caller can display (its pixel width). Switches the
	 * auto bucket to the width model; see `RunTimeseriesQuerySetInput`.
	 */
	maxDataPoints: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

export type QueryBuilderTimeseriesInput = Schema.Schema.Type<typeof QueryBuilderTimeseriesInputSchema>

interface QueryBuilderTimeseriesResponse {
	data: Array<Record<string, string | number>>
	/**
	 * Always present, never behind a `debug` flag.
	 *
	 * It was already computed unconditionally and then discarded unless the caller
	 * asked for it, and this function runs in the browser — so there is no wire
	 * cost to returning it, and the lab reads it typed instead of casting.
	 */
	diagnostics: TimeseriesQuerySetDiagnostics
}

/**
 * The wire strategy shape mapped onto the package's — shared with the share
 * API's resolver, so both hosts read the same widget params the same way.
 */
function resolveStrategy(input: QueryBuilderTimeseriesInput): EmptyRangeFallbackStrategy {
	return fallbackStrategyFromWire(input.strategy, LAB_EMPTY_RANGE_STRATEGY)
}

/**
 * What this endpoint answers with when every query ran and the window simply
 * held nothing.
 *
 * An empty window is a normal answer, not a failure: raising it as
 * `WarehouseInvalidInputError` marked the span `Error` and billed an exception
 * event per tile per refresh (24 in 20 minutes from one user paging a quiet
 * dashboard). Every caller already renders zero rows as its own empty state —
 * chart tiles via `WidgetEmptyState`, the metric chart and the lab inline — so
 * the empty shape is all they need.
 *
 * The diagnostics describe exactly that: the requested window, the comparison
 * the caller asked for, and no per-query entries, because no query produced one.
 */
function emptyTimeseriesResponse(input: QueryBuilderTimeseriesInput): QueryBuilderTimeseriesResponse {
	return {
		data: [],
		diagnostics: {
			primaryWindow: { startTime: input.startTime, endTime: input.endTime },
			comparison: {
				mode: input.comparison?.mode ?? "none",
				includePercentChange: input.comparison?.includePercentChange ?? true,
				shiftedByMs: 0,
				previousStartTime: null,
				previousEndTime: null,
			},
			queries: [],
			previousQueries: [],
		},
	}
}

const executor = makeWarehouseExecutor("queryEngine.timeseriesQuery")

export function getQueryBuilderTimeseries({ data }: { data: QueryBuilderTimeseriesInput }) {
	return getQueryBuilderTimeseriesEffect({ data })
}

const getQueryBuilderTimeseriesEffect = Effect.fn("QueryEngine.getQueryBuilderTimeseries")(function* ({
	data,
}: {
	data: QueryBuilderTimeseriesInput
}) {
	const input = yield* decodeInput(QueryBuilderTimeseriesInputSchema, data, "getQueryBuilderTimeseries")
	const strategy = resolveStrategy(input)

	const outcome = yield* runTimeseriesQuerySet(executor, {
		querySet: {
			queries: input.queries,
			...(!(input.formulas === undefined) ? { formulas: input.formulas } : undefined),
			...(!(input.comparison === undefined) ? { comparison: input.comparison } : undefined),
		},
		startTime: input.startTime,
		endTime: input.endTime,
		fallback: strategy,
		...(!(input.maxDataPoints === undefined) ? { maxDataPoints: input.maxDataPoints } : undefined),
	}).pipe(
		// The runner's tagged failures carry the message this app already showed;
		// re-raising them keeps `displayError` and `mapBuilderChartFailure` working
		// unchanged. `querySetFailure` rather than `invalidWarehouseInput` for the
		// no-data case: the runner stringifies each per-query failure into
		// `details`, so a dropped connection arrived here as text and was re-raised
		// as "Invalid query" — telling the user to fix a request that never left
		// the browser.
		Effect.catchTags({
			"@maple/query-engine/query-set/QuerySetInputError": (error) =>
				invalidWarehouseInput("getQueryBuilderTimeseries", error.message),
			// Empty `details` means every query executed and none matched anything:
			// that is an empty result, so answer with one instead of failing. A
			// populated `details` carries a real per-query failure and stays an error.
			"@maple/query-engine/query-set/QuerySetNoDataError": (error) =>
				error.details.length === 0
					? Effect.succeed({
							rows: [],
							diagnostics: emptyTimeseriesResponse(input).diagnostics,
						} satisfies TimeseriesQuerySetResult)
					: querySetFailure("getQueryBuilderTimeseries", error.message),
		}),
	)

	yield* Effect.annotateCurrentSpan({
		"query_set.query_count": input.queries.length,
		"query_set.formula_count": input.formulas?.length ?? 0,
		"query_set.comparison_mode": outcome.diagnostics.comparison.mode,
		"query_set.fallback_used": outcome.diagnostics.queries.some((query) => query.fallbackUsed),
	})

	return {
		data: [...outcome.rows],
		diagnostics: outcome.diagnostics,
	} satisfies QueryBuilderTimeseriesResponse
})

export const __testables = {
	resolveStrategy,
	emptyTimeseriesResponse,
}
