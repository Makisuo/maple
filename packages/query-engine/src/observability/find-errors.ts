import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorsByTypeOutput } from "@maple/domain/tinybird"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { FindErrorsInput, ErrorSummary } from "./types"
import { toErrorSummary } from "./row-mappers"

export const findErrors = (
  input: FindErrorsInput,
): Effect.Effect<ReadonlyArray<ErrorSummary>, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor

    const result = yield* executor.query<ErrorsByTypeOutput>("errors_by_type", {
      start_time: input.timeRange.startTime,
      end_time: input.timeRange.endTime,
      ...(input.service && { services: input.service }),
      ...(input.environment && { deployment_envs: input.environment }),
      limit: input.limit ?? 20,
    })

    return pipe(result.data, Arr.map(toErrorSummary))
  })
