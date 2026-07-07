import { Effect, Result, Schema } from "effect"
import { QueryBuilderQueryDraftSchema } from "@maple/domain/http"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { buildBreakdownQuerySpec } from "@/lib/query-builder/model"
import {
	type BackendError,
	type WarehouseQueryError,
	decodeInput,
	executeQueryEngine,
	invalidWarehouseInput,
} from "@/api/warehouse/effect-utils"

// Discriminate the typed query-engine error channel on `_tag` (both the local
// `WarehouseQueryError` and the backend `@maple/http/errors/Warehouse*` union
// carry a `message` field) rather than collapsing it via `instanceof Error`.
function queryEngineErrorMessage(error: WarehouseQueryError | BackendError, fallback: string): string {
	return "message" in error && typeof error.message === "string" ? error.message : fallback
}

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const QueryBuilderBreakdownInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
})

export type QueryBuilderBreakdownInput = Schema.Schema.Type<typeof QueryBuilderBreakdownInputSchema>

interface BreakdownQueryResult {
	queryId: string
	queryName: string
	status: "success" | "error"
	error: string | null
	data: Array<{ name: string; value: number }>
}

const executeBreakdownQuery = Effect.fn("QueryEngine.executeBreakdownQuery")(function* (
	startTime: string,
	endTime: string,
	query: QueryBuilderBreakdownInput["queries"][number],
) {
	const built = buildBreakdownQuerySpec(query)

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
			error: queryEngineErrorMessage(error, "Breakdown query failed"),
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

function toDisplayName(query: { name: string; legend?: string }): string {
	const trimmedLegend = (query.legend ?? "").trim()
	return trimmedLegend || query.name
}

function mergeBreakdownResults(
	results: BreakdownQueryResult[],
	enabledQueries: QueryBuilderBreakdownInput["queries"],
): Array<Record<string, string | number>> {
	const successful = results.filter((r) => r.status === "success" && r.data.length > 0)
	if (successful.length === 0) return []

	// Single query: return simple { name, value } rows
	if (successful.length === 1) {
		return successful[0].data
			.map((item) => ({ name: item.name, value: item.value }))
			.sort((a, b) => b.value - a.value)
	}

	// Multiple queries: merge by name, one column per query
	const rowsByName = new Map<string, Record<string, string | number>>()
	const columnNames: string[] = []
	const queriesById = new Map(enabledQueries.map((q) => [q.id, q]))

	for (const result of successful) {
		const query = queriesById.get(result.queryId)
		const displayName = query ? toDisplayName(query) : result.queryName
		columnNames.push(displayName)

		for (const item of result.data) {
			const row = rowsByName.get(item.name) ?? { name: item.name }
			row[displayName] = item.value
			rowsByName.set(item.name, row)
		}
	}

	// Fill missing values with 0
	for (const row of rowsByName.values()) {
		for (const col of columnNames) {
			if (typeof row[col] !== "number") {
				row[col] = 0
			}
		}
	}

	// Sort by the first column's value descending
	const firstCol = columnNames[0]
	return Array.from(rowsByName.values()).toSorted((a, b) => {
		const aVal = typeof a[firstCol] === "number" ? a[firstCol] : 0
		const bVal = typeof b[firstCol] === "number" ? b[firstCol] : 0
		return bVal - aVal
	})
}

export function getQueryBuilderBreakdown({ data }: { data: QueryBuilderBreakdownInput }) {
	return getQueryBuilderBreakdownEffect({ data })
}

const getQueryBuilderBreakdownEffect = Effect.fn("QueryEngine.getQueryBuilderBreakdown")(function* ({
	data,
}: {
	data: QueryBuilderBreakdownInput
}) {
	const input = yield* decodeInput(QueryBuilderBreakdownInputSchema, data, "getQueryBuilderBreakdown")

	const enabledQueries = input.queries.filter((query) => query.enabled !== false)
	if (enabledQueries.length === 0) {
		return yield* invalidWarehouseInput("getQueryBuilderBreakdown", "No enabled queries to run")
	}

	const results = yield* Effect.forEach(
		enabledQueries,
		(query) => executeBreakdownQuery(input.startTime, input.endTime, query),
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

export const __testables = {
	mergeBreakdownResults,
}
