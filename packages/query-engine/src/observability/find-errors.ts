import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { FindErrorsInput, ErrorSummary } from "./types"

export const findErrors = (
  input: FindErrorsInput,
): Effect.Effect<ReadonlyArray<ErrorSummary>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query("errors_by_type", {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { services: input.service }),
      ...(input.environment && { deployment_envs: input.environment }),
      limit: input.limit ?? 20,
    })

    return (result.data as any[]).map((e): ErrorSummary => ({
      errorType: e.errorType,
      count: Number(e.count),
      affectedServicesCount: Number(e.affectedServicesCount ?? 0),
      lastSeen: String(e.lastSeen),
    }))
  })
