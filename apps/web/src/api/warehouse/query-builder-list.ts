import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { runListQuerySet } from "@maple/query-engine/query-set"
import { decodeInput, invalidWarehouseInput } from "@/api/warehouse/effect-utils"
import { makeWarehouseExecutor } from "@/api/warehouse/query-set-executor"

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const QueryBuilderListInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	limit: Schema.optional(Schema.Number),
	columns: Schema.optional(Schema.Array(Schema.String)),
})

export type QueryBuilderListInput = Schema.Schema.Type<typeof QueryBuilderListInputSchema>

const executor = makeWarehouseExecutor("queryEngine.queryBuilderList")

export function getQueryBuilderList({ data }: { data: QueryBuilderListInput }) {
	return getQueryBuilderListEffect({ data })
}

const getQueryBuilderListEffect = Effect.fn("QueryEngine.getQueryBuilderList")(function* ({
	data,
}: {
	data: QueryBuilderListInput
}) {
	const input = yield* decodeInput(QueryBuilderListInputSchema, data, "getQueryBuilderList")

	const outcome = yield* runListQuerySet(executor, {
		querySet: { queries: input.queries },
		startTime: input.startTime,
		endTime: input.endTime,
		...(!(input.limit === undefined) ? { limit: input.limit } : undefined),
		...(!(input.columns === undefined) ? { columns: input.columns } : undefined),
	}).pipe(
		Effect.catchTag("@maple/query-engine/query-set/QuerySetInputError", (error) =>
			invalidWarehouseInput("getQueryBuilderList", error.message),
		),
	)

	return { data: [...outcome.rows] }
})
