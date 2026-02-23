import { Atom } from "@effect-atom/atom-react"
import { Effect, Schema } from "effect"
import {
  getCustomChartServiceDetail,
  getCustomChartServiceSparklines,
  getCustomChartTimeSeries,
  getOverviewTimeSeries,
} from "@/api/tinybird/custom-charts"
import { getHttpEndpointsOverview } from "@/api/tinybird/endpoints-overview"
import {
  getErrorDetailTraces,
  getErrorsByType,
  getErrorsFacets,
  getErrorsSummary,
} from "@/api/tinybird/errors"
import { getLogsFacets, listLogs } from "@/api/tinybird/logs"
import { getMetricTimeSeries, getMetricsSummary, listMetrics } from "@/api/tinybird/metrics"
import { getServiceUsage } from "@/api/tinybird/service-usage"
import { getServiceMap } from "@/api/tinybird/service-map"
import {
  getServiceApdexTimeSeries,
  getServiceOverview,
  getServicesFacets,
} from "@/api/tinybird/services"
import { getResourceAttributeKeys, getResourceAttributeValues, getSpanAttributeKeys, getSpanAttributeValues, getSpanHierarchy, getTracesFacets, listTraces } from "@/api/tinybird/traces"
import { getQueryBuilderTimeseries } from "@/api/tinybird/query-builder-timeseries"

type QueryEffect<Input, Output> = (input: Input) => Effect.Effect<Output, unknown>

interface QueryAtomOptions {
  staleTime?: number
}

class QueryAtomError extends Schema.TaggedError<QueryAtomError>()("QueryAtomError", {
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

function normalizeForKey(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForKey)
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))

  const normalized: Record<string, unknown> = {}
  for (const [key, entryValue] of entries) {
    normalized[key] = normalizeForKey(entryValue)
  }

  return normalized
}

function encodeKey(value: unknown): string {
  const normalized = normalizeForKey(value)
  return JSON.stringify(normalized === undefined ? null : normalized)
}

function makeQueryAtomFamily<Input, Output>(
  query: QueryEffect<Input, Output>,
  options?: QueryAtomOptions,
) {
  const family = Atom.family((key: string) => {
    let resultAtom = Atom.make(
      Effect.try({
        try: () => JSON.parse(key) as Input,
        catch: toQueryAtomError,
      }).pipe(
        Effect.flatMap((input) => query(input)),
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
  staleTime: 30_000,
})

export const getErrorDetailTracesResultAtom = makeQueryAtomFamily(getErrorDetailTraces, {
  staleTime: 30_000,
})

export const getErrorsFacetsResultAtom = makeQueryAtomFamily(getErrorsFacets, {
  staleTime: 30_000,
})

export const getErrorsSummaryResultAtom = makeQueryAtomFamily(getErrorsSummary, {
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

export const getServiceApdexTimeSeriesResultAtom = makeQueryAtomFamily(
  getServiceApdexTimeSeries,
  {
    staleTime: 30_000,
  },
)

export const getCustomChartServiceDetailResultAtom = makeQueryAtomFamily(
  getCustomChartServiceDetail,
  {
    staleTime: 30_000,
  },
)

export const getOverviewTimeSeriesResultAtom = makeQueryAtomFamily(getOverviewTimeSeries, {
  staleTime: 30_000,
})

export const getCustomChartTimeSeriesResultAtom = makeQueryAtomFamily(
  getCustomChartTimeSeries,
  {
    staleTime: 30_000,
  },
)

export const getQueryBuilderTimeseriesResultAtom = makeQueryAtomFamily(
  getQueryBuilderTimeseries,
  {
    staleTime: 30_000,
  },
)

export const getServiceMapResultAtom = makeQueryAtomFamily(getServiceMap, {
  staleTime: 15_000,
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

export const getHttpEndpointsOverviewResultAtom = makeQueryAtomFamily(
  getHttpEndpointsOverview,
  {
    staleTime: 30_000,
  },
)
