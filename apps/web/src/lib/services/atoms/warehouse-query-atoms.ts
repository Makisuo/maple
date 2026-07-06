import { Atom } from "@/lib/effect-atom"
import { Effect, Schema } from "effect"
import { encodeKey } from "@/lib/cache-key"
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
import { getLog, getLogAttributeKeys, getLogsFacetValues, getLogsFacets, listLogs } from "@/api/warehouse/logs"
import {
	getMetricAttributeKeys,
	getMetricAttributeValues,
	getMetricTimeSeries,
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
import {
	getServiceDependenciesBundle,
	getServiceMap,
	getServiceMapCloudflare,
	getServiceMapDbEdges,
	getServiceDbQuerySummary,
	getServicePlatforms,
} from "@/api/warehouse/service-map"
import { getServiceWorkloads } from "@/api/warehouse/service-infra"
import {
	getCloudflareWorkers,
	getCloudflareWorkerTimeseries,
	getCloudflareZoneDetail,
	getCloudflareZones,
	getCloudflareZoneTimeseries,
} from "@/api/warehouse/cloudflare-infra"
import { getServiceHealthBaseline, getServiceOverview, getServicesFacets } from "@/api/warehouse/services"
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
import {
	getReplay,
	getReplayEvents,
	getReplaysFacets,
	getReplaysForTrace,
	getSessionTranscript,
	getSessionTraceSummaries,
	listReplays,
} from "@/api/warehouse/replays"

/**
 * The error union every warehouse server function fails with: the structured
 * `WarehouseApiError` family plus tagged `@maple/http/errors/*` backend errors.
 */
type QueryError = WarehouseApiError | BackendError

type QueryEffect<Input, Output> = (input: Input) => Effect.Effect<Output, QueryError, never>

interface QueryAtomOptions {
	staleTime?: number
}

class QueryAtomError extends Schema.TaggedErrorClass<QueryAtomError>()("@maple/web/services/QueryAtomError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Unknown),
}) {}

// The error union surfaced to atom consumers: the structured query errors plus
// any tagged backend error, all normalized through `QueryAtomError`'s shape for
// anything that is not already a known tagged error.
export type QueryAtomFailure = QueryError | QueryAtomError

const isTaggedBackendError = (error: QueryError): boolean => error._tag.startsWith("@maple/http/errors/")

const toQueryAtomError = (error: QueryError): QueryAtomFailure => {
	// Tagged `@maple/http/errors/*` errors are already user-presentable via
	// `formatBackendError`; pass them through untouched.
	if (isTaggedBackendError(error)) return error
	// Remaining: a structured `WarehouseApiError`, all of which carry `message`.
	const message = "message" in error ? error.message : "Warehouse query atom failed"
	return new QueryAtomError({
		message,
		cause: error,
	})
}

function makeQueryAtomFamily<Input, Output>(query: QueryEffect<Input, Output>, options?: QueryAtomOptions) {
	const UnknownFromJson = Schema.fromJsonString(Schema.Unknown)

	const family = Atom.family((key: string) => {
		// Build on the mounted `MapleApiAtomClient.runtime` (not bare `Atom.make`,
		// which runs on the default atom runtime). That runtime owns the Maple OTLP
		// tracer that actually flushes, so the wrapper span each `query` opens — e.g.
		// `QueryEngine.getCustomChartServiceDetail`, the composite that fans out to
		// several `executeQueryEngine` calls — is exported instead of silently
		// dropped, which is what left traces rootless (a child whose parent never
		// shipped). The inner query spans already export by re-providing this same
		// (memoized) layer; this lifts the parent onto the same tracer.
		let resultAtom = MapleApiAtomClient.runtime.atom(
			Schema.decodeUnknownEffect(UnknownFromJson)(key).pipe(
				Effect.flatMap((input) => query(input as Input)),
				Effect.mapError(toQueryAtomError),
			),
		)

		if (options?.staleTime !== undefined) {
			resultAtom = Atom.setIdleTTL(resultAtom, options.staleTime)
		}

		return resultAtom
	})

	return (input: Input) => family(encodeKey(input))
}

export const getServiceUsageResultAtom = makeQueryAtomFamily(getServiceUsage, {
	staleTime: 60_000,
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

export const getSpanHierarchyResultAtom = makeQueryAtomFamily(getSpanHierarchy)

export const listReplaysResultAtom = makeQueryAtomFamily(listReplays, {
	staleTime: 30_000,
})

export const replaysFacetsResultAtom = makeQueryAtomFamily(getReplaysFacets, {
	staleTime: 30_000,
})

export const getReplayResultAtom = makeQueryAtomFamily(getReplay, {
	staleTime: 60_000,
})

export const getSessionTraceSummariesResultAtom = makeQueryAtomFamily(getSessionTraceSummaries, {
	staleTime: 60_000,
})

// Idle TTL keeps the chunks (and their inline rrweb events) stable across the
// player's frequent re-renders so the decode memo in the player context isn't
// thrown away and re-run. Events come straight from ClickHouse — no R2, no
// signed URLs, no client-side fetch/gunzip.
export const getReplayEventsResultAtom = makeQueryAtomFamily(getReplayEvents, {
	staleTime: 240_000,
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

export const getMetricTimeSeriesResultAtom = makeQueryAtomFamily(getMetricTimeSeries, {
	staleTime: 30_000,
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

export const cloudflareWorkerTimeseriesResultAtom = makeQueryAtomFamily(getCloudflareWorkerTimeseries, {
	staleTime: 30_000,
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

export const getServiceMapResultAtom = makeQueryAtomFamily(getServiceMap, {
	staleTime: 15_000,
})

// Service-detail Dependencies tab bundle: service edges + DB edges + external
// edges in one fetch (replaces the three separate *ForService atoms).
export const getServiceDependenciesBundleResultAtom = makeQueryAtomFamily(getServiceDependenciesBundle, {
	staleTime: 15_000,
})

export const getServiceMapDbEdgesResultAtom = makeQueryAtomFamily(getServiceMapDbEdges, {
	staleTime: 15_000,
})

export const getServiceMapCloudflareResultAtom = makeQueryAtomFamily(getServiceMapCloudflare, {
	staleTime: 15_000,
})

export const getServiceDbQuerySummaryResultAtom = makeQueryAtomFamily(getServiceDbQuerySummary, {
	staleTime: 15_000,
})

export const getServicePlatformsResultAtom = makeQueryAtomFamily(getServicePlatforms, {
	staleTime: 60_000,
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
