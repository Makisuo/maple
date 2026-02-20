import { Result } from "@effect-atom/atom-react"
import { useNavigate } from "@tanstack/react-router"

import {
  FilterSection,
  SearchableFilterSection,
  SingleCheckboxFilter,
} from "./filter-section"
import { DurationRangeFilter } from "./duration-range-filter"
import { Route } from "@/routes/traces"
import { Separator } from "@maple/ui/components/ui/separator"
import type { TracesFacetsResponse } from "@/api/tinybird/traces"
import {
  FilterSidebarBody,
  FilterSidebarError,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={5} sticky />
}

interface TracesFilterSidebarProps {
  facetsResult: Result.Result<TracesFacetsResponse, unknown>
}

export function TracesFilterSidebar({ facetsResult }: TracesFilterSidebarProps) {
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()

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
    (search.spanNames?.length ?? 0) > 0 ||
    (search.deploymentEnvs?.length ?? 0) > 0 ||
    (search.httpMethods?.length ?? 0) > 0 ||
    (search.httpStatusCodes?.length ?? 0) > 0 ||
    search.hasError !== undefined ||
    search.minDurationMs !== undefined ||
    search.maxDurationMs !== undefined ||
    search.attributeKey !== undefined

  return Result.builder(facetsResult)
    .onInitial(() => <LoadingState />)
    .onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
    .onSuccess((facetsResponse, result) => {
      const facets = facetsResponse.data

      return (
        <FilterSidebarFrame sticky waiting={result.waiting}>
          <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
          <FilterSidebarBody>
            <DurationRangeFilter
              minValue={search.minDurationMs}
              maxValue={search.maxDurationMs}
              onMinChange={(val) => updateFilter("minDurationMs", val)}
              onMaxChange={(val) => updateFilter("maxDurationMs", val)}
              durationStats={facets.durationStats}
            />

            <Separator className="my-2" />

            <SingleCheckboxFilter
              title="Has Error"
              checked={search.hasError ?? false}
              onChange={(checked) => updateFilter("hasError", checked || undefined)}
              count={facets.errorCount}
            />

            <Separator className="my-2" />

            <SingleCheckboxFilter
              title="Root Traces Only"
              checked={search.rootOnly ?? true}
              onChange={(checked) => updateFilter("rootOnly", checked ? undefined : false)}
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

            <SearchableFilterSection
              title="Service"
              options={facets.services ?? []}
              selected={search.services ?? []}
              onChange={(val) => updateFilter("services", val)}
            />

            <Separator className="my-2" />

            <SearchableFilterSection
              title="Root Span"
              options={facets.spanNames ?? []}
              selected={search.spanNames ?? []}
              onChange={(val) => updateFilter("spanNames", val)}
            />

            {(facets.httpMethods?.length ?? 0) > 0 && (
              <>
                <Separator className="my-2" />
                <FilterSection
                  title="HTTP Method"
                  options={facets.httpMethods}
                  selected={search.httpMethods ?? []}
                  onChange={(val) => updateFilter("httpMethods", val)}
                />
              </>
            )}

            {(facets.httpStatusCodes?.length ?? 0) > 0 && (
              <>
                <Separator className="my-2" />
                <FilterSection
                  title="Status Code"
                  options={facets.httpStatusCodes}
                  selected={search.httpStatusCodes ?? []}
                  onChange={(val) => updateFilter("httpStatusCodes", val)}
                />
              </>
            )}
          </FilterSidebarBody>
        </FilterSidebarFrame>
      )
    })
    .render()
}
