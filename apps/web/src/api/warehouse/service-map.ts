import { Clock, Effect, Schema } from "effect"
import {
	DeploymentEnvironment,
	ServiceCloudflareStatsRequest,
	ServiceDbEdgesRequest,
	ServiceDbQuerySummaryRequest,
	ServiceDependenciesBundleRequest,
	ServiceDependenciesRequest,
	ServiceName,
	ServicePlatformsRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { summarizeSampling } from "@/lib/sampling"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { transformExternalEdge } from "@/api/warehouse/service-external-edges"

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

export interface ServiceDbEdge {
	sourceService: string
	dbSystem: string
	/** Database identity (db.namespace → db.name → server.address → net.peer.name); "" = unknown. */
	dbNamespace: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

interface ServiceDbQuerySummary {
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	estimatedErrorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	activeServiceCount: number
}

interface ServiceDbQueryTimeseriesPoint {
	bucket: string
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
}

interface ServiceDbTopQuery {
	queryKey: string
	queryLabel: string
	sampleStatement: string
	sampleService: string
	serviceCount: number
	queryCount: number
	estimatedQueryCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
	lastSeen: string
}

export interface ServiceDbQuerySummaryResponse {
	summary: ServiceDbQuerySummary | null
	timeseries: ReadonlyArray<ServiceDbQueryTimeseriesPoint>
	topQueries: ReadonlyArray<ServiceDbTopQuery>
}

export type ServicePlatform = "kubernetes" | "cloudflare" | "lambda" | "web" | "unknown"

const GetServiceMapInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
})

export type GetServiceMapInput = (typeof GetServiceMapInputSchema)["Encoded"]

const GetServiceMapForServiceInputSchema = Schema.Struct({
	serviceName: ServiceName,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
})

export type GetServiceMapForServiceInput = (typeof GetServiceMapForServiceInputSchema)["Encoded"]

const GetServiceDbQuerySummaryInputSchema = Schema.Struct({
	dbSystem: Schema.String,
	dbNamespace: Schema.optional(Schema.String),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	sourceService: Schema.optional(ServiceName),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	bucketSeconds: Schema.optional(Schema.Number),
	topN: Schema.optional(Schema.Number),
})

export type GetServiceDbQuerySummaryInput = (typeof GetServiceDbQuerySummaryInputSchema)["Encoded"]

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

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

export const getServiceMap = Effect.fn("QueryEngine.getServiceMap")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMap")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDependencies", () =>
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

// Service-detail Dependencies tab in one request: the service-map edges, the
// DB edges, and the external edges run server-side under a single tenant/config
// resolution (see the `serviceDependenciesBundle` handler), replacing three
// independent browser→Worker round-trips with one shared fetch.
export const getServiceDependenciesBundle = Effect.fn("QueryEngine.getServiceDependenciesBundle")(function* ({
	data,
}: {
	data: GetServiceMapForServiceInput
}) {
	const input = yield* decodeInput(GetServiceMapForServiceInputSchema, data, "getServiceDependenciesBundle")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	const result = yield* runWarehouseQuery("serviceDependenciesBundle", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDependenciesBundle({
				payload: new ServiceDependenciesBundleRequest({
					serviceName: input.serviceName,
					startTime,
					endTime,
					deploymentEnv: input.deploymentEnv,
				}),
			})
		}),
	)

	const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
	const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
	const durationSeconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600

	return {
		serviceEdges: result.dependencies.map((row) => transformEdge(row, durationSeconds)),
		dbEdges: result.dbEdges.map((row) => transformDbEdge(row, durationSeconds)),
		externalEdges: result.externalEdges.map((row) => transformExternalEdge(row, durationSeconds)),
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
		dbNamespace: String(row.dbNamespace ?? ""),
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
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDbEdges", () =>
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

// ---------------------------------------------------------------------------
// Cloudflare direct-integration Worker analytics
//
// The analytics poller writes Worker metrics under the synthetic service name
// `cloudflare-worker/{script}` with no spans. The map overlays these onto the
// matching instrumented service node (by service name or faas.name); scripts
// with no matching real service are dropped — CF data never creates nodes.
// ---------------------------------------------------------------------------

const WORKER_SERVICE_PREFIX = "cloudflare-worker/"

export interface CloudflareService {
	serviceName: string
	kind: "worker"
	displayName: string
	requests: number
	throughput: number
	errorRate: number
	/** Wall-time duration p99. */
	latencyP99Ms: number
	/** CPU time p99. */
	cpuP99Ms?: number
}

function transformCloudflareService(row: Record<string, unknown>, durationSeconds: number): CloudflareService {
	const serviceName = String(row.serviceName ?? "")
	const displayName = serviceName.startsWith(WORKER_SERVICE_PREFIX)
		? serviceName.slice(WORKER_SERVICE_PREFIX.length)
		: serviceName
	const requests = Number(row.requests ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const safeDuration = Math.max(durationSeconds, 1)
	return {
		serviceName,
		kind: "worker",
		displayName,
		requests,
		throughput: requests / safeDuration,
		errorRate: requests > 0 ? errorCount / requests : 0,
		latencyP99Ms: Number(row.latencyP99Ms ?? 0),
		cpuP99Ms: Number(row.cpuP99Ms ?? 0),
	}
}

export const getServiceMapCloudflare = Effect.fn("QueryEngine.getServiceMapCloudflare")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServiceMapCloudflare")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceCloudflareStats", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceCloudflareStats({
				payload: new ServiceCloudflareStatsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)

	const startMs = input.startTime ? new Date(input.startTime.replace(" ", "T") + "Z").getTime() : 0
	const endMs = input.endTime ? new Date(input.endTime.replace(" ", "T") + "Z").getTime() : 0
	const durationSeconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600

	return {
		services: result.data.map((row) => transformCloudflareService(row, durationSeconds)),
	}
})

export const getServiceDbQuerySummary = Effect.fn("QueryEngine.getServiceDbQuerySummary")(function* ({
	data,
}: {
	data: GetServiceDbQuerySummaryInput
}) {
	const input = yield* decodeInput(GetServiceDbQuerySummaryInputSchema, data, "getServiceDbQuerySummary")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDbQuerySummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDbQuerySummary({
				payload: new ServiceDbQuerySummaryRequest({
					dbSystem: input.dbSystem,
					dbNamespace: input.dbNamespace,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					sourceService: input.sourceService,
					deploymentEnv: input.deploymentEnv,
					bucketSeconds: input.bucketSeconds,
					topN: input.topN,
				}),
			})
		}),
	)

	return {
		summary: result.summary,
		timeseries: result.timeseries,
		topQueries: result.topQueries,
	} satisfies ServiceDbQuerySummaryResponse
})

export const getServicePlatforms = Effect.fn("QueryEngine.getServicePlatforms")(function* ({
	data,
}: {
	data: GetServiceMapInput
}) {
	const input = yield* decodeInput(GetServiceMapInputSchema, data ?? {}, "getServicePlatforms")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("servicePlatforms", () =>
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
