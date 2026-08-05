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
} from "@maple/domain/http"
import { Match } from "effect"
import { attributeIndexMode, logBodySearchMode } from "../capabilities"
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
 * ## Cache policy
 *
 * Every entry states a TTL. Two values do almost all the work:
 *
 * - **15s** — the house default, already proven on `serviceOverview`,
 *   `serviceHealthSnapshot`, `serviceApdex` and `listLogs`. Short enough that a
 *   panel never looks frozen, long enough to absorb the repeat loads that come
 *   from navigating between tabs of the same service.
 * - **60s** — dimension lists (facets, metric catalogues). These move on the
 *   scale of deploys, not requests, so a minute of staleness is invisible while
 *   the queries themselves are UNION fan-outs over wide Map columns.
 *
 * `cache: undefined` now means exactly one thing: the query runs inside an
 * outer `cachedDirect` in its handler, so caching it here would double-cache.
 * For `spanHierarchy`'s probes that is not merely redundant but wrong — they
 * exist to fire only on an outer miss, and caching them would run a probe on
 * every request. The seven such entries are commented individually.
 *
 * Anything that needs a different number should say why in a comment next to
 * it, the way `serviceUsage` (60s) and `serviceOverview` (15s, version 2) do.
 */

export const errorsByType = defineQuery({
	id: "errorsByType",
	profile: "aggregation",
	// Was uncached inline. Preserved as-is: changing it belongs in its own commit.
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

/**
 * Log search.
 *
 * `capabilityAware` closes a real gap rather than adding a nicety. The pipe path
 * (`list_logs`, which the `maple` CLI uses) has always passed these two modes,
 * so CLI log search gets bloom/tokenbf index acceleration while the dashboard's
 * HTTP path — compiling without capabilities — silently did full scans of the
 * same data. Same builder, same table, different plans.
 */
export const listLogs = defineQuery({
	id: "listLogs",
	profile: "list",
	// Annotated rather than inferred: with a three-parameter `compile`, TS
	// resolves this callback before it can pin `Payload` from `compile`.
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

// --- Service-map edge queries ---------------------------------------------
// These use `*SQL(opts, params)` builders, which return a CompiledQuery
// directly instead of going through `CH.compile`.

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

/**
 * Workloads backing a set of services.
 *
 * The caller must skip this entirely for an empty service list — that guard
 * stays in the handler because it avoids issuing a query at all, which a def
 * cannot express.
 */
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

// --- serviceDbQuerySummary's three sub-queries ----------------------------
// All three take the identical params object, so it is built once per def from
// the payload rather than threaded in from the handler.

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

/** Single-row: read through `runQueryFirst`. */
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

// --- Facet queries (UNION of per-dimension branches) ----------------------

export const podFacets = defineQuery({
	id: "podFacets",
	profile: "discovery",
	// Cap read-thread concurrency to bound Map-column decompression memory
	// across the fan-out of UNION branches.
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
	// Cap read-thread concurrency to bound Map-column decompression memory
	// across the fan-out of UNION branches.
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
	// Cap read-thread concurrency to bound Map-column decompression memory
	// across the fan-out of UNION branches.
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

// --- listPods: page + denominator -----------------------------------------
// Both run the same WHERE clause, so the "N of M" the list prints can never
// disagree with the rows above it. The shared filter projection keeps that
// true by construction rather than by two hand-kept copies.

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

/** Single-row denominator for listPods. Read through `runQueryFirst`. */
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

// --- spanHierarchy: probe, then the pruned hierarchy read -----------------
//
// `trace_detail_spans` is partitioned by toDate(Timestamp); without a time
// predicate the hierarchy query seeks every daily partition (~30) — p95 ~8.8s
// vs ~2.3s when pruned to one. When the caller has no timestamp (direct URL,
// shared link, AI link) a cheap LIMIT-1 probe resolves one.
//
// All three carry `cache: undefined` ON PURPOSE. The handler wraps the whole
// probe-then-read sequence in a single `cachedDirect`, so the probe only fires
// on an outer cache miss. Caching them individually would run the probe on
// every request and cache a result nobody asked for.

/** Probe restricted to the recent window — tries ~2 daily partitions first. */
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

/** Unbounded fallback probe: every partition, only when the recent one missed. */
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

// --- serviceOperations: rollup and raw variants ---------------------------
//
// Four defs, two logical queries. Each has a rollup form and a raw form, and
// the CHOICE between them stays in the handler because it is policy, not query
// construction: a feature flag selects the rollup, and a typed
// `isMissingServiceOperationsRollup` error falls back to raw at runtime,
// flipping a flag that the timeseries query then honors too.
//
// Rollup/raw pairs share an id, matching the context their spans already
// report — the fallback is recorded separately as `query.rollup.fallback`.
//
// All four are `cache: undefined`; the handler wraps the whole sequence in one
// `cachedDirect`.

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

/** Rollback path, used when the rollup table is absent or the flag is off. */
export const serviceOperationsSummaryRaw = defineQuery({
	id: "serviceOperations",
	profile: "aggregation",
	cache: undefined,
	compile: (payload: ServiceOperationsRequest, orgId: string) =>
		CH.compile(
			CH.serviceOperationsSummaryRawQuery(serviceOperationsSummaryOptions(payload)),
			serviceOperationsParams(payload, orgId),
			{ rowSchema: CH.serviceOperationsSummaryRowSchema },
		),
})

/**
 * `spanNames` and `bucketSeconds` ride in the payload: both are derived from the
 * summary rows and the requested window, so `compile` cannot see them. The
 * rollup is minute-grain, which is why the caller rounds the bucket to a whole
 * minute before passing it here.
 */
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
	cache: undefined,
	compile: (payload: ServiceOperationsTimeseriesInput, orgId: string) =>
		CH.compile(
			CH.serviceOperationsTimeseriesRawQuery(serviceOperationsTimeseriesOptions(payload)),
			{ ...serviceOperationsParams(payload, orgId), bucketSeconds: payload.bucketSeconds },
			{ rowSchema: CH.serviceOperationsTimeseriesRowSchema },
		),
})
