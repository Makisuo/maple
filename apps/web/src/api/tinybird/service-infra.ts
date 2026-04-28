import { Effect, Schema } from "effect"
import { ServiceWorkloadsRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

export type ServiceWorkloadKind = "deployment" | "statefulset" | "daemonset" | "unknown"

export interface ServiceWorkload {
	serviceName: string
	workloadKind: ServiceWorkloadKind
	workloadName: string
	namespace: string
	clusterName: string
	podCount: number
	avgCpuLimitUtilization: number | null
	avgMemoryLimitUtilization: number | null
}

export interface ServiceWorkloadsResult {
	workloads: ServiceWorkload[]
}

const GetServiceWorkloadsInputSchema = Schema.Struct({
	startTime: TinybirdDateTimeString,
	endTime: TinybirdDateTimeString,
	services: Schema.Array(Schema.String),
})

export type GetServiceWorkloadsInput = Schema.Schema.Type<typeof GetServiceWorkloadsInputSchema>

export const getServiceWorkloads = Effect.fn("QueryEngine.getServiceWorkloads")(function* ({
	data,
}: {
	data: GetServiceWorkloadsInput
}) {
	const input = yield* decodeInput(GetServiceWorkloadsInputSchema, data, "getServiceWorkloads")

	if (input.services.length === 0) {
		return { workloads: [] } satisfies ServiceWorkloadsResult
	}

	const result = yield* runTinybirdQuery("serviceWorkloads", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceWorkloads({
				payload: new ServiceWorkloadsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					services: input.services,
				}),
			})
		}),
	)

	return {
		workloads: result.data.map((row) => ({
			serviceName: row.serviceName,
			workloadKind: row.workloadKind,
			workloadName: row.workloadName,
			namespace: row.namespace,
			clusterName: row.clusterName,
			podCount: row.podCount,
			avgCpuLimitUtilization: row.avgCpuLimitUtilization,
			avgMemoryLimitUtilization: row.avgMemoryLimitUtilization,
		})),
	} satisfies ServiceWorkloadsResult
})
