import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { runBreakdownQuerySet } from "@maple/query-engine/query-set"
import { decodeInput, invalidWarehouseInput } from "@/api/warehouse/effect-utils"
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
		...(input.defaultLimit === undefined ? {} : { defaultLimit: input.defaultLimit }),
	}).pipe(
		Effect.catchTags({
			"@maple/query-engine/query-set/QuerySetInputError": (error) =>
				invalidWarehouseInput("getQueryBuilderBreakdown", error.message),
			"@maple/query-engine/query-set/QuerySetNoDataError": (error) =>
				invalidWarehouseInput("getQueryBuilderBreakdown", error.message),
		}),
	)

	return { data: [...outcome.rows] }
})

// The merge and the per-query execution moved to `@maple/query-engine/query-set`
// and are tested there; what stays worth asserting here is that this module adds
// no rescaling of its own on the way out.
export const __testables = {}
