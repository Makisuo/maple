import * as React from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { TimeRangePicker } from "@/components/time-range-picker"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { MagnifierIcon } from "@/components/icons"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyWhereClause } from "@/lib/traces/advanced-filter-sync"
import {
  getTracesFacetsResultAtom,
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"

const tracesSearchSchema = Schema.Struct({
  services: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  spanNames: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  hasError: Schema.optional(Schema.Boolean),
  minDurationMs: Schema.optional(Schema.Number),
  maxDurationMs: Schema.optional(Schema.Number),
  httpMethods: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  httpStatusCodes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  deploymentEnvs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  rootOnly: Schema.optional(Schema.Boolean),
  whereClause: Schema.optional(Schema.String),
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = createFileRoute("/traces/")({
  component: TracesPage,
  validateSearch: Schema.standardSchemaV1(tracesSearchSchema),
})

function TracesPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [activeAttributeKey, setActiveAttributeKey] = React.useState<string | null>(null)
  const [whereClauseText, setWhereClauseText] = React.useState(search.whereClause ?? "")
  const isLocalUpdate = React.useRef(false)

  // URL → local (external changes only: back/forward, sidebar clear, etc.)
  React.useEffect(() => {
    if (isLocalUpdate.current) {
      isLocalUpdate.current = false
      return
    }
    setWhereClauseText(search.whereClause ?? "")
  }, [search.whereClause])

  // Local → URL (debounced 300ms)
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = whereClauseText.trim() || undefined
      if (trimmed !== (search.whereClause ?? undefined)) {
        isLocalUpdate.current = true
        navigate({
          search: (prev) => applyWhereClause(prev, whereClauseText),
        })
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [whereClauseText, search.whereClause, navigate])

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

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
      }))
      .orElse(() => ({
        services: [] as string[],
        spanNames: [] as string[],
        environments: [] as string[],
        httpMethods: [] as string[],
        httpStatusCodes: [] as string[],
        attributeKeys,
        attributeValues,
      }))
  }, [facetsResult, attributeKeys, attributeValues])

  const handleTimeChange = ({ startTime, endTime }: { startTime?: string; endTime?: string }) => {
    navigate({
      search: (prev) => ({
        ...prev,
        startTime,
        endTime,
      }),
    })
  }

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Traces" }]}
      title="Traces"
      description="View distributed traces across your services."
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          onChange={handleTimeChange}
        />
      }
    >
      <div className="mb-4">
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-1.5 pt-1.5 shrink-0">
            <MagnifierIcon className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Filter</span>
          </div>
          <WhereClauseEditor
            className="flex-1 min-w-0"
            rows={1}
            value={whereClauseText}
            dataSource="traces"
            autocompleteScope="trace_search"
            maxSuggestions={20}
            values={autocompleteValues}
            onActiveAttributeKey={setActiveAttributeKey}
            onChange={setWhereClauseText}
            placeholder='service.name = "checkout" AND attr.http.route = "/orders/:id"'
            textareaClassName="border-0 bg-transparent shadow-none focus-visible:ring-0 resize-none px-0 py-1 text-xs min-h-0"
            ariaLabel="Advanced traces where clause"
          />
        </div>
      </div>
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <TracesTable filters={search} />
        </div>
        <TracesFilterSidebar facetsResult={facetsResult} />
      </div>
    </DashboardLayout>
  )
}
