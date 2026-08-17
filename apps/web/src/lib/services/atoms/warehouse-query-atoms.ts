import { Atom } from "@/lib/effect-atom"
import { Effect, Schema } from "effect"
import { encodeOrgScopedKey, identityFromKey, orgScopedKeyPayload } from "@/lib/cache-key"
import { nextRetentionNamespace, withRetention } from "@/lib/services/atoms/retained-atom"
import { getActiveOrgId } from "@/lib/services/common/auth-headers"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import type { BackendError, WarehouseApiError } from "@/api/warehouse/effect-utils"
import {
	getCustomChartServiceSparklines,
	getCustomChartTimeSeries,
	getOverviewThroughputRefinement,
	getOverviewTimeSeries,
	getServiceDetailOverview,
	getServiceDetailThroughputRefinement,
} from "@/api/warehouse/custom-charts"
import {
	getErrorDetailTraces,
	getErrorsByType,
	getErrorsFacets,
	getErrorsSummary,
	getErrorsTimeseries,
} from "@/api/warehouse/errors"
import {
	getLog,
	getLogAttributeKeys,
	getLogsFacetValues,
	getLogsFacets,
	listLogs,
} from "@/api/warehouse/logs"
import {
	getMetricAttributeKeys,
	getMetricSparklines,
	getMetricAttributeValues,
	getMetricsSummary,
	listMetrics,
} from "@/api/warehouse/metrics"
import {
	fleetUtilizationTimeseries,
	getNodeFacets,
	getPodFacets,
	getWorkloadFacets,
	hostDetailSummary,
	hostInfraTimeseries,
	listHosts,
	listPods,
	podsSummary,
	podDetailSummary,
	podInfraTimeseries,
	listNodes,
	nodeDetailSummary,
	nodeInfraTimeseries,
	listWorkloads,
	workloadDetailSummary,
	workloadInfraTimeseries,
} from "@/api/warehouse/infra"
import { getServiceUsage } from "@/api/warehouse/service-usage"
import { getServiceOperations } from "@/api/warehouse/service-operations"
import {
	getServiceDependenciesBundle,
	getServiceMapBundle,
	getPlanetScaleBranchStats,
	getServiceMapCloudflare,
	getServiceMapPlanetScale,
	getServiceDbQuerySummary,
} from "@/api/warehouse/service-map"
import { getServiceWorkloads } from "@/api/warehouse/service-infra"
import {
	getCloudflarePlatformResources,
	getCloudflareTopTraffic,
	getCloudflareWorkers,
	getCloudflareZoneBreakdown,
	getCloudflareZoneDetail,
	getCloudflareZoneDns,
	getCloudflareZoneFacets,
	getCloudflareZones,
	getCloudflareZoneSecurity,
	getCloudflareZoneTimeseries,
} from "@/api/warehouse/cloudflare-infra"
import {
	getPlanetScaleEvents,
	getPlanetScaleInfraTimeseries,
	getPlanetScaleQueryInsights,
} from "@/api/warehouse/planetscale-infra"
import {
	getServiceHealthBaseline,
	getServiceHealthSnapshot,
	getServiceOverview,
	getServicesFacets,
} from "@/api/warehouse/services"
import {
	getResourceAttributeKeys,
	getResourceAttributeValues,
	getSpanAttributeKeys,
	getSpanAttributeValues,
	getSpanDetail,
	getSpanHierarchy,
	getTracesFacetValues,
	getTracesFacets,
	listTraces,
} from "@/api/warehouse/traces"
import { getQueryBuilderTimeseries } from "@/api/warehouse/query-builder-timeseries"
import { getQueryBuilderBreakdown } from "@/api/warehouse/query-builder-breakdown"
import {
	getReplay,
	getReplayEvents,
	getReplayManifest,
	getReplaysFacets,
	getReplaysForTrace,
	getSessionTranscript,
	getSessionTraceSummaries,
	listReplays,
} from "@/api/warehouse/replays"
import {
	getAgentSessionsFacets,
	listAgentSessions,
	listAgentTraces,
} from "@/api/warehouse/agent-sessions"
import {
	getWebAnalyticsBreakdowns,
	getWebAnalyticsPages,
	getWebAnalyticsPageviews,
	getWebAnalyticsSummary,
	getWebAnalyticsTimeseries,
} from "@/api/warehouse/web-analytics"

/**
 * The error union every warehouse server function fails with: the structured
 * `WarehouseApiError` family plus tagged `@maple/http/errors/*` backend errors.
 */
