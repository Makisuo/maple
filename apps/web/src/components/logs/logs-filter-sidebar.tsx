import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { XmarkIcon, MagnifierIcon } from "@/components/icons"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
  FilterSection,
  SearchableFilterSection,
} from "@/components/filters/filter-section"
import { Route } from "@/routes/logs"
import { Separator } from "@maple/ui/components/ui/separator"
import { getLogsFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import {
  FilterSidebarBody,
  FilterSidebarError,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={3} sticky />
}

export function LogsFilterSidebar() {
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const [searchText, setSearchText] = useState(search.search ?? "")

  useEffect(() => {
    setSearchText(search.search ?? "")
  }, [search.search])

  useEffect(() => {
    const timer = setTimeout(() => {
      const value = searchText.trim() || undefined
      if (value !== search.search) {
        navigate({
          search: (prev) => ({ ...prev, search: value }),
        })
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchText, search.search, navigate])

  const facetsResult = useAtomValue(
    getLogsFacetsResultAtom({
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
    setSearchText("")
    navigate({
      search: {
        startTime: search.startTime,
        endTime: search.endTime,
        timePreset: search.timePreset,
      },
    })
  }

  const hasActiveFilters =
    (search.services?.length ?? 0) > 0 ||
    (search.severities?.length ?? 0) > 0 ||
    !!search.search

  return Result.builder(facetsResult)
    .onInitial(() => <LoadingState />)
    .onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
    .onSuccess((facetsResponse, result) => {
      const facets = facetsResponse.data
      const hasFacets =
        (facets.services?.length ?? 0) > 0 ||
        (facets.severities?.length ?? 0) > 0

      return (
        <FilterSidebarFrame sticky waiting={result.waiting}>
          <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
          <FilterSidebarBody>
            <div className="pb-3">
              <span className="text-sm font-medium text-muted-foreground">Search</span>
              <div className="relative mt-2 px-px">
                <MagnifierIcon
                  strokeWidth={2}
                  className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
                />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search log messages..."
                  className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                {searchText && (
                  <button
                    type="button"
                    onClick={() => setSearchText("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <XmarkIcon strokeWidth={2} className="size-3" />
                  </button>
                )}
              </div>
            </div>
            <Separator className="my-2" />

            {(facets.severities?.length ?? 0) > 0 && (
              <>
                <FilterSection
                  title="Severity"
                  options={facets.severities}
                  selected={search.severities ?? []}
                  onChange={(val) => updateFilter("severities", val)}
                />
                <Separator className="my-2" />
              </>
            )}

            {(facets.services?.length ?? 0) > 0 && (
              <SearchableFilterSection
                title="Service"
                options={facets.services}
                selected={search.services ?? []}
                onChange={(val) => updateFilter("services", val)}
              />
            )}

            {!hasFacets && (
              <p className="text-sm text-muted-foreground py-4">
                No logs found in the selected time range
              </p>
            )}
          </FilterSidebarBody>
        </FilterSidebarFrame>
      )
    })
    .render()
}
