import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { TimeRangePicker } from "@/components/time-range-picker"

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
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = createFileRoute("/traces/")({
  component: TracesPage,
  validateSearch: Schema.standardSchemaV1(tracesSearchSchema),
})

function TracesPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const handleTimeChange = ({ startTime, endTime }: { startTime?: string; endTime?: string }) => {
    navigate({
      search: (prev) => ({ ...prev, startTime, endTime }),
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
      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <TracesTable filters={search} />
        </div>
        <TracesFilterSidebar />
      </div>
    </DashboardLayout>
  )
}
