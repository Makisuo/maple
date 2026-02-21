import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LogsTable } from "@/components/logs/logs-table"
import { LogsFilterSidebar } from "@/components/logs/logs-filter-sidebar"
import { TimeRangePicker } from "@/components/time-range-picker"

const logsSearchSchema = Schema.Struct({
  services: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  severities: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  search: Schema.optional(Schema.String),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export type LogsSearchParams = Schema.Schema.Type<typeof logsSearchSchema>

export const Route = createFileRoute("/logs")({
  component: LogsPage,
  validateSearch: Schema.standardSchemaV1(logsSearchSchema),
})

function LogsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

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

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Logs" }]}
      title="Logs"
      description="View and search application logs."
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onChange={handleTimeChange}
        />
      }
    >
      <div className="flex gap-4">
        <LogsFilterSidebar />
        <div className="flex-1 min-w-0">
          <LogsTable filters={search} />
        </div>
      </div>
    </DashboardLayout>
  )
}
