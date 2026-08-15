import { Array as Arr, Effect, Schema, pipe } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { ListTracesOutput } from "@maple/domain/tinybird"
import type { SpanSearchOutput } from "../ch"
import { WarehouseValidationError } from "@maple/domain/http/warehouse-errors"
import {
	WarehouseExecutor,
	type WarehouseExecutorError,
	type WarehouseExecutorApi,
} from "./WarehouseExecutor"
import type { SearchTracesInput, SearchTracesOutput, SpanResult } from "./types"
import { toSpanResult } from "./row-mappers"
import { safeUInt } from "./sql-utils"

const MAX_LIMIT = 1000
const MAX_OFFSET = 1_000_000

/**
 * Search for spans matching the given criteria.
 *
 * When `spanName` is provided (and `rootOnly` is not true), queries the
 * `span_search` pipe to find matching spans. Broad searches use `traces`; a
 * concrete trace-id search uses `trace_detail_spans`, which is sorted for that
 * lookup pattern. This avoids the unreliable EXISTS subquery in the
 * `list_traces` pipe and returns the **matched span** data instead of root
 * span summaries.
 *
 * When searching by root-level fields only (service, error, duration), falls
 * back to the `list_traces` pipe for fast MV-backed queries.
 *
 * Both paths route through `executor.query(pipe, ...)`, so the same code runs
 * unchanged against local chDB and the remote warehouse.
 */
export const searchTraces = Effect.fn("Observability.searchTraces")(function* (input: SearchTracesInput) {
	const executor = yield* WarehouseExecutor
	const limit = safeUInt(input.limit, 20, MAX_LIMIT)
	const offset = safeUInt(input.offset, 0, MAX_OFFSET)

	yield* Effect.annotateCurrentSpan(
		"searchMode",
		input.spanName && !input.rootOnly ? "span_level" : "root_level",
	)
	if (input.service) yield* Effect.annotateCurrentSpan("service", input.service)
	if (input.spanName) yield* Effect.annotateCurrentSpan("spanName", input.spanName)

	// Root-level search is backed by the `list_traces` pipe, which only takes a
	// single attribute filter. Reject N>1 filters so callers know to switch to
	// span-level mode rather than silently drop everything past the first one.
	const rootMode = !(input.spanName && !input.rootOnly)
	if (rootMode && (input.attributeFilters?.length ?? 0) > 1) {
		return yield* new WarehouseValidationError({
			pipeName: "search_traces",
			message:
				"Root-level trace search supports at most one attribute filter. Provide spanName for span-level search to use multiple filters.",
		})
	}

	const spans =
		input.spanName && !input.rootOnly
			? yield* spanLevelSearch(executor, input, limit, offset)
			: yield* rootLevelSearch(executor, input, limit, offset)

	return {
		timeRange: input.timeRange,
		spans,
		pagination: { offset, limit, hasMore: spans.length === limit },
	} satisfies SearchTracesOutput
})

/**
 * Span-level filtering via the `span_search` pipe. Returns matched span data,
 * not root span summaries. The pipe applies span name exact/contains, service,
 * error, duration bounds, http method, trace id, and arbitrary attribute
 * filters; trace-id searches compile to the TraceId-sorted detail table.
 */
const spanLevelSearch = (
	executor: WarehouseExecutorApi,
	input: SearchTracesInput,
	limit: number,
	offset: number,
): Effect.Effect<ReadonlyArray<SpanResult>, WarehouseExecutorError> => {
	const params: Record<string, unknown> = {
		start_time: input.timeRange.startTime,
		end_time: input.timeRange.endTime,
		limit,
		offset,
		...(input.service && { service: input.service }),
		...(input.spanName && { span_name: input.spanName }),
		...(input.spanNameMatchMode === "contains" && { span_name_match_mode: "contains" }),
		...(input.hasError && { has_error: true }),
		...(input.minDurationMs != null && { min_duration_ms: input.minDurationMs }),
		...(input.maxDurationMs != null && { max_duration_ms: input.maxDurationMs }),
		...(input.httpMethod && { http_method: input.httpMethod }),
		...(input.traceId && { trace_id: input.traceId }),
		...(input.attributeFilters?.length && { attribute_filters: input.attributeFilters }),
	} satisfies Record<string, unknown>

	return Effect.map(
		executor.query<SpanSearchOutput>("span_search", params, { profile: "list" }),
		(result): ReadonlyArray<SpanResult> =>
			result.data.map(
				(row): SpanResult => ({
					traceId: Schema.decodeSync(TraceId)(row.traceId),
					spanId: Schema.decodeSync(SpanId)(row.spanId),
					spanName: row.spanName,
					serviceName: row.serviceName,
					durationMs: Number(row.durationMs),
					statusCode: row.statusCode,
					statusMessage: row.statusMessage ?? "",
					attributes: row.spanAttributes ?? {},
					resourceAttributes: row.resourceAttributes ?? {},
					timestamp: String(row.timestamp),
				}),
			),
	)
}

/**
 * Root-level search using the `list_traces` pipe.
 * Fast (MV-backed) but limited to root span filtering.
 */
const rootLevelSearch = (
	executor: WarehouseExecutorApi,
	input: SearchTracesInput,
	limit: number,
	offset: number,
): Effect.Effect<ReadonlyArray<SpanResult>, WarehouseExecutorError> => {
	const optionalParams: Record<string, unknown> = {
		...(input.service && { service: input.service }),
		...(input.spanName && { span_name: input.spanName }),
		...(input.spanNameMatchMode === "contains" && { span_name_match_mode: "contains" }),
		...(input.hasError && { has_error: true }),
		...(input.minDurationMs != null && { min_duration_ms: input.minDurationMs }),
		...(input.maxDurationMs != null && { max_duration_ms: input.maxDurationMs }),
		...(input.httpMethod && { http_method: input.httpMethod }),
		...(input.traceId && { trace_id: input.traceId }),
		...(input.attributeFilters?.[0]?.key && { attribute_filter_key: input.attributeFilters[0].key }),
		...(input.attributeFilters?.[0]?.value && {
			attribute_filter_value: input.attributeFilters[0].value,
		}),
	} satisfies Record<string, unknown>

	const params = {
		start_time: input.timeRange.startTime,
		end_time: input.timeRange.endTime,
		limit,
		offset,
		...optionalParams,
	}

	return Effect.map(
		executor.query<ListTracesOutput>("list_traces", params, { profile: "list" }),
		(result): ReadonlyArray<SpanResult> => pipe(result.data, Arr.map(toSpanResult)),
	)
}
