import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { buildListQuerySpec } from "@maple/query-engine/query-builder"
import { decodeInput, executeQueryEngine, invalidWarehouseInput } from "@/api/warehouse/effect-utils"

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const QueryBuilderListInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	limit: Schema.optional(Schema.Number),
	columns: Schema.optional(Schema.Array(Schema.String)),
})

export type QueryBuilderListInput = Schema.Schema.Type<typeof QueryBuilderListInputSchema>

export function getQueryBuilderList({ data }: { data: QueryBuilderListInput }) {
	return getQueryBuilderListEffect({ data })
}

const getQueryBuilderListEffect = Effect.fn("QueryEngine.getQueryBuilderList")(function* ({
	data,
}: {
	data: QueryBuilderListInput
}) {
	const input = yield* decodeInput(QueryBuilderListInputSchema, data, "getQueryBuilderList")

	const enabledQueries = input.queries.filter((q) => q.enabled !== false)
	if (enabledQueries.length === 0) {
		return yield* invalidWarehouseInput("getQueryBuilderList", "No enabled queries to run")
	}

	const query = enabledQueries[0]
	const built = buildListQuerySpec(query, input.limit, input.columns as string[] | undefined)

	if (!built.query) {
		return yield* invalidWarehouseInput(
			"getQueryBuilderList",
			built.error ?? "Failed to build list query",
		)
	}

	const request = yield* decodeInput(
		QueryEngineExecuteRequest,
		{
			startTime: input.startTime,
			endTime: input.endTime,
			query: built.query,
		},
		"getQueryBuilderList.request",
	)

	const response = yield* executeQueryEngine("queryEngine.queryBuilderList", request)

	if (response.result.kind !== "list") {
		return yield* invalidWarehouseInput(
			"getQueryBuilderList",
			`Unexpected result kind: ${response.result.kind}`,
		)
	}

	return {
		data: response.result.data as Array<Record<string, unknown>>,
	}
})
