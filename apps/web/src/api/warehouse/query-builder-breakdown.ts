import { Effect, Result, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { buildBreakdownQuerySpec } from "@maple/query-engine/query-builder"
import { type BreakdownQueryResult, mergeBreakdownResults } from "@maple/query-engine/query-set"
import { decodeInput, executeQueryEngine, invalidWarehouseInput } from "@/api/warehouse/effect-utils"
import { displayError } from "@/lib/error-messages"

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

const executeBreakdownQuery = Effect.fn("QueryEngine.executeBreakdownQuery")(function* (
	startTime: string,
	endTime: string,
	query: QueryBuilderBreakdownInput["queries"][number],
	defaultLimit: number | undefined,
) {
	const built = buildBreakdownQuerySpec(query, { defaultLimit })

	if (!built.query) {
		return {
			queryId: query.id,
			queryName: query.name,
			status: "error",
			error: built.error ?? "Failed to build breakdown query",
			data: [],
		} satisfies BreakdownQueryResult
	}

	const request = yield* decodeInput(
		QueryEngineExecuteRequest,
		{
			startTime,
			endTime,
			query: built.query,
		},
		"executeBreakdownQuery.request",
	)

	// Per-query failures are folded into the result status rather than failing the
	// whole batch, so one bad query doesn't blank the chart. Capture the outcome.
	const outcome = yield* Effect.result(executeQueryEngine("queryEngine.breakdownQuery", request))

	if (Result.isFailure(outcome)) {
		const error = outcome.failure
		return {
			queryId: query.id,
			queryName: query.name,
			status: "error",
			error: displayError(error).message,
			data: [],
		} satisfies BreakdownQueryResult
	}

	const response = outcome.success
	if (response.result.kind !== "breakdown") {
		return {
			queryId: query.id,
			queryName: query.name,
			status: "error",
			error: "Unexpected non-breakdown result",
			data: [],
		} satisfies BreakdownQueryResult
	}

	const mapped = response.result.data.map((item) => ({
		name: item.name,
		value: item.value,
	}))

	return {
		queryId: query.id,
		queryName: query.name,
		status: "success",
		error: null,
		// error_rate arrives from the query engine as a 0–1 ratio — the canonical
		// unit everywhere (the "percent" display unit multiplies by 100 when
		// formatting). No rescaling here.
		data: mapped,
	} satisfies BreakdownQueryResult
})

export function getQueryBuilderBreakdown({ data }: { data: QueryBuilderBreakdownInput }) {
	return getQueryBuilderBreakdownEffect({ data })
}

const getQueryBuilderBreakdownEffect = Effect.fn("QueryEngine.getQueryBuilderBreakdown")(function* ({
	data,
}: {
	data: QueryBuilderBreakdownInput
}) {
	const input = yield* decodeInput(QueryBuilderBreakdownInputSchema, data, "getQueryBuilderBreakdown")

	// Hidden breakdown queries feed no formulas, so do not execute them.
	const enabledQueries = input.queries.filter((query) => query.enabled !== false && !query.hidden)
	if (enabledQueries.length === 0) {
		return yield* invalidWarehouseInput("getQueryBuilderBreakdown", "No enabled queries to run")
	}

	const results = yield* Effect.forEach(
		enabledQueries,
		(query) => executeBreakdownQuery(input.startTime, input.endTime, query, input.defaultLimit),
		{ concurrency: enabledQueries.length },
	)

	const firstError = results.find((r) => r.status === "error" && r.error)?.error
	const anySuccess = results.some((r) => r.status === "success" && r.data.length > 0)

	if (!anySuccess) {
		return yield* invalidWarehouseInput(
			"getQueryBuilderBreakdown",
			firstError ?? "No breakdown data found in selected time range",
		)
	}

	return {
		data: mergeBreakdownResults(results, enabledQueries),
	}
})

// The merge itself moved to `@maple/query-engine/query-set` and is tested there;
// what stays worth asserting here is that this module adds no rescaling of its
// own on the way out.
export const __testables = {}
