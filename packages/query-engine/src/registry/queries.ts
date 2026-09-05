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
	ErrorsSparkRequest,
	ContainerDetailSummaryRequest,
	ContainerFacetsRequest,
	ContainersSummaryRequest,
	HostDetailSummaryRequest,
	ListContainersRequest,
	InfraPresenceRequest,
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
	ReleasesListRequest,
	ReleaseDetailRequest,
	WorkloadDetailSummaryRequest,
	WebAnalyticsSummaryRequest,
	WebAnalyticsLiveRequest,
	WebAnalyticsTimeseriesRequest,
	WebAnalyticsPageviewsRequest,
	WebAnalyticsPagesRequest,
	WebAnalyticsEventsRequest,
	WebAnalyticsBreakdownsRequest,
} from "@maple/domain/http"
import { Match } from "effect"
import { WEB_ANALYTICS_LIVE_WINDOW_SECONDS } from "@maple/domain/query-engine"
import { formatWarehouseDateTime } from "../datetime"
import { attributeIndexMode, logBodySearchMode } from "../capabilities"
import * as CH from "../ch"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { makeTimeRangeCachePolicy, timeRangeCache } from "../runtime/query-engine"
import { defineQuery } from "./query-definition"

export { logsCount, logsTimeseries } from "./logs"
export { productEventsFunnel, productEventsFunnelBreakdown, productEventNames } from "./product-events"

/**
 * Declarative compile, execution, and cache policy. Handlers retain response
 * shaping.
 *
 * `cache: timeRangeCache` derives TTL and cache-key snap window from the
 * query's own time range — see `makeTimeRangeCachePolicy`. It replaced a flat
 * 15s, which snapped the key as fast as the entry expired and therefore hit
 * zero times in 73 production reads. Slow-changing discovery dimensions keep
 * their explicit 60s/3600s TTLs. `cache: undefined` means an outer
 * `cachedDirect` owns the operation.
 */

