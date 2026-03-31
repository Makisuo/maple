import { Array as Arr, Effect, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange, ServiceEdge } from "./types"

export const serviceMap = (input: {
  readonly timeRange: TimeRange
  readonly service?: string
  readonly environment?: string
}): Effect.Effect<ReadonlyArray<ServiceEdge>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query("service_dependencies", {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { service_name: input.service }),
      ...(input.environment && { deployment_env: input.environment }),
    })

    return pipe(
      result.data as any[],
      Arr.map((e): ServiceEdge => ({
        sourceService: e.sourceService ?? e.source ?? "",
        targetService: e.targetService ?? e.target ?? "",
        callCount: Number(e.callCount ?? e.count ?? 0),
        errorCount: Number(e.errorCount ?? 0),
        avgDurationMs: Number(e.avgDurationMs ?? 0),
        p95DurationMs: Number(e.p95DurationMs ?? 0),
      })),
    )
  })
