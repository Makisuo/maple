import { useNavigate } from "@tanstack/react-router"

import {
  FilterSection,
  SearchableFilterSection,
} from "@/components/filters/filter-section"
import type { FilterOption } from "@/components/filters/filter-section"
import { Separator } from "@maple/ui/components/ui/separator"
import {
  FilterSidebarBody,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { Route } from "@/routes/endpoints"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={2} sticky />
}

export interface EndpointsFacets {
  services: FilterOption[]
  httpMethods: FilterOption[]
}

interface EndpointsFilterSidebarProps {
  facets: EndpointsFacets | undefined
  isLoading: boolean
}

export function EndpointsFilterSidebar({ facets, isLoading }: EndpointsFilterSidebarProps) {
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
    (search.httpMethods?.length ?? 0) > 0

  if (isLoading || !facets) {
    return <LoadingState />
  }

  return (
    <FilterSidebarFrame sticky>
      <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
      <FilterSidebarBody>
        <SearchableFilterSection
          title="Service"
          options={facets.services}
          selected={search.services ?? []}
          onChange={(val) => updateFilter("services", val)}
        />

        {facets.httpMethods.length > 0 && (
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
      </FilterSidebarBody>
    </FilterSidebarFrame>
  )
}
