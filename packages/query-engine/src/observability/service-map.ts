import { Array as Arr, Effect, pipe } from "effect"
import type { ServiceDependenciesOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TimeRange, ServiceEdge } from "./types"

export const serviceMap = (input: {
  readonly timeRange: TimeRange
  readonly service?: string
  readonly environment?: string
}): Effect.Effect<ReadonlyArray<ServiceEdge>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query<ServiceDependenciesOutput>(
      "service_dependencies",
      {
        start_time: input.timeRange.startTime,
        end_time: input.timeRange.endTime,
        ...(input.service && { service_name: input.service }),
        ...(input.environment && { deployment_env: input.environment }),
      },
      { profile: "aggregation" },
    )

    return pipe(
      result.data,
      Arr.map((e): ServiceEdge => ({
        sourceService: e.sourceService,
        targetService: e.targetService,
        callCount: Number(e.callCount),
        errorCount: Number(e.errorCount),
        avgDurationMs: e.avgDurationMs,
        p95DurationMs: e.p95DurationMs,
      })),
    )
  })