type QueryError = WarehouseApiError | BackendError

type QueryEffect<Input, Output> = (input: Input) => Effect.Effect<Output, QueryError, never>

interface QueryAtomOptions {
	staleTime?: number
}

class QueryAtomError extends Schema.TaggedError<QueryAtomError>()("@maple/web/services/QueryAtomError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Unknown),
}) {}

// Query failures already carry a useful local, v1, or v2 shape. Only cache-key
// decoding needs an atom-local wrapper.
export type QueryAtomFailure = QueryError | QueryAtomError

function makeQueryAtomFamily<Input, Output>(query: QueryEffect<Input, Output>, options?: QueryAtomOptions) {
	const UnknownFromJson = Schema.fromJsonString(Schema.Unknown)
	// Namespaces this family's retained results. Without it, two queries taking
	// only a time window would share a logical identity and hand each other's
	// rows back as fallbacks.
	const namespace = nextRetentionNamespace()

	const family = Atom.family((key: string) => {
		// The same query under a different time window, so a remount onto a
		// rolled-over key renders the previous window's data immediately rather
		// than an empty skeleton. See `withRetention`.
		const identity = `${namespace}:${identityFromKey(key)}`

		// Build on the mounted `MapleApiAtomClient.runtime` (not bare `Atom.make`,
		// which runs on the default atom runtime). That runtime owns the Maple OTLP
		// tracer that actually flushes, so the wrapper span each `query` opens — e.g.
		// `QueryEngine.getCustomChartServiceDetail`, the composite that fans out to
		// several `executeQueryEngine` calls — is exported instead of silently
		// dropped, which is what left traces rootless (a child whose parent never
		// shipped). The inner query spans already export by re-providing this same
		// (memoized) layer; this lifts the parent onto the same tracer.
		let resultAtom = MapleApiAtomClient.runtime.atom(
			Schema.decodeEffect(UnknownFromJson)(orgScopedKeyPayload(key)).pipe(
				Effect.mapError(
					(cause) =>
						new QueryAtomError({
							message: "Invalid warehouse query cache key",
							cause,
						}),
				),
				Effect.flatMap((input) => query(input as Input)),
			),
		)

		if (options?.staleTime !== undefined) {
			resultAtom = Atom.setIdleTTL(resultAtom, options.staleTime)
		}

		// Applied at the atom rather than in a hook so that every consumer gets it
		// — `useAtomValue`, `useRefreshableAtomValue` and
		// `useRetainedRefreshableResultValue` alike — with no call-site changes.
		return withRetention(resultAtom, identity)
	})

	return (input: Input) => family(encodeOrgScopedKey(getActiveOrgId(), input))
}

export const getServiceUsageResultAtom = makeQueryAtomFamily(getServiceUsage, {
	staleTime: 60_000,
})

export const getServiceOperationsResultAtom = makeQueryAtomFamily(getServiceOperations, {
	staleTime: 30_000,
})

export const getServicesFacetsResultAtom = makeQueryAtomFamily(getServicesFacets, {
	// 5 min idle TTL — environments / commit SHAs / service names move slowly,
	// and the dashboard route now reuses this atom for demo-detection (was a
	// separate serviceOverview probe). Cross-route navigation stays warm.
	staleTime: 300_000,
})

export const getServiceOverviewResultAtom = makeQueryAtomFamily(getServiceOverview, {
	staleTime: 30_000,
})

export const getServiceHealthSnapshotResultAtom = makeQueryAtomFamily(getServiceHealthSnapshot, {
	staleTime: 30_000,
})

export const getServiceHealthBaselineResultAtom = makeQueryAtomFamily(getServiceHealthBaseline, {
	// The trailing-7d latency baseline moves slowly and the request payload is
	// hour-snapped, so keep it warm far longer than the live overview.
	staleTime: 30 * 60_000,
})

export const getCustomChartServiceSparklinesResultAtom = makeQueryAtomFamily(
	getCustomChartServiceSparklines,
	{
		staleTime: 30_000,
	},
)

export const listTracesResultAtom = makeQueryAtomFamily(listTraces, {
	staleTime: 30_000,
})

export const getTracesFacetsResultAtom = makeQueryAtomFamily(getTracesFacets, {
	staleTime: 30_000,
})

// Single-dimension facet list for dashboard variables — server compiles only
// the requested UNION branch, so this never triggers the full facets scan.
export const getTracesFacetValuesResultAtom = makeQueryAtomFamily(getTracesFacetValues, {
	staleTime: 30_000,
})

