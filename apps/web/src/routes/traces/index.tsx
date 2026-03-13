import * as React from "react"
import { Result } from "@effect-atom/atom-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { AdvancedFilterDialog } from "@/components/traces/advanced-filter-dialog"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAtomValue } from "@effect-atom/atom-react"
import { applyWhereClause } from "@/lib/traces/advanced-filter-sync"
import {
  getTracesFacetsResultAtom,
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
  getResourceAttributeKeysResultAtom,
  getResourceAttributeValuesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const ContainsMatchMode = Schema.optional(Schema.Literal("contains"))

const tracesSearchSchema = Schema.Struct({
  services: OptionalStringArrayParam,
  spanNames: OptionalStringArrayParam,
  hasError: Schema.optional(Schema.Union(Schema.Boolean, Schema.BooleanFromString)),
  minDurationMs: Schema.optional(Schema.Union(Schema.Number, Schema.NumberFromString)),
  maxDurationMs: Schema.optional(Schema.Union(Schema.Number, Schema.NumberFromString)),
  httpMethods: OptionalStringArrayParam,
  httpStatusCodes: OptionalStringArrayParam,
  deploymentEnvs: OptionalStringArrayParam,
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
  rootOnly: Schema.optional(Schema.Union(Schema.Boolean, Schema.BooleanFromString)),
  whereClause: Schema.optional(Schema.String),
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
  serviceMatchMode: ContainsMatchMode,
  spanNameMatchMode: ContainsMatchMode,
  deploymentEnvMatchMode: ContainsMatchMode,
  attributeValueMatchMode: ContainsMatchMode,
  resourceAttributeValueMatchMode: ContainsMatchMode,
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = createFileRoute("/traces/")({
  component: TracesPage,
  validateSearch: Schema.standardSchemaV1(tracesSearchSchema),
})

export function TracesPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [activeAttributeKey, setActiveAttributeKey] = React.useState<string | null>(null)
  const [activeResourceAttributeKey, setActiveResourceAttributeKey] = React.useState<string | null>(null)

  const handleApplyWhereClause = React.useCallback(
    (newClause: string) => {
      navigate({
        search: (prev) => applyWhereClause(prev, newClause),
      })
    },
    [navigate],
  )

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime, "12h")

  const facetsResult = useAtomValue(
    getTracesFacetsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
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

  const resourceAttributeKeysResult = useAtomValue(
    getResourceAttributeKeysResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const resourceAttributeValuesResult = useAtomValue(
    getResourceAttributeValuesResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        attributeKey: activeResourceAttributeKey ?? "",
      },
    }),
  )

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

  const resourceAttributeKeys = React.useMemo(
    () =>
      Result.builder(resourceAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [resourceAttributeKeysResult],
  )

  const resourceAttributeValues = React.useMemo(
    () =>
      activeResourceAttributeKey
        ? Result.builder(resourceAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeResourceAttributeKey, resourceAttributeValuesResult],
  )

  const autocompleteValues = React.useMemo(() => {
    const toNames = (items: Array<{ name: string }>): string[] => {
      const seen = new Set<string>()
      const values: string[] = []
      for (const item of items) {
        const next = item.name.trim()
        if (!next || seen.has(next)) continue
        seen.add(next)
        values.push(next)
      }
      return values
    }

    return Result.builder(facetsResult)
      .onSuccess((response) => ({
        services: toNames(response.data.services ?? []),
        spanNames: toNames(response.data.spanNames ?? []),
        environments: toNames(response.data.deploymentEnvs ?? []),
        httpMethods: toNames(response.data.httpMethods ?? []),
        httpStatusCodes: toNames(response.data.httpStatusCodes ?? []),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      }))
      .orElse(() => ({
        services: [] as string[],
        spanNames: [] as string[],
        environments: [] as string[],
        httpMethods: [] as string[],
        httpStatusCodes: [] as string[],
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      }))
  }, [facetsResult, attributeKeys, attributeValues, resourceAttributeKeys, resourceAttributeValues])

  const handleTimeChange = (
    range: {
      startTime?: string
      endTime?: string
      presetValue?: string
    },
    options?: { replace?: boolean },
  ) => {
    navigate({
      replace: options?.replace,
      search: (prev) => ({
        ...applyTimeRangeSearch(prev, range),
      }),
    })
  }

  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <DashboardLayout
        breadcrumbs={[{ label: "Traces" }]}
        filterSidebar={<TracesFilterSidebar facetsResult={facetsResult} />}
        headerActions={
          <div className="flex items-center gap-2">
            <AdvancedFilterDialog
              initialValue={search.whereClause ?? ""}
              onApply={handleApplyWhereClause}
              autocompleteValues={autocompleteValues}
              onActiveAttributeKey={setActiveAttributeKey}
              onActiveResourceAttributeKey={setActiveResourceAttributeKey}
            />
            <TimeRangeHeaderControls
              startTime={search.startTime ?? effectiveStartTime}
              endTime={search.endTime ?? effectiveEndTime}
              presetValue={search.timePreset ?? "12h"}
              onTimeChange={handleTimeChange}
            />
          </div>
        }
      >
        {search.whereClause && (
          <div className="mb-4 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2 overflow-hidden">
              <MagnifierIcon className="size-3.5 text-primary shrink-0" />
              <span className="text-xs font-mono text-foreground truncate" title={search.whereClause}>
                {search.whereClause}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleApplyWhereClause("")}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              title="Clear filter"
            >
              <XmarkIcon />
              <span className="sr-only">Clear filter</span>
            </Button>
          </div>
        )}
        <TracesTable filters={search} />
      </DashboardLayout>
    </PageRefreshProvider>
  )
}
