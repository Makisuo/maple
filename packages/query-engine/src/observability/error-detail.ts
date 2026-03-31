import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange, LogEntry } from "./types"

export interface ErrorDetailTrace {
  readonly traceId: string
  readonly rootSpanName: string
  readonly durationMs: number
  readonly spanCount: number
  readonly services: string[]
  readonly startTime: string
  readonly errorMessage: string
  readonly logs: ReadonlyArray<{ timestamp: string; severityText: string; body: string }>
}

export interface ErrorDetailOutput {
  readonly errorType: string
  readonly timeRange: TimeRange
  readonly traces: ReadonlyArray<ErrorDetailTrace>
  readonly timeseries?: ReadonlyArray<{ bucket: string; count: number }>
}

export const errorDetail = (input: {
  readonly errorType: string
  readonly timeRange: TimeRange
  readonly service?: string
  readonly includeTimeseries?: boolean
  readonly limit?: number
}): Effect.Effect<ErrorDetailOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 5

    const tracesResult = yield* executor.query("error_detail_traces", {
      error_type: input.errorType,
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { services: input.service }),
      limit,
    })

    const traces = tracesResult.data as any[]

    // Fetch logs for first 3 traces in parallel
    const traceIds = traces.slice(0, 3).map((t) => t.traceId)
    const logsResults = yield* Effect.all(
      traceIds.map((tid) =>
        executor.query("list_logs", { trace_id: tid, limit: 10 }),
      ),
      { concurrency: "unbounded" },
    )

    // Optionally fetch timeseries
    const timeseries = input.includeTimeseries
      ? yield* executor.query("errors_timeseries", {
          error_type: input.errorType,
          start_time: input.timeRange.startTime,
          end_time: input.timeRange.endTime,
          ...(input.service && { services: input.service }),
        }).pipe(Effect.map((r) => (r.data as any[]).map((p) => ({
          bucket: String(p.bucket),
          count: Number(p.count),
        }))))
      : undefined

    return {
      errorType: input.errorType,
      timeRange: input.timeRange,
      traces: traces.map((t, i): ErrorDetailTrace => ({
        traceId: t.traceId,
        rootSpanName: t.rootSpanName,
        durationMs: Number(t.durationMicros) / 1000,
        spanCount: Number(t.spanCount),
        services: t.services ?? [],
        startTime: String(t.startTime),
        errorMessage: t.errorMessage ?? "",
        logs: (i < logsResults.length ? (logsResults[i]!.data as any[]).slice(0, 5) : []).map((l) => ({
          timestamp: String(l.timestamp),
          severityText: l.severityText || "INFO",
          body: l.body,
        })),
      })),
      timeseries,
    }
  })
