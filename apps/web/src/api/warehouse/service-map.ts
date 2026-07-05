import { Clock, Effect, Schema } from "effect"
import {
	DeploymentEnvironment,
	ServiceCloudflareStatsRequest,
	ServiceDbEdgesForServiceRequest,
	ServiceDbEdgesRequest,
	ServiceDbQuerySummaryRequest,
	ServiceDependenciesBundleRequest,
	ServiceDependenciesForServiceRequest,
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

// Service-scoped variant used by the service-detail page's Dependencies tab.
// Hits a different API endpoint that pushes `SourceService = ?` into both
// branches of the underlying SQL (hourly MV + live topology JOIN), so the
// returned set is already trimmed to this service's outbound edges — no
// client-side filter needed.
export const getServiceMapForService = Effect.fn("QueryEngine.getServiceMapForService")(function* ({
	data,
}: {
	data: GetServiceMapForServiceInput
}) {
	const input = yield* decodeInput(GetServiceMapForServiceInputSchema, data, "getServiceMapForService")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

	const result = yield* runWarehouseQuery("serviceDependenciesForService", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceDependenciesForService({
				payload: new ServiceDependenciesForServiceRequest({
					serviceName: input.serviceName,
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
// Cloudflare direct-integration nodes
//
// The analytics poller writes zone / Worker metrics under synthetic service
// names (`cloudflare/{zone}`, `cloudflare-worker/{script}`) with no spans, so
// they never appear on the trace-derived map. This surfaces them as
// first-class CF nodes.
// ---------------------------------------------------------------------------

const ZONE_SERVICE_PREFIX = "cloudflare/"
const WORKER_SERVICE_PREFIX = "cloudflare-worker/"

export interface CloudflareService {
	serviceName: string
	kind: "zone" | "worker"
	displayName: string
	requests: number
	throughput: number
	errorRate: number
	/** Zones only. */
	cacheHitRate?: number
	/** Zones: edge TTFB p95. Workers: wall-time duration p99. */
	latencyP95Ms: number
	/** Zones only: origin response duration p95. */
	originP95Ms?: number
	/** Workers only: CPU time p99. */
	cpuP99Ms?: number
}

function transformCloudflareService(row: Record<string, unknown>, durationSeconds: number): CloudflareService {
	const serviceName = String(row.serviceName ?? "")
	const isWorker = serviceName.startsWith(WORKER_SERVICE_PREFIX)
	const displayName = isWorker
		? serviceName.slice(WORKER_SERVICE_PREFIX.length)
		: serviceName.startsWith(ZONE_SERVICE_PREFIX)
			? serviceName.slice(ZONE_SERVICE_PREFIX.length)
			: serviceName
	const requests = Number(row.requests ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const cacheHitCount = Number(row.cacheHitCount ?? 0)
	const safeDuration = Math.max(durationSeconds, 1)
	return {
		serviceName,
		kind: isWorker ? "worker" : "zone",
		displayName,
		requests,
		throughput: requests / safeDuration,
		errorRate: requests > 0 ? errorCount / requests : 0,
		cacheHitRate: isWorker ? undefined : requests > 0 ? cacheHitCount / requests : 0,
		latencyP95Ms: Number(row.latencyP95Ms ?? 0),
		originP95Ms: isWorker ? undefined : Number(row.originP95Ms ?? 0),
		cpuP99Ms: isWorker ? Number(row.cpuP99Ms ?? 0) : undefined,
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

// Service-scoped variant: pre-filters by `ServiceName = ?` server-side so the
// raw-traces fallback branch only scans this service's Client/Producer spans
// in the in-progress hour, not every span in the org.
export const getServiceMapDbEdgesForService = Effect.fn("QueryEngine.getServiceMapDbEdgesForService")(
	function* ({ data }: { data: GetServiceMapForServiceInput }) {
		const input = yield* decodeInput(
			GetServiceMapForServiceInputSchema,
			data,
			"getServiceMapDbEdgesForService",
		)
		const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

		const result = yield* runWarehouseQuery("serviceDbEdgesForService", () =>
			Effect.gen(function* () {
				const client = yield* MapleApiAtomClient
				return yield* client.queryEngine.serviceDbEdgesForService({
					payload: new ServiceDbEdgesForServiceRequest({
						serviceName: input.serviceName,
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
	},
)

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
