import type {
	ServiceOperationsRequest,
	ListPodsRequest,
	NodeFacetsRequest,
	PodFacetsRequest,
	WorkloadFacetsRequest,
	ServiceDbQuerySummaryRequest,
	ServicePlatformsRequest,
	ServiceDbEdgesRequest,
	ServiceDependenciesRequest,
	ServiceWorkloadsRequest,
	ServiceUsageRequest,
	ErrorDetailTracesRequest,
	ErrorRateByServiceRequest,
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ErrorsTimeseriesRequest,
	HostDetailSummaryRequest,
	ListHostsRequest,
	ListLogsRequest,
	ListMetricsRequest,
	ListNodesRequest,
	ListWorkloadsRequest,
	MetricsSummaryRequest,
	NodeDetailSummaryRequest,
	PodDetailSummaryRequest,
	PodsSummaryRequest,
	ServiceApdexRequest,
	ServiceDbEdgesForServiceRequest,
	ServiceDependenciesForServiceRequest,
	ServiceHealthBaselineRequest,
	ServiceHealthSnapshotRequest,
	ServiceOverviewRequest,
	WorkloadDetailSummaryRequest,
	WebAnalyticsSummaryRequest,
	WebAnalyticsTimeseriesRequest,
	WebAnalyticsPageviewsRequest,
	WebAnalyticsPagesRequest,
	WebAnalyticsBreakdownsRequest,
} from "@maple/domain/http"
import { Match } from "effect"
import { attributeIndexMode, logBodySearchMode } from "../capabilities"
import * as CH from "../ch"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { makeDirectRouteCachePolicy } from "../runtime/query-engine"
import { defineQuery } from "./query-definition"

export { logsCount, logsTimeseries } from "./logs"

/**
 * Declarative compile, execution, and cache policy. Handlers retain response
 * shaping. Most TTLs are 15s; slow-changing discovery dimensions use 60s.
 * `cache: undefined` means an outer `cachedDirect` owns the operation.
 */

