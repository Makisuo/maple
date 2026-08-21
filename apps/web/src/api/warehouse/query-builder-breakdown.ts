import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import {
	runBreakdownQuerySet,
	type BreakdownQuerySetResult,
	type QuerySetNoDataError,
} from "@maple/query-engine/query-set"
import {
	decodeInput,
	invalidWarehouseInput,
	querySetFailure,
	type WarehouseInvalidInputError,
	type WarehouseUnreachableError,
} from "@/api/warehouse/effect-utils"
import { makeWarehouseExecutor } from "@/api/warehouse/query-set-executor"

const executor = makeWarehouseExecutor("queryEngine.breakdownQuery")

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const QueryBuilderBreakdownInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	/**
	 * Rows to fetch per query when the author set no explicit limit add-on.
	 * A panel that collapses its long tail into an "Other" bucket asks for more
	 * rows than it draws, so that bucket is a real sum rather than absent; one
	 * that plots every row it receives omits this and keeps the warehouse default.
	 */
	defaultLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
})

export type QueryBuilderBreakdownInput = Schema.Schema.Type<typeof QueryBuilderBreakdownInputSchema>

/**
 * An empty window is a normal answer, not a failure.
 *
 * The same reasoning as `getQueryBuilderTimeseries`, which this path was left
 * out of: failing here marked the span `Error` and billed an exception event for
 * a panel the user simply has no data for, and `use-widget-data` already renders
 * an empty envelope as the muted "No data" frame. A populated `details` carries
 * a real per-query failure and stays an error.
 */
const onNoData = (
	error: QuerySetNoDataError,
): Effect.Effect<BreakdownQuerySetResult, WarehouseInvalidInputError | WarehouseUnreachableError> =>
	error.details.length === 0
		? Effect.succeed({ rows: [], diagnostics: [] })
		: querySetFailure("getQueryBuilderBreakdown", error.message)

export function getQueryBuilderBreakdown({ data }: { data: QueryBuilderBreakdownInput }) {
	return getQueryBuilderBreakdownEffect({ data })
}

const getQueryBuilderBreakdownEffect = Effect.fn("QueryEngine.getQueryBuilderBreakdown")(function* ({
	data,
}: {
	data: QueryBuilderBreakdownInput
}) {
	const input = yield* decodeInput(QueryBuilderBreakdownInputSchema, data, "getQueryBuilderBreakdown")

	const outcome = yield* runBreakdownQuerySet(executor, {
		querySet: { queries: input.queries },
		startTime: input.startTime,
		endTime: input.endTime,
		...(!(input.defaultLimit === undefined) ? { defaultLimit: input.defaultLimit } : undefined),
	}).pipe(
		Effect.catchTags({
			"@maple/query-engine/query-set/QuerySetInputError": (error) =>
				invalidWarehouseInput("getQueryBuilderBreakdown", error.message),
			"@maple/query-engine/query-set/QuerySetNoDataError": onNoData,
		}),
	)

	return { data: [...outcome.rows] }
})

// The merge and the per-query execution moved to `@maple/query-engine/query-set`
// and are tested there; what stays worth asserting here is that this module adds
// no rescaling of its own on the way out.
export const __testables = { onNoData }
