import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { FindSlowTracesInput, FindSlowTracesOutput, SpanResult } from "./types"

export const findSlowTraces = (
  input: FindSlowTracesInput,
): Effect.Effect<FindSlowTracesOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 10

    const [tracesResult, statsResult] = yield* Effect.all(
      [
        executor.query("list_traces", {
          start_time: input.timeRange.startTime,
          end_time: input.timeRange.endTime,
          ...(input.service && { service: input.service }),
          ...(input.environment && { deployment_env: input.environment }),
          limit: 500,
        }),
        executor.query("traces_duration_stats", {
          start_time: input.timeRange.startTime,
          end_time: input.timeRange.endTime,
          ...(input.service && { service: input.service }),
        }),
      ],
      { concurrency: "unbounded" },
    )

    const traces = (tracesResult.data as any[])
      .sort((a, b) => Number(b.durationMicros) - Number(a.durationMicros))
      .slice(0, limit)

    const rawStats = (statsResult.data as any[])[0]

    return {
      timeRange: input.timeRange,
      stats: rawStats ? {
        p50Ms: Number(rawStats.p50DurationMs ?? 0),
        p95Ms: Number(rawStats.p95DurationMs ?? 0),
        minMs: Number(rawStats.minDurationMs ?? 0),
        maxMs: Number(rawStats.maxDurationMs ?? 0),
      } : null,
      traces: traces.map((t): SpanResult => ({
        traceId: t.traceId,
        spanId: "",
        spanName: t.rootSpanName ?? "",
        serviceName: (t.services as string[])?.[0] ?? "",
        durationMs: Number(t.durationMicros) / 1000,
        statusCode: Number(t.hasError) ? "Error" : "Ok",
        statusMessage: "",
        attributes: {},
        timestamp: String(t.startTime ?? ""),
      })),
    }
  })