export const errorsByType = defineQuery({
	id: "errorsByType",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ErrorsByTypeRequest, orgId: string) =>
		CH.compile(
			CH.errorsByTypeQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorsTimeseries = defineQuery({
	id: "errorsTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ErrorsTimeseriesRequest, orgId: string) =>
		CH.compile(
			CH.errorsTimeseriesQuery({
				fingerprintHash: payload.fingerprintHash,
				services: payload.services,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				// Optional buckets default to one hour.
				bucketSeconds: payload.bucketSeconds ?? 3600,
			},
		),
})

export const errorsSummary = defineQuery({
	id: "errorsSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ErrorsSummaryRequest, orgId: string) =>
		CH.compile(
			CH.errorsSummaryQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorRateByService = defineQuery({
	id: "errorRateByService",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ErrorRateByServiceRequest, orgId: string) =>
		CH.compile(CH.errorRateByServiceQuery(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const serviceOverview = defineQuery({
	id: "serviceOverview",
	profile: "aggregation",
	// v2 prevents cached rows without firstSeen from being served.
	cache: makeDirectRouteCachePolicy({ ttlSeconds: 15, version: 2 }),
	compile: (payload: ServiceOverviewRequest, orgId: string) =>
		CH.compile(
			CH.serviceOverviewQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
				commitShas: payload.commitShas,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorDetailTraces = defineQuery({
	id: "errorDetailTraces",
	profile: "list",
	cache: 15,
	compile: (payload: ErrorDetailTracesRequest, orgId: string) =>
		CH.compile(
			CH.errorDetailTracesQuery({
				fingerprintHash: payload.fingerprintHash,
				rootOnly: payload.rootOnly,
				services: payload.services,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceHealthSnapshot = defineQuery({
	id: "serviceHealthSnapshot",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceHealthSnapshotRequest, orgId: string) =>
		CH.compile(
			CH.serviceHealthSnapshotQuery({ environments: payload.environments }),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: CH.serviceHealthSnapshotRowSchema },
		),
})

export const serviceHealthBaseline = defineQuery({
	id: "serviceHealthBaseline",
	profile: "aggregation",
	cache: 3600,
	compile: (payload: ServiceHealthBaselineRequest, orgId: string) =>
		CH.compile(
			CH.serviceHealthBaselineQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceApdex = defineQuery({
	id: "serviceApdex",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceApdexRequest, orgId: string) =>
		CH.compile(
			CH.serviceApdexTimeseriesQuery({
				serviceName: payload.serviceName,
				apdexThresholdMs: payload.apdexThresholdMs,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds ?? 60,
			},
		),
})

export const serviceDependenciesForService = defineQuery({
	id: "serviceDependenciesForService",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDependenciesForServiceRequest, orgId: string) =>
		CH.compile(
			CH.serviceDependenciesForServiceQuery({
				serviceName: payload.serviceName,
				deploymentEnv: payload.deploymentEnv,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
			},
		),
})

export const serviceDbEdgesForService = defineQuery({
	id: "serviceDbEdgesForService",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDbEdgesForServiceRequest, orgId: string) =>
		CH.compile(
			CH.serviceDbEdgesForServiceQuery({
				serviceName: payload.serviceName,
				deploymentEnv: payload.deploymentEnv,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
			},
		),
})

/** Capability-aware so dashboard search uses the same bloom/tokenbf plan as the CLI. */
export const listLogs = defineQuery({
	id: "listLogs",
	profile: "list",
	// TS resolves this before inferring Payload from the three-argument compile.
	settings: (payload: ListLogsRequest) => (payload.search ? LOGS_BODY_SEARCH_SETTINGS : undefined),
	cache: 15,
	capabilityAware: true,
	compile: (payload: ListLogsRequest, orgId: string, capabilities) =>
		CH.compile(
			CH.logsListQuery({
				attributeIndexMode: attributeIndexMode(capabilities, "logs"),
				bodySearchMode: logBodySearchMode(capabilities),
				serviceName: payload.service,
				severity: payload.severity,
				minSeverity: payload.minSeverity,
				traceId: payload.traceId,
				spanId: payload.spanId,
				cursor: payload.cursor,
				search: payload.search,
				environments: payload.deploymentEnv ? [payload.deploymentEnv] : undefined,
				namespaces: payload.namespace ? [payload.namespace] : undefined,
				matchModes: Match.value([
					payload.deploymentEnvMatchMode,
					payload.namespaceMatchMode,
				] as const).pipe(
					Match.when([undefined, undefined], () => undefined),
					Match.orElse(([deploymentEnv, serviceNamespace]) => ({
						deploymentEnv,
						serviceNamespace,
					})),
				),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const listMetrics = defineQuery({
	id: "listMetrics",
	profile: "discovery",
	cache: 60,
	compile: (payload: ListMetricsRequest, orgId: string) =>
		CH.compile(
			CH.listMetricsQuery({
				serviceName: payload.service,
				metricType: payload.metricType,
				search: payload.search,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const metricsSummary = defineQuery({
	id: "metricsSummary",
	profile: "discovery",
	cache: 60,
	compile: (payload: MetricsSummaryRequest, orgId: string) =>
		CH.compile(CH.metricsSummaryQuery({ serviceName: payload.service }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const listHosts = defineQuery({
	id: "listHosts",
	profile: "list",
	cache: 15,
	compile: (payload: ListHostsRequest, orgId: string) =>
		CH.compile(
			CH.listHostsQuery({
				search: payload.search,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const hostDetailSummary = defineQuery({
	id: "hostDetailSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: HostDetailSummaryRequest, orgId: string) =>
		CH.compile(CH.hostDetailSummaryQuery({ hostName: payload.hostName }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const podsSummary = defineQuery({
	id: "podsSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: PodsSummaryRequest, orgId: string) =>
		CH.compile(
			CH.listPodsSummaryQuery({
				namespaces: payload.namespaces,
				clusters: payload.clusters,
				environments: payload.environments,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: CH.ListPodsSummaryOutputSchema },
		),
})

export const podDetailSummary = defineQuery({
	id: "podDetailSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: PodDetailSummaryRequest, orgId: string) =>
		CH.compile(CH.podDetailSummaryQuery({ podName: payload.podName, namespace: payload.namespace }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const listNodes = defineQuery({
	id: "listNodes",
	profile: "list",
	cache: 15,
	compile: (payload: ListNodesRequest, orgId: string) =>
		CH.compile(
			CH.listNodesQuery({
				search: payload.search,
				nodeNames: payload.nodeNames,
				clusters: payload.clusters,
				environments: payload.environments,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const nodeDetailSummary = defineQuery({
	id: "nodeDetailSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: NodeDetailSummaryRequest, orgId: string) =>
		CH.compile(CH.nodeDetailSummaryQuery({ nodeName: payload.nodeName }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const listWorkloads = defineQuery({
	id: "listWorkloads",
	profile: "list",
	cache: 15,
	compile: (payload: ListWorkloadsRequest, orgId: string) =>
		CH.compile(
			CH.listWorkloadsQuery({
				kind: payload.kind,
				search: payload.search,
				workloadNames: payload.workloadNames,
				namespaces: payload.namespaces,
				clusters: payload.clusters,
				environments: payload.environments,
				computeTypes: payload.computeTypes,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const workloadDetailSummary = defineQuery({
	id: "workloadDetailSummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: WorkloadDetailSummaryRequest, orgId: string) =>
		CH.compile(
			CH.workloadDetailSummaryQuery({
				kind: payload.kind,
				workloadName: payload.workloadName,
				namespace: payload.namespace,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

// Bundle subqueries keep distinct ids and minimal payloads to preserve standalone cache keys.
export const serviceReleases = defineQuery({
	id: "serviceReleases",
	profile: "list",
	cache: 15,
	compile: (
		payload: {
			readonly serviceName: string
			readonly startTime: string
			readonly endTime: string
			readonly releasesBucketSeconds?: number | undefined
		},
		orgId: string,
	) =>
		CH.compile(CH.serviceReleasesTimelineQuery({ serviceName: payload.serviceName }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			bucketSeconds: payload.releasesBucketSeconds ?? 300,
		}),
})

export const serviceEnvironments = defineQuery({
	id: "serviceEnvironments",
	profile: "discovery",
	cache: 15,
	compile: (
		payload: { readonly serviceName: string; readonly startTime: string; readonly endTime: string },
		orgId: string,
	) =>
		CH.compile(CH.serviceEnvironmentsQuery({ serviceName: payload.serviceName }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const serviceExternalEdges = defineQuery({
	id: "serviceExternalEdges",
	profile: "aggregation",
	cache: 15,
	compile: (
		payload: {
			readonly serviceName: string
			readonly deploymentEnv?: string | undefined
			readonly startTime: string
			readonly endTime: string
		},
		orgId: string,
	) =>
		CH.serviceExternalEdgesSQL(
			{ deploymentEnv: payload.deploymentEnv, serviceName: payload.serviceName },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceUsage = defineQuery({
	id: "serviceUsage",
	profile: "aggregation",
	// Usage totals tolerate a minute of staleness.
	cache: 60,
	compile: (payload: ServiceUsageRequest, orgId: string) => {
		const prevStart = payload.previousStartTime
		const prevEnd = payload.previousEndTime
		return prevStart != null && prevEnd != null
			? CH.compile(CH.serviceUsageWithPreviousQuery({ serviceName: payload.service }), {
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
					previousStartTime: prevStart,
					previousEndTime: prevEnd,
				})
			: CH.compile(CH.serviceUsageQuery({ serviceName: payload.service }), {
					orgId,
					startTime: payload.startTime,
					endTime: payload.endTime,
				})
	},
})

export const serviceDependencies = defineQuery({
	id: "serviceDependencies",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDependenciesRequest, orgId: string) =>
		CH.serviceDependenciesSQL(
			{ deploymentEnv: payload.deploymentEnv },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceDbEdges = defineQuery({
	id: "serviceDbEdges",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDbEdgesRequest, orgId: string) =>
		CH.serviceDbEdgesSQL(
			{ deploymentEnv: payload.deploymentEnv },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceWorkloads = defineQuery({
	id: "serviceWorkloads",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceWorkloadsRequest, orgId: string) =>
		CH.serviceWorkloadsSQL(
			{ services: payload.services },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const servicePlatforms = defineQuery({
	id: "servicePlatforms",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServicePlatformsRequest, orgId: string) =>
		CH.servicePlatformsSQL(
			{ deploymentEnv: payload.deploymentEnv },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

const dbQueryParams = (payload: ServiceDbQuerySummaryRequest, orgId: string) => ({
	orgId,
	dbSystem: payload.dbSystem,
	dbNamespace: payload.dbNamespace,
	startTime: payload.startTime,
	endTime: payload.endTime,
	sourceService: payload.sourceService,
	deploymentEnv: payload.deploymentEnv,
	bucketSeconds: payload.bucketSeconds,
	topN: payload.topN,
})

export const serviceDbQuerySummary = defineQuery({
	id: "serviceDbQuerySummary",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDbQuerySummaryRequest, orgId: string) =>
		CH.serviceDbQuerySummarySQL(dbQueryParams(payload, orgId)),
})

export const serviceDbQueryTimeseries = defineQuery({
	id: "serviceDbQueryTimeseries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDbQuerySummaryRequest, orgId: string) =>
		CH.serviceDbQueryTimeseriesSQL(dbQueryParams(payload, orgId)),
})

export const serviceDbTopQueries = defineQuery({
	id: "serviceDbTopQueries",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ServiceDbQuerySummaryRequest, orgId: string) =>
		CH.serviceDbTopQueriesSQL(dbQueryParams(payload, orgId)),
})

const webAnalyticsFilters = (
	payload: {
		readonly host?: string
		readonly pagePath?: string
		readonly referrerHost?: string
		readonly country?: string
		readonly deviceType?: string
		readonly browserName?: string
		readonly osName?: string
		readonly language?: string
		readonly utmSource?: string
		readonly utmMedium?: string
		readonly utmCampaign?: string
		readonly visitorType?: "new" | "returning"
	},
	useWebEvents: boolean,
): CH.WebAnalyticsFilters => ({
	host: payload.host,
	pagePath: payload.pagePath,
	referrerHost: payload.referrerHost,
	country: payload.country,
	deviceType: payload.deviceType,
	browserName: payload.browserName,
	osName: payload.osName,
	language: payload.language,
	utmSource: payload.utmSource,
	utmMedium: payload.utmMedium,
	utmCampaign: payload.utmCampaign,
	visitorType: payload.visitorType,
	useWebEvents,
})

// Rollup/raw pairs share ids and cache keys because parity tests require identical results.

const webAnalyticsSummaryDef = (useWebEvents: boolean) => ({
	id: "webAnalyticsSummary" as const,
	profile: "aggregation" as const,
	cache: 15,
	compile: (payload: WebAnalyticsSummaryRequest, orgId: string) =>
		CH.compile(CH.webAnalyticsSummaryQuery(webAnalyticsFilters(payload, useWebEvents)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const webAnalyticsSummary = defineQuery(webAnalyticsSummaryDef(true))
export const webAnalyticsSummaryRaw = defineQuery(webAnalyticsSummaryDef(false))

const webAnalyticsTimeseriesDef = (useWebEvents: boolean) => ({
	id: "webAnalyticsTimeseries" as const,
	profile: "aggregation" as const,
	cache: 15,
	compile: (payload: WebAnalyticsTimeseriesRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsTimeseriesQuery({
				...webAnalyticsFilters(payload, useWebEvents),
				bucketSeconds: payload.bucketSeconds,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsTimeseries = defineQuery(webAnalyticsTimeseriesDef(true))
export const webAnalyticsTimeseriesRaw = defineQuery(webAnalyticsTimeseriesDef(false))

const webAnalyticsPageviewsDef = (useWebEvents: boolean) => ({
	id: "webAnalyticsPageviews" as const,
	profile: "aggregation" as const,
	cache: 15,
	compile: (payload: WebAnalyticsPageviewsRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsPageviewsTimeseriesQuery({
				...webAnalyticsFilters(payload, useWebEvents),
				bucketSeconds: payload.bucketSeconds,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsPageviews = defineQuery(webAnalyticsPageviewsDef(true))
export const webAnalyticsPageviewsRaw = defineQuery(webAnalyticsPageviewsDef(false))

const webAnalyticsPagesDef = (useWebEvents: boolean) => ({
	id: "webAnalyticsPages" as const,
	profile: "aggregation" as const,
	cache: 15,
	compile: (payload: WebAnalyticsPagesRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsPagesQuery({
				...webAnalyticsFilters(payload, useWebEvents),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsPages = defineQuery(webAnalyticsPagesDef(true))
export const webAnalyticsPagesRaw = defineQuery(webAnalyticsPagesDef(false))

const webAnalyticsBreakdownsDef = (useWebEvents: boolean) => ({
	id: "webAnalyticsBreakdowns" as const,
	profile: "aggregation" as const,
	// Bound memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: 15,
	compile: (payload: WebAnalyticsBreakdownsRequest, orgId: string) =>
		CH.compileUnion(
			CH.webAnalyticsBreakdownsQuery({
				...webAnalyticsFilters(payload, useWebEvents),
				limitPerDimension: payload.limitPerDimension,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsBreakdowns = defineQuery(webAnalyticsBreakdownsDef(true))
export const webAnalyticsBreakdownsRaw = defineQuery(webAnalyticsBreakdownsDef(false))

export const podFacets = defineQuery({
	id: "podFacets",
	profile: "discovery",
	// Bound Map-column decompression memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: 60,
	compile: (payload: PodFacetsRequest, orgId: string) =>
		CH.compileUnion(
			CH.podFacetsQuery({
				search: payload.search,
				podNames: payload.podNames,
				namespaces: payload.namespaces,
				nodeNames: payload.nodeNames,
				clusters: payload.clusters,
				deployments: payload.deployments,
				statefulsets: payload.statefulsets,
				daemonsets: payload.daemonsets,
				jobs: payload.jobs,
				environments: payload.environments,
				computeTypes: payload.computeTypes,
			}),
			{ orgId: orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const nodeFacets = defineQuery({
	id: "nodeFacets",
	profile: "discovery",
	// Bound Map-column decompression memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: 60,
	compile: (payload: NodeFacetsRequest, orgId: string) =>
		CH.compileUnion(
			CH.nodeFacetsQuery({
				search: payload.search,
				nodeNames: payload.nodeNames,
				clusters: payload.clusters,
				environments: payload.environments,
			}),
			{ orgId: orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const workloadFacets = defineQuery({
	id: "workloadFacets",
	profile: "discovery",
	// Bound Map-column decompression memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: 60,
	compile: (payload: WorkloadFacetsRequest, orgId: string) =>
		CH.compileUnion(
			CH.workloadFacetsQuery({
				kind: payload.kind,
				search: payload.search,
				workloadNames: payload.workloadNames,
				namespaces: payload.namespaces,
				clusters: payload.clusters,
				environments: payload.environments,
				computeTypes: payload.computeTypes,
			}),
			{ orgId: orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

// Keep page and denominator filters identical.
const listPodsFilters = (payload: ListPodsRequest) => ({
	search: payload.search,
	podNames: payload.podNames,
	namespaces: payload.namespaces,
	nodeNames: payload.nodeNames,
	clusters: payload.clusters,
	deployments: payload.deployments,
	statefulsets: payload.statefulsets,
	daemonsets: payload.daemonsets,
	jobs: payload.jobs,
	environments: payload.environments,
	computeTypes: payload.computeTypes,
	workloadKind: payload.workloadKind,
	workloadName: payload.workloadName,
})

export const listPods = defineQuery({
	id: "listPods",
	profile: "list",
	cache: 15,
	compile: (payload: ListPodsRequest, orgId: string) =>
		CH.compile(
			CH.listPodsQuery({
				...listPodsFilters(payload),
				scope: payload.scope,
				sortBy: payload.sortBy,
				sortDir: payload.sortDir,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const listPodsCount = defineQuery({
	id: "listPodsCount",
	profile: "aggregation",
	cache: 15,
	compile: (payload: ListPodsRequest, orgId: string) =>
		CH.compile(
			CH.listPodsSummaryQuery(listPodsFilters(payload)),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: CH.ListPodsSummaryOutputSchema },
		),
})

// Probes resolve a time bound so hierarchy reads avoid ~30 daily partitions.
// An outer cache owns the full sequence, so these definitions remain uncached.
export const spanHierarchyProbeRecent = defineQuery({
	id: "spanHierarchyProbeRecent",
	profile: "discovery",
	cache: undefined,
	compile: (payload: { readonly traceId: string; readonly startTime: string }, orgId: string) =>
		CH.compile(CH.traceTimeProbeQuery({ traceId: payload.traceId, narrowByTime: true }), {
			orgId,
			startTime: payload.startTime,
		}),
})

export const spanHierarchyProbe = defineQuery({
	id: "spanHierarchyProbe",
	profile: "discovery",
	cache: undefined,
	compile: (payload: { readonly traceId: string }, orgId: string) =>
		CH.compile(CH.traceTimeProbeQuery({ traceId: payload.traceId, narrowByTime: false }), {
			orgId,
		}),
})

export const spanHierarchy = defineQuery({
	id: "spanHierarchy",
	profile: "list",
	cache: undefined,
	compile: (
		payload: {
			readonly traceId: string
			readonly spanId?: string | undefined
			readonly startTime?: string | undefined
			readonly endTime?: string | undefined
		},
		orgId: string,
	) => {
		const narrowByTime = payload.startTime != null && payload.endTime != null
		return CH.compile(
			CH.spanHierarchyQuery({
				traceId: payload.traceId,
				spanId: payload.spanId,
				narrowByTime,
			}),
			narrowByTime ? { orgId, startTime: payload.startTime, endTime: payload.endTime } : { orgId },
		)
	},
})

// Rollup/raw pairs share ids and an outer cache; handlers fall back per org when migration 0008 is absent.

const serviceOperationsSummaryOptions = (payload: ServiceOperationsRequest) => ({
	serviceName: payload.serviceName,
	environments: payload.environments,
	limit: payload.limit,
})

const serviceOperationsParams = (payload: ServiceOperationsRequest, orgId: string) => ({
	orgId,
	startTime: payload.startTime,
	endTime: payload.endTime,
})

export const serviceOperationsSummary = defineQuery({
	id: "serviceOperations",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceOperationsRequest, orgId: string) =>
		CH.compile(
			CH.serviceOperationsSummaryQuery(serviceOperationsSummaryOptions(payload)),
			serviceOperationsParams(payload, orgId),
			{ rowSchema: CH.serviceOperationsSummaryRowSchema },
		),
})

/**
 * Raw fallback measured p50 12.8s with frequent 30s failures. Fail at 10s so
 * clusters missing migration 0008 receive a fast, actionable error.
 */
const SERVICE_OPERATIONS_RAW_SETTINGS = { maxExecutionTime: 10 }

export const serviceOperationsSummaryRaw = defineQuery({
	id: "serviceOperations",
	profile: "aggregation",
	settings: SERVICE_OPERATIONS_RAW_SETTINGS,
	cache: undefined,
	compile: (payload: ServiceOperationsRequest, orgId: string) =>
		CH.compile(
			CH.serviceOperationsSummaryRawQuery(serviceOperationsSummaryOptions(payload)),
			serviceOperationsParams(payload, orgId),
			{ rowSchema: CH.serviceOperationsSummaryRowSchema },
		),
})

// Derived after the summary; callers align buckets to the minute-grain rollup.
type ServiceOperationsTimeseriesInput = ServiceOperationsRequest & {
	readonly spanNames: ReadonlyArray<string>
	readonly bucketSeconds: number
}

const serviceOperationsTimeseriesOptions = (payload: ServiceOperationsTimeseriesInput) => ({
	serviceName: payload.serviceName,
	environments: payload.environments,
	spanNames: payload.spanNames,
	bucketSeconds: payload.bucketSeconds,
})

export const serviceOperationsTimeseries = defineQuery({
	id: "serviceOperationsTimeseries",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceOperationsTimeseriesInput, orgId: string) =>
		CH.compile(
			CH.serviceOperationsTimeseriesQuery(serviceOperationsTimeseriesOptions(payload)),
			{ ...serviceOperationsParams(payload, orgId), bucketSeconds: payload.bucketSeconds },
			{ rowSchema: CH.serviceOperationsTimeseriesRowSchema },
		),
})

export const serviceOperationsTimeseriesRaw = defineQuery({
	id: "serviceOperationsTimeseries",
	profile: "aggregation",
	settings: SERVICE_OPERATIONS_RAW_SETTINGS,
	cache: undefined,
	compile: (payload: ServiceOperationsTimeseriesInput, orgId: string) =>
		CH.compile(
			CH.serviceOperationsTimeseriesRawQuery(serviceOperationsTimeseriesOptions(payload)),
			{ ...serviceOperationsParams(payload, orgId), bucketSeconds: payload.bucketSeconds },
			{ rowSchema: CH.serviceOperationsTimeseriesRowSchema },
		),
})
