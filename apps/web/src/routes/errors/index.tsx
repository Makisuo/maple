import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorsSummaryCards } from "@/components/errors/errors-summary-cards"
import { ErrorsByTypeTable } from "@/components/errors/errors-by-type-table"
import { ErrorsFilterSidebar } from "@/components/errors/errors-filter-sidebar"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const errorsSearchSchema = Schema.Struct({
  services: OptionalStringArrayParam,
  deploymentEnvs: OptionalStringArrayParam,
  errorTypes: OptionalStringArrayParam,
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
  showSpam: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
})

export type ErrorsSearchParams = Schema.Schema.Type<typeof errorsSearchSchema>

export const Route = effectRoute(createFileRoute("/errors/"))({
  component: ErrorsPage,
  validateSearch: Schema.toStandardSchemaV1(errorsSearchSchema),
})

function ErrorsPage() {
  const search = Route.useSearch()
  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <ErrorsContent />
    </PageRefreshProvider>
  )
}

function ErrorsContent() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime, search.timePreset ?? "12h")

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
      search: (prev) => applyTimeRangeSearch(prev, range),
    })
  }

  const apiFilters = {
    startTime: effectiveStartTime,
    endTime: effectiveEndTime,
    services: search.services,
    deploymentEnvs: search.deploymentEnvs,
    errorTypes: search.errorTypes,
    showSpam: search.showSpam,
  }

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Errors" }]}
      title="Errors"
      description="Monitor and analyze errors across your services."
      filterSidebar={<ErrorsFilterSidebar />}
      headerActions={
        <TimeRangeHeaderControls
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onTimeChange={handleTimeChange}
        />
      }
    >
      <div className="space-y-6">
        <ErrorsSummaryCards filters={apiFilters} />
        <div>
          <h2 className="text-lg font-semibold mb-4">Errors by Type</h2>
          <ErrorsByTypeTable filters={apiFilters} />
        </div>
      </div>
    </DashboardLayout>
  )
}
