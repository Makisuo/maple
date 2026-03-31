import { Array as Arr, Effect, pipe } from "effect"
import type { ListLogsOutput, LogsCountOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { SearchLogsInput, SearchLogsOutput } from "./types"
import { toLogEntry } from "./row-mappers"

export const searchLogs = (
  input: SearchLogsInput,
): Effect.Effect<SearchLogsOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 30
    const offset = input.offset ?? 0

    const optionalParams: Record<string, unknown> = {
      ...(input.service && { service: input.service }),
      ...(input.severity && { severity: input.severity }),
      ...(input.search && { body_search: input.search }),
      ...(input.traceId && { trace_id: input.traceId }),
    }

    const params = {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      limit,
      offset,
      ...optionalParams,
    }

    const [logsResult, countResult] = yield* Effect.all(
      [
        executor.query<ListLogsOutput>("list_logs", params),
        executor.query<LogsCountOutput>("logs_count", {
          start_time: input.timeRange.startTime,
          end_time: input.timeRange.endTime,
          ...optionalParams,
        }),
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