// Trace spans are near-immutable once ingested — keep the most expensive
// detail query warm across back-navigation instead of refetching every mount.
export const getSpanHierarchyResultAtom = makeQueryAtomFamily(getSpanHierarchy, {
	staleTime: 60_000,
})

export const listReplaysResultAtom = makeQueryAtomFamily(listReplays, {
	staleTime: 30_000,
})

export const replaysFacetsResultAtom = makeQueryAtomFamily(getReplaysFacets, {
	staleTime: 30_000,
})

export const listAgentSessionsResultAtom = makeQueryAtomFamily(listAgentSessions, {
	staleTime: 30_000,
})

export const listAgentTracesResultAtom = makeQueryAtomFamily(listAgentTraces, {
	staleTime: 30_000,
})

export const agentSessionsFacetsResultAtom = makeQueryAtomFamily(getAgentSessionsFacets, {
	staleTime: 30_000,
})

// Web analytics — one page, five atoms, all 30s. Traffic numbers are watched
// during a launch, so a longer TTL reads as a stalled page; a shorter one just
// re-runs the same 30-day-TTL scans.
export const webAnalyticsSummaryResultAtom = makeQueryAtomFamily(getWebAnalyticsSummary, {
	staleTime: 30_000,
})

export const webAnalyticsTimeseriesResultAtom = makeQueryAtomFamily(getWebAnalyticsTimeseries, {
	staleTime: 30_000,
})

export const webAnalyticsPageviewsResultAtom = makeQueryAtomFamily(getWebAnalyticsPageviews, {
	staleTime: 30_000,
})

export const webAnalyticsPagesResultAtom = makeQueryAtomFamily(getWebAnalyticsPages, {
	staleTime: 30_000,
})

export const webAnalyticsBreakdownsResultAtom = makeQueryAtomFamily(getWebAnalyticsBreakdowns, {
	staleTime: 30_000,
})

export const getReplayResultAtom = makeQueryAtomFamily(getReplay, {
	staleTime: 60_000,
})

export const getSessionTraceSummariesResultAtom = makeQueryAtomFamily(getSessionTraceSummaries, {
	staleTime: 60_000,
})

// The session's chunk timeline without payloads. Cheap enough to fetch on every
// replay open, and the prerequisite for every payload range.
export const getReplayManifestResultAtom = makeQueryAtomFamily(getReplayManifest, {
	staleTime: 240_000,
})

// One entry per chunk range. Held far longer than a normal list query because a
// chunk row is immutable once written (plain MergeTree, 30-day TTL) — so
// scrubbing back over an already-played stretch must never refetch it.
//
// Idle TTL also keeps the chunks stable across the player's frequent
// re-renders, so the decode memo in the player context isn't thrown away.
export const getReplayEventsResultAtom = makeQueryAtomFamily(getReplayEvents, {
	staleTime: 600_000,
})

// Distilled session transcript (console/network/error/nav/click) for the panels.
export const getSessionTranscriptResultAtom = makeQueryAtomFamily(getSessionTranscript, {
	staleTime: 60_000,
})

export const getReplaysForTraceResultAtom = makeQueryAtomFamily(getReplaysForTrace, {
	staleTime: 60_000,
})

export const getSpanDetailResultAtom = makeQueryAtomFamily(getSpanDetail, {
	staleTime: 60_000,
})

export const listLogsResultAtom = makeQueryAtomFamily(listLogs, {
	staleTime: 30_000,
})

export const getLogResultAtom = makeQueryAtomFamily(getLog, {
	staleTime: 60_000,
})

export const getLogsFacetsResultAtom = makeQueryAtomFamily(getLogsFacets, {
	staleTime: 30_000,
})

export const getLogsFacetValuesResultAtom = makeQueryAtomFamily(getLogsFacetValues, {
	staleTime: 30_000,
})

export const getErrorsByTypeResultAtom = makeQueryAtomFamily(getErrorsByType, {
	staleTime: 60_000,
})

export const getErrorDetailTracesResultAtom = makeQueryAtomFamily(getErrorDetailTraces, {
	staleTime: 120_000,
})

export const getErrorsFacetsResultAtom = makeQueryAtomFamily(getErrorsFacets, {
	staleTime: 60_000,
})

export const getErrorsSummaryResultAtom = makeQueryAtomFamily(getErrorsSummary, {
	staleTime: 60_000,
})

