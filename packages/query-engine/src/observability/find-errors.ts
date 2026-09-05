import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorsByTypeOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { FindErrorsInput } from "./types"
import { toErrorSummary } from "./row-mappers"

export const findErrors = Effect.fn("Observability.findErrors")(function* (input: FindErrorsInput) {
	const executor = yield* WarehouseExecutor

	const result = yield* executor.query<ErrorsByTypeOutput>(
		"errors_by_type",
		{
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { services: input.service }),
			...(input.environment && { deployment_envs: input.environment }),
			...(input.identity && { identity: input.identity }),
			...(input.namespacePrefix && { namespace_prefix: input.namespacePrefix }),
			limit: input.limit ?? 20,
		},
		{ profile: "aggregation" },
	)

	return pipe(result.data, Arr.map(toErrorSummary))
})
