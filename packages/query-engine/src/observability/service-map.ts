import { Array as Arr, Effect, pipe } from "effect"
import type { ServiceDependenciesOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { TimeRange, ServiceEdge } from "./types"

export const serviceMap = Effect.fn("Observability.serviceMap")(function* (input: {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly environment?: string
}) {
	const executor = yield* WarehouseExecutor

	yield* Effect.annotateCurrentSpan({
		service: input.service ?? "all",
		environment: input.environment ?? "all",
	})

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

	yield* Effect.annotateCurrentSpan("edgeCount", result.data.length)

	return pipe(
		result.data,
		Arr.map(
			(e): ServiceEdge => ({
				sourceService: e.sourceService,
				targetService: e.targetService,
				callCount: Number(e.callCount),
				errorCount: Number(e.errorCount),
				avgDurationMs: e.avgDurationMs,
				maxDurationMs: e.maxDurationMs,
			}),
		),
	)
})
