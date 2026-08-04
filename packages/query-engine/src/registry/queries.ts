import type {
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
} from "@maple/domain/http"
import { Match } from "effect"
import * as CH from "../ch"
import { LOGS_BODY_SEARCH_SETTINGS } from "../profiles"
import { makeDirectRouteCachePolicy } from "../runtime/query-engine"
import { defineQuery } from "./query-def"

/**
 * The declarative warehouse query registry.
 *
 * Each entry replaces the profile/context/error-label/cache wiring that used to
 * be repeated inline in every handler in `apps/api/src/routes/v1/query-engine.http.ts`.
 * Handlers keep their own row-to-response mapping; see `QueryDef` for why
 * decoding is deliberately out of scope here.
 *
 * Migration is incremental and the two surfaces coexist: a handler either takes
 * a `QueryDef` through `runQuery` or keeps its inline wiring. Nothing breaks
 * while entries are added.
 *
 * Cache values below are carried over EXACTLY as the handlers had them, so this
 * pilot changes no caching behaviour — `cache: undefined` here means the handler
 * was uncached before, not that being uncached is correct. Turning any of those
 * on is a separate, separately-reviewed change with a justified TTL.
 */

export const errorsByType = defineQuery({
	id: "errorsByType",
	profile: "aggregation",
	// Was uncached inline. Preserved as-is: changing it belongs in its own commit.
	cache: undefined,
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
	cache: undefined,
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
				// Matches the handler's previous inline default. The builder needs a
				// bucket width and the request treats it as optional.
				bucketSeconds: payload.bucketSeconds ?? 3600,
			},
		),
})

/** Single-row: the handler reads this through `runQueryFirst`. */
export const errorsSummary = defineQuery({
	id: "errorsSummary",
	profile: "aggregation",
	cache: undefined,
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
	cache: undefined,
	// The builder takes no options — this query is scoped entirely by org and
	// time range. The payload still carries the range.
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
	// v2: rows gained per-commit `firstSeen`; the version bump keeps pre-upgrade
	// cached rows (missing the field) from being served. Carried over verbatim
	// from the handler — do not renumber without the same reasoning.
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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

export const listLogs = defineQuery({
	id: "listLogs",
	profile: "list",
	settings: (payload) => (payload.search ? LOGS_BODY_SEARCH_SETTINGS : undefined),
	cache: 15,
	compile: (payload: ListLogsRequest, orgId: string) =>
		CH.compile(
			CH.logsListQuery({
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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
	cache: undefined,
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

// --- Sub-queries of composite (bundle) handlers ---------------------------
//
// Bundle endpoints run several queries in one Worker invocation so per-org
// config resolves once and the browser makes one round-trip instead of three.
// Each sub-query keeps its own id, because that id is both its span context and
// its cache-key prefix -- collapsing them under the bundle's name would merge
// unrelated cache entries.
//
// Their payload types are the MINIMAL input each needs rather than the bundle's
// full payload. That is load-bearing: `runQuery` keys the cache on whatever
// payload it is handed, so typing these narrowly reproduces the exact key the
// hand-written `cachedDirect` calls used.

/** Release markers for the service detail overview chart. Uncached, mirroring the standalone path. */
export const serviceReleases = defineQuery({
	id: "serviceReleases",
	profile: "list",
	cache: undefined,
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

/** Environments a service reported in the window. Edge-cached on a service-scoped key. */
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

/**
 * External (non-service) edges for the dependencies tab.
 *
 * Built by `serviceExternalEdgesSQL`, which returns a CompiledQuery directly
 * rather than going through `CH.compile`.
 */
export const serviceExternalEdges = defineQuery({
	id: "serviceExternalEdges",
	profile: "aggregation",
	cache: undefined,
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

/**
 * Service usage totals.
 *
 * Two builders behind one id: with both previous-window bounds the query
 * returns current-vs-previous in a single scan, otherwise just the current
 * window. The branch lives in `compile` so the id, profile and TTL stay one
 * decision.
 */
export const serviceUsage = defineQuery({
	id: "serviceUsage",
	profile: "aggregation",
	// Usage totals (GB / session counts) tolerate a minute of staleness; a 60s
	// TTL cuts repeat-load recomputes ~4x vs 15s.
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
