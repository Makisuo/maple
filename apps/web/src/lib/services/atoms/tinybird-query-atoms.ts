import { Atom } from "@/lib/effect-atom"
import { Effect, Schema } from "effect"
import { encodeKey } from "@/lib/cache-key"
import {
	getCustomChartServiceDetail,
	getCustomChartServiceSparklines,
	getCustomChartTimeSeries,
	getOverviewTimeSeries,
} from "@/api/tinybird/custom-charts"
import {
	getErrorDetailTraces,
	getErrorsByType,
	getErrorsFacets,
	getErrorsSummary,
	getErrorsTimeseries,
} from "@/api/tinybird/errors"
import { getLogsFacets, listLogs } from "@/api/tinybird/logs"
import {
	getMetricAttributeKeys,
	getMetricTimeSeries,
	getMetricsSummary,
	listMetrics,
} from "@/api/tinybird/metrics"
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
} from "@/api/tinybird/infra"
import { getServiceUsage } from "@/api/tinybird/service-usage"
import { getServiceMap } from "@/api/tinybird/service-map"
import { getServiceWorkloads } from "@/api/tinybird/service-infra"
import {
	getServiceApdexTimeSeries,
	getServiceOverview,
	getServiceReleasesTimeline,
	getServicesFacets,
} from "@/api/tinybird/services"
import {
	getResourceAttributeKeys,
	getResourceAttributeValues,
	getSpanAttributeKeys,
	getSpanAttributeValues,
	getSpanHierarchy,
	getTracesFacets,
	listTraces,
} from "@/api/tinybird/traces"
import { getQueryBuilderTimeseries } from "@/api/tinybird/query-builder-timeseries"

type QueryEffect<Input, Output> = (input: Input) => Effect.Effect<Output, unknown, unknown>

interface QueryAtomOptions {
	staleTime?: number
}

export class QueryAtomError extends Schema.TaggedErrorClass<QueryAtomError>()("QueryAtomError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown),
}) {}

const toQueryAtomError = (error: unknown): QueryAtomError => {
	if (error instanceof QueryAtomError) return error
	if (error instanceof Error) {
		return new QueryAtomError({
			message: error.message,
			cause: error,
		})
	}

	return new QueryAtomError({
		message: "Tinybird query atom failed",
		cause: error,
	})
}

function makeQueryAtomFamily<Input, Output>(query: QueryEffect<Input, Output>, options?: QueryAtomOptions) {
	const UnknownFromJson = Schema.fromJsonString(Schema.Unknown)

	const family = Atom.family((key: string) => {
		let resultAtom = Atom.make(
			Schema.decodeUnknownEffect(UnknownFromJson)(key).pipe(
				Effect.flatMap((input) => query(input as Input) as Effect.Effect<Output, unknown, never>),
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
	staleTime: 60_000,
})

export const getServiceOverviewResultAtom = makeQueryAtomFamily(getServiceOverview, {
	staleTime: 30_000,
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

export const getSpanHierarchyResultAtom = makeQueryAtomFamily(getSpanHierarchy)

export const listLogsResultAtom = makeQueryAtomFamily(listLogs, {
	staleTime: 30_000,
})

export const getLogsFacetsResultAtom = makeQueryAtomFamily(getLogsFacets, {
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

export const getServiceApdexTimeSeriesResultAtom = makeQueryAtomFamily(getServiceApdexTimeSeries, {
	staleTime: 30_000,
})

export const getServiceReleasesTimelineResultAtom = makeQueryAtomFamily(getServiceReleasesTimeline, {
	staleTime: 60_000,
})

export const getCustomChartServiceDetailResultAtom = makeQueryAtomFamily(getCustomChartServiceDetail, {
	staleTime: 30_000,
})

export const getOverviewTimeSeriesResultAtom = makeQueryAtomFamily(getOverviewTimeSeries, {
	staleTime: 30_000,
})

export const getCustomChartTimeSeriesResultAtom = makeQueryAtomFamily(getCustomChartTimeSeries, {
	staleTime: 30_000,
})

export const getQueryBuilderTimeseriesResultAtom = makeQueryAtomFamily(getQueryBuilderTimeseries, {
	staleTime: 30_000,
})

export const getServiceMapResultAtom = makeQueryAtomFamily(getServiceMap, {
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
