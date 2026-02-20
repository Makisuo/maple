import * as React from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import {
  FilterSection,
  SearchableFilterSection,
  SingleCheckboxFilter,
} from "./filter-section"
import { DurationRangeFilter } from "./duration-range-filter"
import { Route } from "@/routes/traces"
import { Separator } from "@maple/ui/components/ui/separator"
import {
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
  getTracesFacetsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import {
  FilterSidebarBody,
  FilterSidebarError,
  FilterSidebarFrame,
  FilterSidebarHeader,
  FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import {
  normalizeTracesSearchParams,
  type TracesSearchLike,
} from "@/lib/traces/advanced-filter-sync"

function LoadingState() {
  return <FilterSidebarLoading sectionCount={5} sticky />
}

export function TracesFilterSidebar() {
  const navigate = useNavigate({ from: Route.fullPath })
  const search = Route.useSearch()
  const [activeAttributeKey, setActiveAttributeKey] = React.useState<string | null>(
    null,
  )
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
    search.startTime,
    search.endTime,
  )

  const spanAttributeKeysResult = useAtomValue(
    getSpanAttributeKeysResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const spanAttributeValuesResult = useAtomValue(
    getSpanAttributeValuesResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        attributeKey: activeAttributeKey ?? "",
      },
    }),
  )

  const facetsResult = useAtomValue(
    getTracesFacetsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        service: search.services?.[0],
        spanName: search.spanNames?.[0],
        hasError: search.hasError,
        minDurationMs: search.minDurationMs,
        maxDurationMs: search.maxDurationMs,
        httpMethod: search.httpMethods?.[0],
        httpStatusCode: search.httpStatusCodes?.[0],
        deploymentEnv: search.deploymentEnvs?.[0],
        attributeKey: search.attributeKey,
        attributeValue: search.attributeValue,
      },
    }),
  )

  const navigateWithNormalizedSearch = React.useCallback(
    (next: TracesSearchLike) => {
      navigate({
        search: normalizeTracesSearchParams(next),
      })
    },
    [navigate],
  )

  const updateFilter = <K extends keyof typeof search>(
    key: K,
    value: (typeof search)[K],
  ) => {
    const normalizedValue =
      value === undefined || (Array.isArray(value) && value.length === 0)
        ? undefined
        : value

    navigateWithNormalizedSearch({
      ...search,
      [key]: normalizedValue,
      whereClause: undefined,
    })
  }

  const clearAllFilters = () => {
    setActiveAttributeKey(null)
    navigateWithNormalizedSearch({
      startTime: search.startTime,
      endTime: search.endTime,
    })
  }

  const hasActiveFilters = Boolean(search.whereClause?.trim())

  const attributeKeys = React.useMemo(
    () =>
      Result.builder(spanAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [spanAttributeKeysResult],
  )

  const attributeValues = React.useMemo(
    () =>
      activeAttributeKey
        ? Result.builder(spanAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeAttributeKey, spanAttributeValuesResult],
  )

  return Result.builder(facetsResult)
    .onInitial(() => <LoadingState />)
    .onError(() => <FilterSidebarError message="Unable to load filters" sticky />)
    .onSuccess((facetsResponse, result) => {
      const facets = facetsResponse.data
      const toNames = (items: Array<{ name: string }>): string[] => {
        const seen = new Set<string>()
        const values: string[] = []

        for (const item of items) {
          const next = item.name.trim()
          if (!next || seen.has(next)) {
            continue
          }

          seen.add(next)
          values.push(next)
        }

        return values
      }

      const autocompleteValues = {
        services: toNames(facets.services ?? []),
        spanNames: toNames(facets.spanNames ?? []),
        environments: toNames(facets.deploymentEnvs ?? []),
        httpMethods: toNames(facets.httpMethods ?? []),
        httpStatusCodes: toNames(facets.httpStatusCodes ?? []),
        attributeKeys,
        attributeValues,
      }

      return (
        <FilterSidebarFrame sticky waiting={result.waiting}>
          <FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
          <FilterSidebarBody>
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Advanced Filter
              </p>
              <WhereClauseEditor
                rows={2}
                value={search.whereClause ?? ""}
                dataSource="traces"
                autocompleteScope="trace_search"
                values={autocompleteValues}
                onActiveAttributeKey={setActiveAttributeKey}
                onChange={(nextWhereClause) =>
                  navigateWithNormalizedSearch({
                    ...search,
                    whereClause: nextWhereClause,
                  })
                }
                placeholder='service.name = "checkout" AND attr.http.route = "/orders/:id"'
                ariaLabel="Advanced traces where clause"
              />
            </div>

            <Separator className="my-2" />

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