export const getErrorsTimeseriesResultAtom = makeQueryAtomFamily(getErrorsTimeseries, {
	staleTime: 30_000,
})

export const listMetricsResultAtom = makeQueryAtomFamily(listMetrics, {
	staleTime: 30_000,
})

export const getMetricsSummaryResultAtom = makeQueryAtomFamily(getMetricsSummary, {
	staleTime: 60_000,
})

export const getMetricSparklinesResultAtom = makeQueryAtomFamily(getMetricSparklines, {
	staleTime: 60_000,
})

export const getMetricAttributeKeysResultAtom = makeQueryAtomFamily(getMetricAttributeKeys, {
	staleTime: 60_000,
})

export const getMetricAttributeValuesResultAtom = makeQueryAtomFamily(getMetricAttributeValues, {
	staleTime: 60_000,
})

export const listHostsResultAtom = makeQueryAtomFamily(listHosts, {
	staleTime: 30_000,
})

export const hostDetailSummaryResultAtom = makeQueryAtomFamily(hostDetailSummary, {
	staleTime: 30_000,
})

export const hostInfraTimeseriesResultAtom = makeQueryAtomFamily(hostInfraTimeseries, {
	staleTime: 30_000,
})

export const fleetUtilizationTimeseriesResultAtom = makeQueryAtomFamily(fleetUtilizationTimeseries, {
	staleTime: 30_000,
})

export const listPodsResultAtom = makeQueryAtomFamily(listPods, {
	staleTime: 30_000,
})

export const podsSummaryResultAtom = makeQueryAtomFamily(podsSummary, {
	staleTime: 30_000,
})

export const podDetailSummaryResultAtom = makeQueryAtomFamily(podDetailSummary, {
	staleTime: 30_000,
})

export const podInfraTimeseriesResultAtom = makeQueryAtomFamily(podInfraTimeseries, {
	staleTime: 30_000,
})

export const listNodesResultAtom = makeQueryAtomFamily(listNodes, {
	staleTime: 30_000,
})

export const nodeDetailSummaryResultAtom = makeQueryAtomFamily(nodeDetailSummary, {
	staleTime: 30_000,
})

export const nodeInfraTimeseriesResultAtom = makeQueryAtomFamily(nodeInfraTimeseries, {
	staleTime: 30_000,
})

export const listWorkloadsResultAtom = makeQueryAtomFamily(listWorkloads, {
	staleTime: 30_000,
})

export const workloadDetailSummaryResultAtom = makeQueryAtomFamily(workloadDetailSummary, {
	staleTime: 30_000,
})

export const workloadInfraTimeseriesResultAtom = makeQueryAtomFamily(workloadInfraTimeseries, {
	staleTime: 30_000,
})

export const podFacetsResultAtom = makeQueryAtomFamily(getPodFacets, {
	staleTime: 30_000,
})

export const nodeFacetsResultAtom = makeQueryAtomFamily(getNodeFacets, {
	staleTime: 30_000,
})

export const workloadFacetsResultAtom = makeQueryAtomFamily(getWorkloadFacets, {
	staleTime: 30_000,
})

// Cloudflare infrastructure page (/infra/cloudflare): per-zone HTTP edge
// analytics + per-Worker invocation analytics from the direct integration.
export const cloudflareZonesResultAtom = makeQueryAtomFamily(getCloudflareZones, {
	staleTime: 30_000,
})

export const cloudflareZoneTimeseriesResultAtom = makeQueryAtomFamily(getCloudflareZoneTimeseries, {
	staleTime: 30_000,
})

export const cloudflareZoneDetailResultAtom = makeQueryAtomFamily(getCloudflareZoneDetail, {
	staleTime: 30_000,
})

export const cloudflareWorkersResultAtom = makeQueryAtomFamily(getCloudflareWorkers, {
	staleTime: 30_000,
})

export const cloudflareZoneSecurityResultAtom = makeQueryAtomFamily(getCloudflareZoneSecurity, {
	staleTime: 30_000,
})

export const cloudflareZoneDnsResultAtom = makeQueryAtomFamily(getCloudflareZoneDns, {
	staleTime: 30_000,
})

export const cloudflarePlatformResourcesResultAtom = makeQueryAtomFamily(getCloudflarePlatformResources, {
	staleTime: 30_000,
})

export const cloudflareZoneBreakdownResultAtom = makeQueryAtomFamily(getCloudflareZoneBreakdown, {
	staleTime: 30_000,
})

