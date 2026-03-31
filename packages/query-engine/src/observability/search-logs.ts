import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { SearchLogsInput, SearchLogsOutput, LogEntry } from "./types"

export const searchLogs = (
  input: SearchLogsInput,
): Effect.Effect<SearchLogsOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 30
    const offset = input.offset ?? 0

    const params: Record<string, unknown> = {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      limit,
      offset,
    }
    if (input.service) params.service = input.service
    if (input.severity) params.severity = input.severity
    if (input.search) params.body_search = input.search
    if (input.traceId) params.trace_id = input.traceId

    const [logsResult, countResult] = yield* Effect.all(
      [
        executor.query("list_logs", params),
        executor.query("logs_count", {
          start_time: input.timeRange.startTime,
          end_time: input.timeRange.endTime,
          ...(input.service && { service: input.service }),
          ...(input.severity && { severity: input.severity }),
          ...(input.search && { body_search: input.search }),
          ...(input.traceId && { trace_id: input.traceId }),
        }),
      ],
      { concurrency: "unbounded" },
    )

    const logs = (logsResult.data as any[]).map((l): LogEntry => ({
      timestamp: String(l.timestamp),
      severityText: l.severityText || "INFO",
      serviceName: l.serviceName,
      body: l.body,
      traceId: l.traceId ?? "",
      spanId: l.spanId ?? "",
    }))

    const total = Number((countResult.data as any[])[0]?.count ?? 0)

    return {
      timeRange: input.timeRange,
      total,
      logs,
      pagination: { offset, limit, hasMore: logs.length === limit },
    }
  })
