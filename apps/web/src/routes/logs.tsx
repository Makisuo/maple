import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LogsTable } from "@/components/logs/logs-table"
import { LogsVolumeChart } from "@/components/logs/logs-volume-chart"
import { LogsFilterSidebar } from "@/components/logs/logs-filter-sidebar"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const logsSearchSchema = Schema.Struct({
  services: OptionalStringArrayParam,
  severities: OptionalStringArrayParam,
  deploymentEnvs: OptionalStringArrayParam,
  deploymentEnvMatchMode: Schema.optional(Schema.Literals(["contains"])),
  search: Schema.optional(Schema.String),
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export type LogsSearchParams = Schema.Schema.Type<typeof logsSearchSchema>

export const Route = effectRoute(createFileRoute("/logs"))({
  component: LogsPage,
  validateSearch: Schema.toStandardSchemaV1(logsSearchSchema),
})

export function LogsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

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

  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <DashboardLayout
        breadcrumbs={[{ label: "Logs" }]}
        title="Logs"
        filterSidebar={<LogsFilterSidebar />}
        headerActions={
          <TimeRangeHeaderControls
            startTime={search.startTime}
            endTime={search.endTime}
            presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
            onTimeChange={handleTimeChange}
          />
        }
        stickyContent={
          <LogsVolumeChart
            filters={search}
            onTimeRangeSelect={(range) =>
              handleTimeChange(
                { startTime: range.startTime, endTime: range.endTime },
                { replace: true },
              )
            }
          />
        }
      >
        <LogsTable filters={search} />
      </DashboardLayout>
    </PageRefreshProvider>
  )
}
