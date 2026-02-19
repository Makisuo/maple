import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { QueryBuilderLab } from "@/components/query-builder/query-builder-lab"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const queryBuilderLabSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/query-builder-lab")({
  component: QueryBuilderLabPage,
  validateSearch: Schema.standardSchemaV1(queryBuilderLabSearchSchema),
})

function QueryBuilderLabPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime, "1h")

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
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        startTime,
        endTime,
        timePreset: presetValue,
      }),
    })
  }

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Overview", href: "/" },
        { label: "Query Builder Lab" },
      ]}
      title="Query Builder Lab"
      description="MVP Query builder"
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "1h"}
          onChange={handleTimeChange}
        />
      }
    >
      <QueryBuilderLab
        startTime={effectiveStartTime}
        endTime={effectiveEndTime}
      />
    </DashboardLayout>
  )
}
