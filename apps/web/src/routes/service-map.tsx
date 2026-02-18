import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker"
import { ServiceMapView } from "@/components/service-map/service-map-view"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const serviceMapSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/service-map")({
  component: ServiceMapPage,
  validateSearch: Schema.standardSchemaV1(serviceMapSearchSchema),
})

function ServiceMapPage() {
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

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Service Map" }]}
      title="Service Map"
      description="Visualize service-to-service dependencies and data flow."
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onChange={handleTimeChange}
        />
      }
    >
      <div className="-mx-6 -mb-6 h-[calc(100vh-10rem)]">
        <ServiceMapView
          startTime={effectiveStartTime}
          endTime={effectiveEndTime}
        />
      </div>
    </DashboardLayout>
  )
}
