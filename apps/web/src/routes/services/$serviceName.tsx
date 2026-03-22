import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result } from "@/lib/effect-atom"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type {
  ChartLegendMode,
  ChartTooltipMode,
} from "@maple/ui/components/charts/_shared/chart-types"
import {
  getCustomChartServiceDetailResultAtom,
  getServiceApdexTimeSeriesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { Button } from "@maple/ui/components/ui/button"
import { BellIcon } from "@/components/icons"

const serviceDetailSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/services/$serviceName")({
  component: ServiceDetailPage,
  validateSearch: Schema.toStandardSchemaV1(serviceDetailSearchSchema),
})

interface ServiceChartConfig {
  id: string
  chartId: string
  title: string
  layout: { x: number; y: number; w: number; h: number }
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
  rateMode?: "per_second"
}

const SERVICE_CHARTS: ServiceChartConfig[] = [
  { id: "latency", chartId: "latency-line", title: "Latency", layout: { x: 0, y: 0, w: 6, h: 4 }, legend: "visible", tooltip: "visible" },
  { id: "throughput", chartId: "throughput-area", title: "Throughput", layout: { x: 6, y: 0, w: 6, h: 4 }, tooltip: "visible", rateMode: "per_second" },
  { id: "apdex", chartId: "apdex-area", title: "Apdex", layout: { x: 0, y: 4, w: 6, h: 4 }, tooltip: "visible" },
  { id: "error-rate", chartId: "error-rate-area", title: "Error Rate", layout: { x: 6, y: 4, w: 6, h: 4 }, tooltip: "visible" },
]

function ServiceDetailPage() {
  const search = Route.useSearch()
  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
      <ServiceDetailContent />
    </PageRefreshProvider>
  )
}

function ServiceDetailContent() {
  const { serviceName } = Route.useParams()
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
      search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
    })
  }

  const detailResult = useRetainedRefreshableResultValue(
    getCustomChartServiceDetailResultAtom({
      data: {
        serviceName,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const apdexResult = useRetainedRefreshableResultValue(
    getServiceApdexTimeSeriesResultAtom({
      data: {
        serviceName,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const isWaiting =
    (Result.isSuccess(detailResult) && detailResult.waiting) ||
    (Result.isSuccess(apdexResult) && apdexResult.waiting)

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
    rateMode: chart.rateMode,
  }))

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Services", href: "/services" },
        { label: serviceName },
      ]}
      title={serviceName}
      headerActions={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <TimeRangeHeaderControls
            startTime={search.startTime}
            endTime={search.endTime}
            presetValue={search.timePreset ?? "12h"}
            onTimeChange={handleTimeChange}
          />
          <Button
            variant="outline"
            render={
              <Link
                to="/alerts/create"
                search={{ serviceName }}
              />
            }
          >
            <BellIcon size={14} />
            Create Alert
          </Button>
        </div>
      }
    >
      <MetricsGrid items={metrics} waiting={!!isWaiting} />
    </DashboardLayout>
  )
}
