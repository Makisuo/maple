import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { mapleApiClientLayer } from "@/lib/registry"
import { buildBreakdownQuerySpec, type QueryBuilderMetricType } from "@/lib/query-builder/model"
import { decodeInput, TinybirdQueryError } from "@/api/tinybird/effect-utils"

const dateTimeString = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/))

const METRIC_TYPES_TUPLE = ["sum", "gauge", "histogram", "exponential_histogram"] as const

const QueryDraftSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	hidden: Schema.optionalKey(Schema.Boolean),
	dataSource: Schema.Literals(["traces", "logs", "metrics"]),
	signalSource: Schema.Literals(["default", "meter"]),
	metricName: Schema.String,
	metricType: Schema.Literals(METRIC_TYPES_TUPLE),
	isMonotonic: Schema.optionalKey(Schema.Boolean),
	whereClause: Schema.String,
	aggregation: Schema.String,
	stepInterval: Schema.String,
	orderByDirection: Schema.Literals(["desc", "asc"]),
	addOns: Schema.Struct({
		groupBy: Schema.Boolean,
		having: Schema.Boolean,
		orderBy: Schema.Boolean,
		limit: Schema.Boolean,
		legend: Schema.Boolean,
	}),
	groupBy: Schema.mutable(Schema.Array(Schema.String)),
	having: Schema.String,
	orderBy: Schema.String,
	limit: Schema.String,
	legend: Schema.String,
})

const QueryBuilderBreakdownInputSchema = Schema.Struct({
	startTime: dateTimeString,
	endTime: dateTimeString,
	queries: Schema.mutable(Schema.Array(QueryDraftSchema)),
})

export type QueryBuilderBreakdownInput = Schema.Schema.Type<typeof QueryBuilderBreakdownInputSchema>

interface BreakdownQueryResult {
	queryId: string
	queryName: string
	status: "success" | "error"
	error: string | null
	data: Array<{ name: string; value: number }>
}

export interface QueryBuilderBreakdownResponse {
	data: Array<Record<string, string | number>>
}

const decodeQueryEngineRequest = Schema.decodeUnknownSync(QueryEngineExecuteRequest)

function normalizeErrorRateBreakdownData(data: BreakdownQueryResult["data"]): BreakdownQueryResult["data"] {
	return data.map((item) => ({
		...item,
		value: item.value / 100,
	}))
}

const executeBreakdownQueryEffect = Effect.fn("Tinybird.executeBreakdownQuery")(function* (
	payload: QueryEngineExecuteRequest,
) {
	const client = yield* MapleApiAtomClient
	return yield* client.queryEngine.execute({
		payload: new QueryEngineExecuteRequest(payload),
	})
})

async function executeBreakdownQuery(
	startTime: string,
	endTime: string,
	query: QueryBuilderBreakdownInput["queries"][number],
): Promise<BreakdownQueryResult> {
	const built = buildBreakdownQuerySpec({
		...query,
		hidden: false,
		metricType: query.metricType as QueryBuilderMetricType,
		isMonotonic: query.isMonotonic ?? query.metricType === "sum",
	})

	if (!built.query) {
		return {
			queryId: query.id,
			queryName: query.name,
			status: "error",
			error: built.error ?? "Failed to build breakdown query",
			data: [],
		}
	}

	const payload = decodeQueryEngineRequest({
		startTime,
		endTime,
		query: built.query,
	})

	try {
		const response = await Effect.runPromise(
			executeBreakdownQueryEffect(payload).pipe(Effect.provide(mapleApiClientLayer)),
		)

		if (response.result.kind !== "breakdown") {
			return {
				queryId: query.id,
				queryName: query.name,
				status: "error",
				error: "Unexpected non-breakdown result",
				data: [],
			}
		}

		return {
			queryId: query.id,
			queryName: query.name,
			status: "success",
			error: null,
			data:
				query.aggregation === "error_rate"
					? normalizeErrorRateBreakdownData(
							response.result.data.map((item) => ({
								name: item.name,
								value: item.value,
							})),
						)
					: response.result.data.map((item) => ({
							name: item.name,
							value: item.value,
						})),
		}
	} catch (error) {
		return {
			queryId: query.id,
			queryName: query.name,
			status: "error",
			error: error instanceof Error ? error.message : "Breakdown query failed",
			data: [],
		}
	}
}

function toDisplayName(query: { name: string; legend: string }): string {
	const trimmedLegend = query.legend.trim()
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

async function getQueryBuilderBreakdownInternal(
	input: QueryBuilderBreakdownInput,
): Promise<QueryBuilderBreakdownResponse> {
	const enabledQueries = input.queries.filter((query) => query.enabled !== false)
	if (enabledQueries.length === 0) {
		throw new Error("No enabled queries to run")
	}

	const results = await Promise.all(
		enabledQueries.map((query) => executeBreakdownQuery(input.startTime, input.endTime, query)),
	)

	const firstError = results.find((r) => r.status === "error" && r.error)?.error
	const anySuccess = results.some((r) => r.status === "success" && r.data.length > 0)

	if (!anySuccess) {
		throw new Error(firstError ?? "No breakdown data found in selected time range")
	}

	return {
		data: mergeBreakdownResults(results, enabledQueries),
	}
}

export function getQueryBuilderBreakdown({ data }: { data: QueryBuilderBreakdownInput }) {
	return getQueryBuilderBreakdownEffect({ data })
}

export const __testables = {
	normalizeErrorRateBreakdownData,
}

const getQueryBuilderBreakdownEffect = Effect.fn("Tinybird.getQueryBuilderBreakdown")(function* ({
	data,
}: {
	data: QueryBuilderBreakdownInput
}) {
	const input = yield* decodeInput(QueryBuilderBreakdownInputSchema, data, "getQueryBuilderBreakdown")

	return yield* Effect.tryPromise({
		try: () => getQueryBuilderBreakdownInternal(input),
		catch: (cause) =>
			new TinybirdQueryError({
				operation: "getQueryBuilderBreakdown",
				message: cause instanceof Error ? cause.message : "Failed to fetch query-builder breakdown",
				cause,
			}),
	})
})
