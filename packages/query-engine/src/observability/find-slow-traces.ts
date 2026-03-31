import { Array as Arr, Effect, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { FindSlowTracesInput, FindSlowTracesOutput } from "./types"
import { toSpanResult } from "./row-mappers"

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

    const traces = pipe(
      tracesResult.data as any[],
      Arr.sort((a: any, b: any) => Number(b.durationMicros) > Number(a.durationMicros) ? -1 : Number(b.durationMicros) < Number(a.durationMicros) ? 1 : 0),
      Arr.take(limit),
      Arr.map(toSpanResult),
    )

    const rawStats = (statsResult.data as any[])[0]

    return {
      timeRange: input.timeRange,
      stats: rawStats ? {
        p50Ms: Number(rawStats.p50DurationMs ?? 0),
        p95Ms: Number(rawStats.p95DurationMs ?? 0),
        minMs: Number(rawStats.minDurationMs ?? 0),
        maxMs: Number(rawStats.maxDurationMs ?? 0),
      } : null,
      traces,
    }
  })
