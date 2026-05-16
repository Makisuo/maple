import { Effect, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { mapleApiClientLayer } from "@/lib/registry"
import { buildListQuerySpec } from "@/lib/query-builder/model"
import { decodeInput, TinybirdQueryError } from "@/api/tinybird/effect-utils"

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const QueryBuilderListInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
	limit: Schema.optional(Schema.Number),
	columns: Schema.optional(Schema.Array(Schema.String)),
})

export type QueryBuilderListInput = Schema.Schema.Type<typeof QueryBuilderListInputSchema>

export interface QueryBuilderListResponse {
	data: Array<Record<string, unknown>>
}

const decodeQueryEngineRequest = Schema.decodeUnknownSync(QueryEngineExecuteRequest)

const executeListQueryEffect = Effect.fn("Tinybird.executeListQuery")(function* (
	payload: QueryEngineExecuteRequest,
) {
	const client = yield* MapleApiAtomClient
	return yield* client.queryEngine.execute({
		payload: new QueryEngineExecuteRequest(payload),
	})
})

async function executeListQueryInternal(input: QueryBuilderListInput): Promise<QueryBuilderListResponse> {
	const enabledQueries = input.queries.filter((q) => q.enabled !== false)
	if (enabledQueries.length === 0) {
		throw new Error("No enabled queries to run")
	}

	// Use the first enabled query for the list
	const query = enabledQueries[0]
	const built = buildListQuerySpec(query, input.limit, input.columns as string[] | undefined)

	if (!built.query) {
		throw new Error(built.error ?? "Failed to build list query")
	}

	const payload = decodeQueryEngineRequest({
		startTime: input.startTime,
		endTime: input.endTime,
		query: built.query,
	})

	const response = await Effect.runPromise(
		executeListQueryEffect(payload).pipe(Effect.provide(mapleApiClientLayer)),
	)

	if (response.result.kind !== "list") {
		throw new Error(`Unexpected result kind: ${response.result.kind}`)
	}

	return {
		data: response.result.data as Array<Record<string, unknown>>,
	}
}

export function getQueryBuilderList({ data }: { data: QueryBuilderListInput }) {
	return getQueryBuilderListEffect({ data })
}

const getQueryBuilderListEffect = Effect.fn("Tinybird.getQueryBuilderList")(function* ({
	data,
}: {
	data: QueryBuilderListInput
}) {
	const input = yield* decodeInput(QueryBuilderListInputSchema, data, "getQueryBuilderList")

	return yield* Effect.tryPromise({
		try: () => executeListQueryInternal(input),
		catch: (cause) =>
			new TinybirdQueryError({
				operation: "getQueryBuilderList",
				message: cause instanceof Error ? cause.message : "Failed to fetch query-builder list",
				cause,
			}),
	})
})
