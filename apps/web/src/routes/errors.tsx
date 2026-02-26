import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorsSummaryCards } from "@/components/errors/errors-summary-cards"
import { ErrorsByTypeTable } from "@/components/errors/errors-by-type-table"
import { ErrorsFilterSidebar } from "@/components/errors/errors-filter-sidebar"
import { TimeRangePicker } from "@/components/time-range-picker"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const errorsSearchSchema = Schema.Struct({
  services: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  deploymentEnvs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  errorTypes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
  showSpam: Schema.optional(Schema.Union(Schema.Boolean, Schema.BooleanFromString)),
})

export type ErrorsSearchParams = Schema.Schema.Type<typeof errorsSearchSchema>

export const Route = createFileRoute("/errors")({
  component: ErrorsPage,
  validateSearch: Schema.standardSchemaV1(errorsSearchSchema),
})

function ErrorsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const handleTimeChange = ({
    startTime,
    endTime,
    presetValue,
  }: {
    startTime?: string
    endTime?: string
    presetValue?: string
  }) => {
    navigate({
      search: (prev) => ({ ...prev, startTime, endTime, timePreset: presetValue }),
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
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onChange={handleTimeChange}
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
