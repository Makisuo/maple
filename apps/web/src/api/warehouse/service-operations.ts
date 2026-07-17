import { Effect, Schema } from "effect"
import { DeploymentEnvironment, ServiceName, ServiceOperationsRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

export interface ServiceOperationSparklinePoint {
	bucket: string
	count: number
}

export interface ServiceOperation {
	/** Display span name ("GET /api/users") — valid as a /traces `spanNames` filter. */
	spanName: string
	spanCount: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	/** 0–1 ratio, sampling-weighted. ×100 only at display. */
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	sparkline: ServiceOperationSparklinePoint[]
}

export interface ServiceOperationsResult {
	operations: ServiceOperation[]
}

const GetServiceOperationsInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	bucketSeconds: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
})

export type GetServiceOperationsInput = (typeof GetServiceOperationsInput)["Encoded"]

export const getServiceOperations = Effect.fn("QueryEngine.getServiceOperations")(function* ({
	data,
}: {
	data: GetServiceOperationsInput
}) {
	const input = yield* decodeInput(GetServiceOperationsInput, data, "getServiceOperations")

	const result = yield* runWarehouseQuery("serviceOperations", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceOperations({
				payload: new ServiceOperationsRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
					bucketSeconds: input.bucketSeconds,
					limit: input.limit,
				}),
			})
		}),
	)

	const operations: ServiceOperation[] = result.data.map((row) => ({
		spanName: row.spanName,
		spanCount: row.spanCount,
		estimatedSpanCount: row.estimatedSpanCount,
		errorCount: row.errorCount,
		estimatedErrorCount: row.estimatedErrorCount,
		errorRate: row.errorRate,
		avgDurationMs: row.avgDurationMs,
		p50DurationMs: row.p50DurationMs,
		p95DurationMs: row.p95DurationMs,
		sparkline: row.sparkline.map((point) => ({ bucket: point.bucket, count: point.count })),
	}))

	return { operations }
})
