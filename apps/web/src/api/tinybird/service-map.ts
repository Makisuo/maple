import { Effect, Schema } from "effect"
import { ServiceDependenciesRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { estimateThroughput } from "@/lib/sampling"
import { TinybirdDateTimeString, decodeInput, runTinybirdQuery } from "@/api/tinybird/effect-utils"

export interface ServiceEdge {
	sourceService: string
	targetService: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

export interface ServiceMapResponse {
	edges: ServiceEdge[]
}

const GetServiceMapInputSchema = Schema.Struct({
	startTime: Schema.optional(TinybirdDateTimeString),
	endTime: Schema.optional(TinybirdDateTimeString),
	deploymentEnv: Schema.optional(Schema.String),
})

export type GetServiceMapInput = Schema.Schema.Type<typeof GetServiceMapInputSchema>

function transformEdge(row: Record<string, unknown>, durationSeconds: number): ServiceEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const sampledSpanCount = Number(row.sampledSpanCount ?? 0)
	const unsampledSpanCount = Number(row.unsampledSpanCount ?? 0)
	const threshold = String(row.dominantThreshold ?? "")
	const sampling = estimateThroughput(sampledSpanCount, unsampledSpanCount, threshold, durationSeconds)
	const estimatedCallCount = sampling.hasSampling
		? Math.round(sampling.estimated * durationSeconds)
		: callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		targetService: String(row.targetService ?? ""),
		callCount,
		estimatedCallCount,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs: Number(row.avgDurationMs ?? 0),
		p95DurationMs: Number(row.p95DurationMs ?? 0),
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
	}
}

const defaultTimeRange = () => {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

export const getServiceMap = Effect.fn("QueryEngine.getServiceMap")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMap")
	const fallback = defaultTimeRange()

	const result = yield* runTinybirdQuery("serviceDependencies", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDependencies({
				payload: new ServiceDependenciesRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					deploymentEnv: input.deploymentEnv,
				}),
			})
		}),
	)

	const startMs = input.startTime ? new Date(input.startTime.replace(" ", "T") + "Z").getTime() : 0
	const endMs = input.endTime ? new Date(input.endTime.replace(" ", "T") + "Z").getTime() : 0
	const durationSeconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600

	return {
		edges: result.data.map((row) => transformEdge(row, durationSeconds)),
	}
})
