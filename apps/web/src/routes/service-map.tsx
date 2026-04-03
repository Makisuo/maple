import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServiceMapView } from "@/components/service-map/service-map-view"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const serviceMapSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/service-map"))({
  component: ServiceMapPage,
  validateSearch: Schema.toStandardSchemaV1(serviceMapSearchSchema),
})

function ServiceMapPage() {
  const search = Route.useSearch()
  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <ServiceMapContent />
    </PageRefreshProvider>
  )
}

function ServiceMapContent() {
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

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Service Map" }]}
      title="Service Map"
      description="Visualize service-to-service dependencies and data flow."
      headerActions={
        <TimeRangeHeaderControls
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onTimeChange={handleTimeChange}
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