export const cloudflareZoneFacetsResultAtom = makeQueryAtomFamily(getCloudflareZoneFacets, {
	staleTime: 30_000,
})

// Live Cloudflare GraphQL proxy — server edge-caches ~60s, so match that here.
export const cloudflareTopTrafficResultAtom = makeQueryAtomFamily(getCloudflareTopTraffic, {
	staleTime: 60_000,
})

// Service-detail Overview tab bundle: primary chart + releases timeline +
// environments in one fetch. The chart grid and the environment switcher read
// this atom with the same input key, so they share a single round-trip.
export const getServiceDetailOverviewResultAtom = makeQueryAtomFamily(getServiceDetailOverview, {
	staleTime: 30_000,
})

export const getOverviewTimeSeriesResultAtom = makeQueryAtomFamily(getOverviewTimeSeries, {
	staleTime: 30_000,
})

// Non-blocking exact pre-sampling throughput overlays. Keyed (via the encoded
// input) on `samplingActive`, so they only issue the slow SpanMetrics query once
// the primary chart confirms sampling is active; otherwise they resolve empty.
export const getServiceDetailThroughputRefinementResultAtom = makeQueryAtomFamily(
	getServiceDetailThroughputRefinement,
	{ staleTime: 30_000 },
)

export const getOverviewThroughputRefinementResultAtom = makeQueryAtomFamily(
	getOverviewThroughputRefinement,
	{ staleTime: 30_000 },
)

export const getCustomChartTimeSeriesResultAtom = makeQueryAtomFamily(getCustomChartTimeSeries, {
	staleTime: 30_000,
})

export const getQueryBuilderTimeseriesResultAtom = makeQueryAtomFamily(getQueryBuilderTimeseries, {
	staleTime: 30_000,
})

export const getQueryBuilderBreakdownResultAtom = makeQueryAtomFamily(getQueryBuilderBreakdown, {
	staleTime: 30_000,
})

export const getServiceMapBundleResultAtom = makeQueryAtomFamily(getServiceMapBundle, {
	staleTime: 15_000,
})

// Service-detail Dependencies tab bundle: service edges + DB edges + external
// edges in one fetch (replaces the three separate *ForService atoms).
export const getServiceDependenciesBundleResultAtom = makeQueryAtomFamily(getServiceDependenciesBundle, {
	staleTime: 15_000,
})

export const getServiceMapCloudflareResultAtom = makeQueryAtomFamily(getServiceMapCloudflare, {
	staleTime: 15_000,
})

export const getServiceMapPlanetScaleResultAtom = makeQueryAtomFamily(getServiceMapPlanetScale, {
	staleTime: 15_000,
})

export const planetscaleInfraTimeseriesResultAtom = makeQueryAtomFamily(getPlanetScaleInfraTimeseries, {
	staleTime: 15_000,
})

export const planetscaleQueryInsightsResultAtom = makeQueryAtomFamily(getPlanetScaleQueryInsights, {
	// Server-side edge cache is 60s; match it so refreshes don't hammer PlanetScale.
	staleTime: 60_000,
})

export const planetscaleEventsResultAtom = makeQueryAtomFamily(getPlanetScaleEvents, {
	// Server-side edge cache is 30s — a deploy marker showing up late is the
	// visible failure mode, so this stays tighter than the other PlanetScale reads.
	staleTime: 30_000,
})

export const getPlanetScaleBranchStatsResultAtom = makeQueryAtomFamily(getPlanetScaleBranchStats, {
	staleTime: 15_000,
})

export const getServiceDbQuerySummaryResultAtom = makeQueryAtomFamily(getServiceDbQuerySummary, {
	staleTime: 15_000,
})

export const getServiceWorkloadsResultAtom = makeQueryAtomFamily(getServiceWorkloads, {
	staleTime: 30_000,
})

export const getSpanAttributeKeysResultAtom = makeQueryAtomFamily(getSpanAttributeKeys, {
	staleTime: 60_000,
})

export const getSpanAttributeValuesResultAtom = makeQueryAtomFamily(getSpanAttributeValues, {
	staleTime: 30_000,
})

export const getResourceAttributeKeysResultAtom = makeQueryAtomFamily(getResourceAttributeKeys, {
	staleTime: 60_000,
})

export const getResourceAttributeValuesResultAtom = makeQueryAtomFamily(getResourceAttributeValues, {
	staleTime: 30_000,
})

export const getLogAttributeKeysResultAtom = makeQueryAtomFamily(getLogAttributeKeys, {
	staleTime: 60_000,
})
