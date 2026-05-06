import { Effect, Schema } from "effect"
import {
	ServiceDbEdgesRequest,
	ServiceDependenciesRequest,
	ServicePlatformsRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { summarizeSampling } from "@/lib/sampling"
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

export interface ServiceDbEdge {
	sourceService: string
	dbSystem: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

export interface ServiceDbEdgesResponse {
	edges: ServiceDbEdge[]
}

export type ServicePlatform = "kubernetes" | "cloudflare" | "lambda" | "web" | "unknown"

export interface ServicePlatformInfo {
	serviceName: string
	platform: ServicePlatform
	k8sCluster: string
	cloudPlatform: string
	cloudProvider: string
	faasName: string
	mapleSdkType: string
	runtime: string
}

export interface ServicePlatformsResponse {
	platforms: ServicePlatformInfo[]
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
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
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

function transformDbEdge(row: Record<string, unknown>, durationSeconds: number): ServiceDbEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		dbSystem: String(row.dbSystem ?? ""),
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

export const getServiceMapDbEdges = Effect.fn("QueryEngine.getServiceMapDbEdges")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMapDbEdges")
	const fallback = defaultTimeRange()

	const result = yield* runTinybirdQuery("serviceDbEdges", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDbEdges({
				payload: new ServiceDbEdgesRequest({
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
		edges: result.data.map((row) => transformDbEdge(row, durationSeconds)),
	}
})

export const getServicePlatforms = Effect.fn("QueryEngine.getServicePlatforms")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServicePlatforms")
	const fallback = defaultTimeRange()

	const result = yield* runTinybirdQuery("servicePlatforms", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.servicePlatforms({
				payload: new ServicePlatformsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					deploymentEnv: input.deploymentEnv,
				}),
			})
		}),
	)

	return {
		platforms: result.data.map((row) => ({
			serviceName: row.serviceName,
			platform: row.platform,
			k8sCluster: row.k8sCluster,
			cloudPlatform: row.cloudPlatform,
			cloudProvider: row.cloudProvider,
			faasName: row.faasName,
			mapleSdkType: row.mapleSdkType,
			runtime: row.processRuntimeName,
		})),
	}
})