export const errorsByType = defineQuery({
	id: "errorsByType",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ErrorsByTypeRequest, orgId: string) =>
		CH.compile(
			CH.errorsByTypeQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
				errorLabels: payload.errorLabels,
				serviceVersions: payload.serviceVersions,
				excludedServices: payload.excludedServices,
				excludedDeploymentEnvs: payload.excludedDeploymentEnvs,
				excludedErrorLabels: payload.excludedErrorLabels,
				excludedServiceVersions: payload.excludedServiceVersions,
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorsTimeseries = defineQuery({
	id: "errorsTimeseries",
	profile: "aggregation",
	cache: timeRangeCache,
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

export const errorsSpark = defineQuery({
	id: "errorsSpark",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ErrorsSparkRequest, orgId: string) =>
		CH.compile(
			CH.errorsSparkQuery({
				fingerprintHashes: payload.fingerprintHashes,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				errorLabels: payload.errorLabels,
				serviceVersions: payload.serviceVersions,
				excludedServices: payload.excludedServices,
				excludedDeploymentEnvs: payload.excludedDeploymentEnvs,
				excludedErrorLabels: payload.excludedErrorLabels,
				excludedServiceVersions: payload.excludedServiceVersions,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				// Optional buckets default to one hour, as errorsTimeseries does.
				bucketSeconds: payload.bucketSeconds ?? 3600,
			},
		),
})

export const errorsSummary = defineQuery({
	id: "errorsSummary",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ErrorsSummaryRequest, orgId: string) =>
		CH.compile(
			CH.errorsSummaryQuery({
				rootOnly: payload.rootOnly,
				services: payload.services,
				deploymentEnvs: payload.deploymentEnvs,
				fingerprintHashes: payload.fingerprintHashes,
				errorLabels: payload.errorLabels,
				serviceVersions: payload.serviceVersions,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorRateByService = defineQuery({
	id: "errorRateByService",
	profile: "aggregation",
	cache: timeRangeCache,
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
	// v2 prevented cached rows without firstSeen from being served. v3 is the
	// (service, environment) collapse: the response schema is a permissive
	// `Schema.Record(String, Unknown)`, so a stale v2 row deserializes cleanly and
	// renders a services list with no commits and no latency. The bump is the only
	// thing standing between a deploy and that.
	cache: makeTimeRangeCachePolicy({ version: 3 }),
	compile: (payload: ServiceOverviewRequest, orgId: string) =>
		CH.compile(
			CH.serviceOverviewQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
				commitShas: payload.commitShas,
				excludedEnvironments: payload.excludedEnvironments,
				excludedNamespaces: payload.excludedNamespaces,
				excludedCommitShas: payload.excludedCommitShas,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const errorDetailTraces = defineQuery({
	id: "errorDetailTraces",
	profile: "list",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	compile: (payload: ServiceHealthSnapshotRequest, orgId: string) =>
		CH.compile(CH.serviceHealthSnapshotQuery({ environments: payload.environments }), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
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
	cache: timeRangeCache,
	compile: (payload: ServiceApdexRequest, orgId: string) => {
		const bucketSeconds = payload.bucketSeconds ?? 60
		return CH.compile(
			CH.serviceApdexTimeseriesQuery({
				serviceName: payload.serviceName,
				apdexThresholdMs: payload.apdexThresholdMs,
				bucketSeconds,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds,
			},
		)
	},
})

export const serviceDependenciesForService = defineQuery({
	id: "serviceDependenciesForService",
	profile: "aggregation",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	capabilityAware: true,
	compile: (payload: ListLogsRequest, orgId: string, capabilities) =>
		CH.compile(
			CH.logsListQuery({
				attributeIndexMode: attributeIndexMode(capabilities, "logs"),
				bodySearchMode: logBodySearchMode(capabilities),
				serviceName: payload.service,
				severity: payload.severity,
				serviceNames: payload.services,
				severities: payload.severities,
				excludedServiceNames: payload.excludedServices,
				excludedSeverities: payload.excludedSeverities,
				excludedEnvironments: payload.excludedDeploymentEnvs,
				excludedNamespaces: payload.excludedNamespaces,
				minSeverity: payload.minSeverity,
				traceId: payload.traceId,
				spanId: payload.spanId,
				cursor: payload.cursor,
				search: payload.search,
				// The array spelling wins when present; the scalar stays for the dashboard
				// read-model plans, which select exactly one.
				environments: payload.deploymentEnvs?.length
					? payload.deploymentEnvs
					: payload.deploymentEnv
						? [payload.deploymentEnv]
						: undefined,
				namespaces: payload.namespaces?.length
					? payload.namespaces
					: payload.namespace
						? [payload.namespace]
						: undefined,
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

/**
 * Sidebar gate: which Infrastructure surfaces this org reports. Runs on every
 * page load, so it is cached generously — a surface appearing or disappearing
 * is not something the nav has to notice within the minute, and the probe's
 * whole value is that it costs less than the pages it hides.
 */
export const infraPresence = defineQuery({
	id: "infraPresence",
	profile: "discovery",
	cache: 300,
	compile: (payload: InfraPresenceRequest, orgId: string) =>
		CH.compileUnion(CH.infraPresenceQuery(), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const listHosts = defineQuery({
	id: "listHosts",
	profile: "list",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	compile: (payload: PodsSummaryRequest, orgId: string) =>
		CH.compile(
			CH.listPodsSummaryQuery({
				namespaces: payload.namespaces,
				clusters: payload.clusters,
				environments: payload.environments,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const podDetailSummary = defineQuery({
	id: "podDetailSummary",
	profile: "aggregation",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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

// Releases page. The list and the timeline share one payload so the bundle
// handler forwards it to both; the detail reuses the list query scoped to one
// service, which is the comparison table.
export const releasesList = defineQuery({
	id: "releasesList",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ReleasesListRequest, orgId: string) =>
		CH.compile(
			CH.releasesListQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
				serviceNames: payload.services,
				excludedEnvironments: payload.excludedEnvironments,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: CH.releasesListRowSchema },
		),
})

export const releasesTimeline = defineQuery({
	id: "releasesTimeline",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ReleasesListRequest, orgId: string) =>
		CH.compile(
			CH.releasesTimelineQuery({
				environments: payload.environments,
				namespaces: payload.namespaces,
				serviceNames: payload.services,
				excludedEnvironments: payload.excludedEnvironments,
				bucketSeconds: payload.bucketSeconds,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds,
			},
		),
})

export const releaseVersions = defineQuery({
	id: "releaseVersions",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ReleaseDetailRequest, orgId: string) =>
		CH.compile(
			CH.releasesListQuery({
				serviceName: payload.serviceName,
				environments: payload.environments,
				limit: 100,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
			{ rowSchema: CH.releasesListRowSchema },
		),
})

export const releaseTimeline = defineQuery({
	id: "releaseTimeline",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ReleaseDetailRequest, orgId: string) =>
		CH.compile(
			CH.releasesTimelineQuery({
				serviceName: payload.serviceName,
				environments: payload.environments,
				bucketSeconds: payload.bucketSeconds,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds: payload.bucketSeconds,
			},
		),
})

export const releaseErrorFingerprints = defineQuery({
	id: "releaseErrorFingerprints",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ReleaseDetailRequest, orgId: string) =>
		CH.compile(
			CH.releaseErrorFingerprintsQuery({
				serviceName: payload.serviceName,
				environments: payload.environments,
			}),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				serviceVersion: payload.commitSha,
			},
			{ rowSchema: CH.releaseErrorFingerprintsRowSchema },
		),
})

// Bundle subqueries keep distinct ids and minimal payloads to preserve standalone cache keys.
export const serviceReleases = defineQuery({
	id: "serviceReleases",
	profile: "list",
	cache: timeRangeCache,
	compile: (
		payload: {
			readonly serviceName: string
			readonly startTime: string
			readonly endTime: string
			readonly releasesBucketSeconds?: number | undefined
		},
		orgId: string,
	) => {
		const bucketSeconds = payload.releasesBucketSeconds ?? 300
		return CH.compile(
			CH.serviceReleasesTimelineQuery({ serviceName: payload.serviceName, bucketSeconds }),
			{
				orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				bucketSeconds,
			},
		)
	},
})

export const serviceEnvironments = defineQuery({
	id: "serviceEnvironments",
	profile: "discovery",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	compile: (payload: ServiceDependenciesRequest, orgId: string) =>
		CH.serviceDependenciesSQL(
			{ deploymentEnv: payload.deploymentEnv },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceDbEdges = defineQuery({
	id: "serviceDbEdges",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ServiceDbEdgesRequest, orgId: string) =>
		CH.serviceDbEdgesSQL(
			{ deploymentEnv: payload.deploymentEnv },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const serviceWorkloads = defineQuery({
	id: "serviceWorkloads",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ServiceWorkloadsRequest, orgId: string) =>
		CH.serviceWorkloadsSQL(
			{ services: payload.services },
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const servicePlatforms = defineQuery({
	id: "servicePlatforms",
	profile: "aggregation",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	compile: (payload: ServiceDbQuerySummaryRequest, orgId: string) =>
		CH.serviceDbQuerySummarySQL(dbQueryParams(payload, orgId)),
})

export const serviceDbQueryTimeseries = defineQuery({
	id: "serviceDbQueryTimeseries",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ServiceDbQuerySummaryRequest, orgId: string) =>
		CH.serviceDbQueryTimeseriesSQL(dbQueryParams(payload, orgId)),
})

export const serviceDbTopQueries = defineQuery({
	id: "serviceDbTopQueries",
	profile: "aggregation",
	cache: timeRangeCache,
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
		readonly traffic?: "all" | "humans" | "bots"
		readonly eventName?: string
	},
	useProductEvents: boolean,
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
	traffic: payload.traffic,
	eventName: payload.eventName,
	useProductEvents,
})

// Rollup/raw pairs share ids and cache keys because parity tests require identical results.

const webAnalyticsSummaryDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsSummary" as const,
	profile: "aggregation" as const,
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsSummaryRequest, orgId: string) =>
		CH.compile(CH.webAnalyticsSummaryQuery(webAnalyticsFilters(payload, useProductEvents)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const webAnalyticsSummary = defineQuery(webAnalyticsSummaryDef(true))
export const webAnalyticsSummaryRaw = defineQuery(webAnalyticsSummaryDef(false))

/**
 * How far back the live counter's `StartTime` floor reaches.
 *
 * The floor only prunes partitions — recency is decided by `LastActivityAt`
 * inside the query — so it has to sit behind the longest session that could
 * still be active. A day is far past any real browser session and still scans a
 * single org's sessions for one day.
 */
const LIVE_LOOKBACK_SECONDS = 86_400

/**
 * The window ends at *now*, resolved here rather than sent by the client.
 *
 * That is what makes the counter live: the payload carries only filters, so its
 * cache key holds still while every poll re-resolves the window. Freshness is
 * the 15s TTL instead of the key churning on each request — the opposite of the
 * time-range queries, whose key must move with the range being asked about.
 */
const webAnalyticsLiveDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsLive" as const,
	profile: "aggregation" as const,
	cache: 15,
	compile: (payload: WebAnalyticsLiveRequest, orgId: string) => {
		const now = Date.now()
		return CH.compile(
			CH.webAnalyticsLiveQuery({
				...webAnalyticsFilters(payload, useProductEvents),
				windowSeconds: WEB_ANALYTICS_LIVE_WINDOW_SECONDS,
			}),
			{
				orgId,
				startTime: formatWarehouseDateTime(now - LIVE_LOOKBACK_SECONDS * 1000),
				endTime: formatWarehouseDateTime(now),
			},
		)
	},
})

export const webAnalyticsLive = defineQuery(webAnalyticsLiveDef(true))
export const webAnalyticsLiveRaw = defineQuery(webAnalyticsLiveDef(false))

const webAnalyticsTimeseriesDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsTimeseries" as const,
	profile: "aggregation" as const,
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsTimeseriesRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsTimeseriesQuery({
				...webAnalyticsFilters(payload, useProductEvents),
				bucketSeconds: payload.bucketSeconds,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsTimeseries = defineQuery(webAnalyticsTimeseriesDef(true))
export const webAnalyticsTimeseriesRaw = defineQuery(webAnalyticsTimeseriesDef(false))

const webAnalyticsPageviewsDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsPageviews" as const,
	profile: "aggregation" as const,
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsPageviewsRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsPageviewsTimeseriesQuery({
				...webAnalyticsFilters(payload, useProductEvents),
				bucketSeconds: payload.bucketSeconds,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsPageviews = defineQuery(webAnalyticsPageviewsDef(true))
export const webAnalyticsPageviewsRaw = defineQuery(webAnalyticsPageviewsDef(false))

const webAnalyticsPagesDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsPages" as const,
	profile: "aggregation" as const,
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsPagesRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsPagesQuery({
				...webAnalyticsFilters(payload, useProductEvents),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsPages = defineQuery(webAnalyticsPagesDef(true))
export const webAnalyticsPagesRaw = defineQuery(webAnalyticsPagesDef(false))

const webAnalyticsEventsDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsEvents" as const,
	profile: "aggregation" as const,
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsEventsRequest, orgId: string) =>
		CH.compile(
			CH.webAnalyticsEventsQuery({
				...webAnalyticsFilters(payload, useProductEvents),
				limit: payload.limit,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const webAnalyticsEvents = defineQuery(webAnalyticsEventsDef(true))
export const webAnalyticsEventsRaw = defineQuery(webAnalyticsEventsDef(false))

const webAnalyticsBreakdownsDef = (useProductEvents: boolean) => ({
	id: "webAnalyticsBreakdowns" as const,
	profile: "aggregation" as const,
	// Bound memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: timeRangeCache,
	compile: (payload: WebAnalyticsBreakdownsRequest, orgId: string) =>
		CH.compileUnion(
			CH.webAnalyticsBreakdownsQuery({
				...webAnalyticsFilters(payload, useProductEvents),
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
				excludedPodNames: payload.excludedPodNames,
				excludedNamespaces: payload.excludedNamespaces,
				excludedNodeNames: payload.excludedNodeNames,
				excludedClusters: payload.excludedClusters,
				excludedDeployments: payload.excludedDeployments,
				excludedStatefulsets: payload.excludedStatefulsets,
				excludedDaemonsets: payload.excludedDaemonsets,
				excludedJobs: payload.excludedJobs,
				excludedEnvironments: payload.excludedEnvironments,
				excludedComputeTypes: payload.excludedComputeTypes,
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
	excludedPodNames: payload.excludedPodNames,
	excludedNamespaces: payload.excludedNamespaces,
	excludedNodeNames: payload.excludedNodeNames,
	excludedClusters: payload.excludedClusters,
	excludedDeployments: payload.excludedDeployments,
	excludedStatefulsets: payload.excludedStatefulsets,
	excludedDaemonsets: payload.excludedDaemonsets,
	excludedJobs: payload.excludedJobs,
	excludedEnvironments: payload.excludedEnvironments,
	excludedComputeTypes: payload.excludedComputeTypes,
	workloadKind: payload.workloadKind,
	workloadName: payload.workloadName,
	// Lifecycle rides with the filters, not the scope: the denominator has to
	// count the same slice of the fleet the page is showing.
	lifecycle: payload.lifecycle,
})

export const listPods = defineQuery({
	id: "listPods",
	profile: "list",
	cache: timeRangeCache,
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
	cache: timeRangeCache,
	compile: (payload: ListPodsRequest, orgId: string) =>
		CH.compile(CH.listPodsSummaryQuery(listPodsFilters(payload)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

// Containers (Docker) — keep page and denominator filters identical.
const listContainersFilters = (payload: ListContainersRequest | ContainerFacetsRequest) => ({
	search: payload.search,
	containerNames: payload.containerNames,
	hostNames: payload.hostNames,
	images: payload.images,
	composeProjects: payload.composeProjects,
	composeServices: payload.composeServices,
	environments: payload.environments,
	excludedContainerNames: payload.excludedContainerNames,
	excludedHostNames: payload.excludedHostNames,
	excludedImages: payload.excludedImages,
	excludedComposeProjects: payload.excludedComposeProjects,
	excludedComposeServices: payload.excludedComposeServices,
	excludedEnvironments: payload.excludedEnvironments,
})

export const listContainers = defineQuery({
	id: "listContainers",
	profile: "list",
	cache: timeRangeCache,
	compile: (payload: ListContainersRequest, orgId: string) =>
		CH.compile(
			CH.listContainersQuery({
				...listContainersFilters(payload),
				scope: payload.scope,
				sortBy: payload.sortBy,
				sortDir: payload.sortDir,
				limit: payload.limit,
				offset: payload.offset,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const listContainersCount = defineQuery({
	id: "listContainersCount",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ListContainersRequest, orgId: string) =>
		CH.compile(CH.listContainersSummaryQuery(listContainersFilters(payload)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
})

export const containersSummary = defineQuery({
	id: "containersSummary",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ContainersSummaryRequest, orgId: string) =>
		CH.compile(
			CH.listContainersSummaryQuery({
				hostNames: payload.hostNames,
				environments: payload.environments,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const containerDetailSummary = defineQuery({
	id: "containerDetailSummary",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ContainerDetailSummaryRequest, orgId: string) =>
		CH.compile(
			CH.containerDetailSummaryQuery({
				containerName: payload.containerName,
				hostName: payload.hostName,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const containerCountersSummary = defineQuery({
	id: "containerCountersSummary",
	profile: "aggregation",
	cache: timeRangeCache,
	compile: (payload: ContainerDetailSummaryRequest, orgId: string) =>
		CH.compile(
			CH.containerCountersSummaryQuery({
				containerName: payload.containerName,
				hostName: payload.hostName,
			}),
			{ orgId, startTime: payload.startTime, endTime: payload.endTime },
		),
})

export const containerFacets = defineQuery({
	id: "containerFacets",
	profile: "discovery",
	// Bound Map-column decompression memory across the UNION fan-out.
	settings: { maxThreads: 4 },
	cache: 60,
	compile: (payload: ContainerFacetsRequest, orgId: string) =>
		CH.compileUnion(CH.containerFacetsQuery(listContainersFilters(payload)), {
			orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
		}),
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

/**
 * The API tab. Same splice, same rollup tables, same cost — the only difference
 * is the HTTP-endpoint predicate, so the raw fallback and its 10s ceiling apply
 * identically. Its own id keeps the cache entries separate from the unfiltered
 * Operations tab reading the same window.
 */
export const serviceEndpointsSummary = defineQuery({
	id: "serviceEndpoints",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceOperationsRequest, orgId: string) =>
		CH.compile(
			CH.serviceEndpointsSummaryQuery(serviceOperationsSummaryOptions(payload)),
			serviceOperationsParams(payload, orgId),
			{ rowSchema: CH.serviceEndpointsSummaryRowSchema },
		),
})

export const serviceEndpointsSummaryRaw = defineQuery({
	id: "serviceEndpoints",
	profile: "aggregation",
	settings: SERVICE_OPERATIONS_RAW_SETTINGS,
	cache: undefined,
	compile: (payload: ServiceOperationsRequest, orgId: string) =>
		CH.compile(
			CH.serviceEndpointsSummaryRawQuery(serviceOperationsSummaryOptions(payload)),
			serviceOperationsParams(payload, orgId),
			{ rowSchema: CH.serviceEndpointsSummaryRowSchema },
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
		CH.compile(CH.serviceOperationsTimeseriesQuery(serviceOperationsTimeseriesOptions(payload)), {
			...serviceOperationsParams(payload, orgId),
			bucketSeconds: payload.bucketSeconds,
		}),
})

export const serviceOperationsTimeseriesRaw = defineQuery({
	id: "serviceOperationsTimeseries",
	profile: "aggregation",
	settings: SERVICE_OPERATIONS_RAW_SETTINGS,
	cache: undefined,
	compile: (payload: ServiceOperationsTimeseriesInput, orgId: string) =>
		CH.compile(CH.serviceOperationsTimeseriesRawQuery(serviceOperationsTimeseriesOptions(payload)), {
			...serviceOperationsParams(payload, orgId),
			bucketSeconds: payload.bucketSeconds,
		}),
})
