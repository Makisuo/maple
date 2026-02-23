import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { EndpointsTable } from "@/components/endpoints/endpoints-table"
import { TimeRangePicker } from "@/components/time-range-picker"

const endpointsSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/endpoints")({
  component: EndpointsPage,
  validateSearch: Schema.standardSchemaV1(endpointsSearchSchema),
})

function EndpointsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const handleTimeChange = ({
    startTime,
    endTime,
  }: {
    startTime?: string
    endTime?: string
  }) => {
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, startTime, endTime }),
    })
  }

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Endpoints" }]}
      title="Endpoints"
      description="HTTP endpoints discovered from your traces."
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          onChange={handleTimeChange}
        />
      }
    >
      <EndpointsTable filters={search} />
    </DashboardLayout>
  )
}
