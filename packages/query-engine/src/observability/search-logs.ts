import { Array as Arr, Effect, pipe } from "effect"
import type { ListLogsOutput, LogsCountOutput } from "@maple/domain/tinybird"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { SearchLogsInput } from "./types"
import { toLogEntry } from "./row-mappers"

export const searchLogs = Effect.fn("Observability.searchLogs")(function* (input: SearchLogsInput) {
	const executor = yield* WarehouseExecutor
	const limit = input.limit ?? 30
	const offset = input.offset ?? 0

	const optionalParams: Record<string, unknown> = {
		...(input.service && { service: input.service }),
		...(input.severity && { severity: input.severity }),
		...(input.search && { search: input.search }),
		...(input.traceId && { trace_id: input.traceId }),
		...(input.spanId && { span_id: input.spanId }),
	} satisfies Record<string, unknown>

	const params = {
		start_time: input.timeRange.startTime,
		end_time: input.timeRange.endTime,
		limit,
		offset,
		...optionalParams,
	}

	// A Body search forces both queries to read the wide Body column for the
	// ILIKE filter — cap the read block size so peak memory stays granule-,
	// not block-, bound (see WarehouseQuerySettings.maxBlockSize).
	const searchSettings = input.search ? LOGS_BODY_SEARCH_SETTINGS : undefined

	const [logsResult, countResult] = yield* Effect.all(
		[
			executor.query<ListLogsOutput>("list_logs", params, {
				profile: "list",
				settings: searchSettings,
			}),
			executor.query<LogsCountOutput>(
				"logs_count",
				{
					start_time: input.timeRange.startTime,
					end_time: input.timeRange.endTime,
					...optionalParams,
				},
				{ profile: "discovery", settings: searchSettings },
			),
		],
		{ concurrency: "unbounded" },
	)

	const logs = pipe(logsResult.data, Arr.map(toLogEntry))
	const total = Number(countResult.data[0]?.total ?? 0)

	return {
		timeRange: input.timeRange,
		total,
		logs,
		pagination: { offset, limit, hasMore: logs.length === limit },
	}
})
