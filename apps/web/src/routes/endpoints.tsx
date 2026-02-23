import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { EndpointsTable } from "@/components/endpoints/endpoints-table"
import { EndpointsFilterSidebar, type EndpointsFacets } from "@/components/endpoints/endpoints-filter-sidebar"
import type { FilterOption } from "@/components/filters/filter-section"
import { TimeRangePicker } from "@/components/time-range-picker"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getHttpEndpointsOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

const endpointsSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  services: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  httpMethods: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export const Route = createFileRoute("/endpoints")({
  component: EndpointsPage,
  validateSearch: Schema.standardSchemaV1(endpointsSearchSchema),
})

function EndpointsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const handleTimeChange = ({
    startTime,
    endTime,
  }: {
    startTime?: string
    endTime?: string
  }) => {
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, startTime, endTime }),
    })
  }

  // Unfiltered overview for deriving facet counts
  const unfilteredResult = useAtomValue(
    getHttpEndpointsOverviewResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const facets = useMemo((): EndpointsFacets | undefined => {
    if (!Result.isSuccess(unfilteredResult)) return undefined
    const data = unfilteredResult.value.data

    const serviceMap = new Map<string, number>()
    const methodMap = new Map<string, number>()
    for (const row of data) {
      serviceMap.set(row.serviceName, (serviceMap.get(row.serviceName) ?? 0) + row.count)
      if (row.httpMethod && row.httpMethod !== "UNKNOWN") {
        methodMap.set(row.httpMethod, (methodMap.get(row.httpMethod) ?? 0) + row.count)
      }
    }

    const toSorted = (map: Map<string, number>): FilterOption[] =>
      Array.from(map.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)

    return {
      services: toSorted(serviceMap),
      httpMethods: toSorted(methodMap),
    }
  }, [unfilteredResult])

  const isLoading = Result.isInitial(unfilteredResult)

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Endpoints" }]}
      title="Endpoints"
      description="HTTP endpoints discovered from your traces."
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          onChange={handleTimeChange}
        />
      }
      filterSidebar={
        <EndpointsFilterSidebar facets={facets} isLoading={isLoading} />
      }
    >
      <EndpointsTable filters={search} />
    </DashboardLayout>
  )
}
