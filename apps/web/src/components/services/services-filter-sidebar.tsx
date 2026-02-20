import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { FilterSection } from "@/components/traces/filter-section"
import { Route } from "@/routes/services/index"
import { Separator } from "@maple/ui/components/ui/separator"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import {
  FilterSidebarBody,
  FilterSidebarError,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={2} />
}

export function ServicesFilterSidebar() {
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const facetsResult = useAtomValue(
    getServicesFacetsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const updateFilter = <K extends keyof typeof search>(
    key: K,
    value: (typeof search)[K],
  ) => {
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [key]:
          value === undefined || (Array.isArray(value) && value.length === 0)
            ? undefined
            : value,
      }),
    })
  }

  const clearAllFilters = () => {
    navigate({
      search: {
        startTime: search.startTime,
        endTime: search.endTime,
      },
    })
  }

  const hasActiveFilters =
    (search.environments?.length ?? 0) > 0 ||
    (search.commitShas?.length ?? 0) > 0

  return Result.builder(facetsResult)
    .onInitial(() => <LoadingState />)
    .onError(() => <FilterSidebarError message="Unable to load filters" />)
    .onSuccess((facetsResponse, result) => {
      const facets = facetsResponse.data

      return (
        <FilterSidebarFrame waiting={result.waiting}>
          <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
          <FilterSidebarBody>
            {(facets.environments.length ?? 0) > 0 && (
              <>
                <FilterSection
                  title="Environment"
                  options={facets.environments}
                  selected={search.environments ?? []}
                  onChange={(val) => updateFilter("environments", val)}
                />
                <Separator className="my-2" />
              </>
            )}

            {(facets.commitShas.length ?? 0) > 0 && (
              <FilterSection
                title="Commit SHA"
                options={facets.commitShas}
                selected={search.commitShas ?? []}
                onChange={(val) => updateFilter("commitShas", val)}
              />
            )}

            {facets.environments.length === 0 && facets.commitShas.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">No filter options available</p>
            )}
          </FilterSidebarBody>
        </FilterSidebarFrame>
      )
    })
    .render()
}
