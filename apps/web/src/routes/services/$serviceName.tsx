import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type {
  ChartLegendMode,
  ChartTooltipMode,
} from "@/components/charts/_shared/chart-types"
import {
  getCustomChartServiceDetailResultAtom,
  getServiceApdexTimeSeriesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"

const serviceDetailSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/services/$serviceName")({
  component: ServiceDetailPage,
  validateSearch: Schema.standardSchemaV1(serviceDetailSearchSchema),
})

interface ServiceChartConfig {
  id: string
  chartId: string
  title: string
  layout: { x: number; y: number; w: number; h: number }
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
}

const SERVICE_CHARTS: ServiceChartConfig[] = [
  { id: "latency", chartId: "latency-line", title: "Latency", layout: { x: 0, y: 0, w: 6, h: 4 }, legend: "visible", tooltip: "visible" },
  { id: "throughput", chartId: "throughput-area", title: "Throughput", layout: { x: 6, y: 0, w: 6, h: 4 }, tooltip: "visible" },
  { id: "apdex", chartId: "apdex-area", title: "Apdex", layout: { x: 0, y: 4, w: 6, h: 4 }, tooltip: "visible" },
  { id: "error-rate", chartId: "error-rate-area", title: "Error Rate", layout: { x: 6, y: 4, w: 6, h: 4 }, tooltip: "visible" },
]

function ServiceDetailPage() {
  const { serviceName } = Route.useParams()
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
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        startTime,
        endTime,
        timePreset: presetValue,
      }),
    })
  }

  const detailResult = useAtomValue(
    getCustomChartServiceDetailResultAtom({
      data: {
        serviceName,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const apdexResult = useAtomValue(
    getServiceApdexTimeSeriesResultAtom({
      data: {
        serviceName,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const detailPoints = Result.builder(detailResult)
    .onSuccess((response) => response.data as unknown as Record<string, unknown>[])
    .orElse(() => [])
  const apdexPoints = Result.builder(apdexResult)
    .onSuccess((response) => response.data as unknown as Record<string, unknown>[])
    .orElse(() => [])

  const widgetData: Record<string, Record<string, unknown>[]> = {
    latency: detailPoints,
    throughput: detailPoints,
    "error-rate": detailPoints,
    apdex: apdexPoints,
  }

  const metrics = SERVICE_CHARTS.map((chart) => ({
    id: chart.id,
    chartId: chart.chartId,
    title: chart.title,
    layout: chart.layout,
    data: widgetData[chart.id] ?? [],
    legend: chart.legend,
    tooltip: chart.tooltip,
  }))

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Services", href: "/services" },
        { label: serviceName },
      ]}
      title={serviceName}
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onChange={handleTimeChange}
        />
      }
    >
      <MetricsGrid items={metrics} />
    </DashboardLayout>
  )
}
