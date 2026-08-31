import { Effect, Schema } from "effect"
import { DeploymentEnvironment, ServiceEndpointsRequest, ServiceName } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

export interface ServiceEndpoint {
	/** Normalized name ("GET /api/users") — valid as a /traces `spanNames` filter. */
	spanName: string
	method: string
	route: string
	spanCount: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	/** 0–1 ratio, sampling-weighted. ×100 only at display. */
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	p99DurationMs: number
}

const GetServiceEndpointsInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
	limit: Schema.optional(Schema.Number),
})

export type GetServiceEndpointsInput = (typeof GetServiceEndpointsInput)["Encoded"]

export const getServiceEndpoints = Effect.fn("QueryEngine.getServiceEndpoints")(function* ({
	data,
}: {
	data: GetServiceEndpointsInput
}) {
	const input = yield* decodeInput(GetServiceEndpointsInput, data, "getServiceEndpoints")

	const result = yield* runWarehouseQuery("serviceEndpoints", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.serviceEndpoints({
				payload: new ServiceEndpointsRequest({
					serviceName: input.serviceName,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: input.environments,
					limit: input.limit,
				}),
			})
		}),
	)

	const endpoints: ServiceEndpoint[] = result.data.map((row) => ({
		spanName: row.spanName,
		method: row.method,
		route: row.route,
		spanCount: row.spanCount,
		estimatedSpanCount: row.estimatedSpanCount,
		errorCount: row.errorCount,
		estimatedErrorCount: row.estimatedErrorCount,
		errorRate: row.errorRate,
		avgDurationMs: row.avgDurationMs,
		p50DurationMs: row.p50DurationMs,
		p95DurationMs: row.p95DurationMs,
		p99DurationMs: row.p99DurationMs,
	}))

	return { endpoints }
})
