import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { FilterSection, SingleCheckboxFilter } from "@/components/traces/filter-section"
import { Route } from "@/routes/errors"
import { Separator } from "@maple/ui/components/ui/separator"
import { getErrorsFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import {
  FilterSidebarBody,
  FilterSidebarError,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={3} />
}

export function ErrorsFilterSidebar() {
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const facetsResult = useAtomValue(
    getErrorsFacetsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: search.services,
        deploymentEnvs: search.deploymentEnvs,
        errorTypes: search.errorTypes,
        showSpam: search.showSpam,
      },
    }),
  )

  const updateFilter = <K extends keyof typeof search>(
    key: K,
    value: (typeof search)[K],
  ) => {
    navigate({
      search: (prev) => ({
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
    (search.services?.length ?? 0) > 0 ||
    (search.deploymentEnvs?.length ?? 0) > 0 ||
    (search.errorTypes?.length ?? 0) > 0

  return Result.builder(facetsResult)
    .onInitial(() => <LoadingState />)
    .onError(() => <FilterSidebarError message="Unable to load filters" />)
    .onSuccess((facetsResponse, result) => {
      const facets = facetsResponse.data
      const hasFacets =
        (facets.services?.length ?? 0) > 0 ||
        (facets.deploymentEnvs?.length ?? 0) > 0 ||
        (facets.errorTypes?.length ?? 0) > 0

      return (
        <FilterSidebarFrame waiting={result.waiting}>
          <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
          <FilterSidebarBody>
            <SingleCheckboxFilter
              title="Show scanner noise"
              checked={search.showSpam ?? false}
              onChange={(checked) => updateFilter("showSpam", checked || undefined)}
            />
            <Separator className="my-2" />
            {(facets.deploymentEnvs?.length ?? 0) > 0 && (
              <>
                <FilterSection
                  title="Environment"
                  options={facets.deploymentEnvs}
                  selected={search.deploymentEnvs ?? []}
                  onChange={(val) => updateFilter("deploymentEnvs", val)}
                />
                <Separator className="my-2" />
              </>
            )}

            {(facets.services?.length ?? 0) > 0 && (
              <>
                <FilterSection
                  title="Service"
                  options={facets.services}
                  selected={search.services ?? []}
                  onChange={(val) => updateFilter("services", val)}
                />
                <Separator className="my-2" />
              </>
            )}

            {(facets.errorTypes?.length ?? 0) > 0 && (
              <FilterSection
                title="Error Type"
                options={facets.errorTypes}
                selected={search.errorTypes ?? []}
                onChange={(val) => updateFilter("errorTypes", val)}
              />
            )}

            {!hasFacets && (
              <p className="text-sm text-muted-foreground py-4">
                No errors found in the selected time range
              </p>
            )}
          </FilterSidebarBody>
        </FilterSidebarFrame>
      )
    })
    .render()
}
