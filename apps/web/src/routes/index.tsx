import { useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { ServiceUsageCards } from "@/components/dashboard/service-usage-cards"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import type {
  ChartLegendMode,
  ChartTooltipMode,
} from "@maple/ui/components/charts/_shared/chart-types"
import {
  getCustomChartTimeSeriesResultAtom,
  getOverviewTimeSeriesResultAtom,
  getServicesFacetsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import type { CustomChartTimeSeriesResponse } from "@/api/tinybird/custom-charts"
import type { ServiceDetailTimeSeriesPoint } from "@/api/tinybird/services"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"

const dashboardSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/")({
  component: DashboardPage,
  validateSearch: Schema.standardSchemaV1(dashboardSearchSchema),
})

interface OverviewChartConfig {
  id: string
  chartId: string
  title: string
  layout: { x: number; y: number; w: number; h: number }
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
}

const EMPTY_ARRAY: Record<string, unknown>[] = []

const OVERVIEW_CHARTS: OverviewChartConfig[] = [
  { id: "throughput", chartId: "throughput-area", title: "Request Volume", layout: { x: 0, y: 0, w: 6, h: 4 }, tooltip: "visible" },
  { id: "error-rate", chartId: "error-rate-area", title: "Error Rate", layout: { x: 6, y: 0, w: 6, h: 4 }, tooltip: "visible" },
  { id: "latency", chartId: "latency-line", title: "Latency", layout: { x: 0, y: 4, w: 6, h: 4 }, legend: "visible", tooltip: "visible" },
  { id: "log-volume", chartId: "throughput-area", title: "Log Volume", layout: { x: 6, y: 4, w: 6, h: 4 }, tooltip: "visible" },
]

function DashboardPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime, "24h")

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

  const handleEnvironmentChange = (value: string | null) => {
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        environment: value === "__all__" ? undefined : (value ?? undefined),
      }),
    })
  }

  const facetsResult = useAtomValue(
    getServicesFacetsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  const environments = Result.builder(facetsResult)
    .onSuccess((response) => response.data.environments)
    .orElse(() => [])

  // Derive effective environment filter — default to "production" if available, without writing to URL
  const environmentFilter = (() => {
    if (search.environment) return [search.environment]
    const hasProduction = environments.some((e) => e.name === "production")
    if (hasProduction) return ["production"]
    return undefined
  })()

  const selectedEnvironment = search.environment
    ?? (environments.some((e) => e.name === "production") ? "production" : "__all__")

  // Wait for facets before fetching data to avoid a cascading double-fetch
  // when environmentFilter changes from undefined → ["production"]
  const facetsReady = !Result.isInitial(facetsResult)

  const overviewResult = useAtomValue(
    facetsReady
      ? getOverviewTimeSeriesResultAtom({
          data: {
            startTime: effectiveStartTime,
            endTime: effectiveEndTime,
            environments: environmentFilter,
          },
        })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : disabledResultAtom<{ data: ServiceDetailTimeSeriesPoint[] }, any>(),
  )

  const logVolumeResult = useAtomValue(
    facetsReady
      ? getCustomChartTimeSeriesResultAtom({
          data: {
            source: "logs",
            metric: "count",
            groupBy: "severity",
            startTime: effectiveStartTime,
            endTime: effectiveEndTime,
            filters: {
              serviceName: undefined,
              environments: environmentFilter,
            },
          },
        })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : disabledResultAtom<CustomChartTimeSeriesResponse, any>(),
  )

  const overviewPoints = Result.builder(overviewResult)
    .onSuccess((response) => response.data as unknown as Record<string, unknown>[])
    .orElse(() => EMPTY_ARRAY)

  const logPoints = Result.builder(logVolumeResult)
    .onSuccess((response) =>
      response.data.map((point) => {
        const total = Object.values(point.series).reduce<number>(
          (sum, val) => sum + (typeof val === "number" ? val : 0),
          0,
        )
        return { bucket: point.bucket, throughput: total }
      }) as unknown as Record<string, unknown>[],
    )
    .orElse(() => EMPTY_ARRAY)

  const isOverviewLoading = Result.isInitial(overviewResult)
  const isLogVolumeLoading = Result.isInitial(logVolumeResult)

  const metrics = useMemo(() => {
    const loadingMap: Record<string, boolean> = {
      throughput: isOverviewLoading,
      "error-rate": isOverviewLoading,
      latency: isOverviewLoading,
      "log-volume": isLogVolumeLoading,
    }

    const dataMap: Record<string, Record<string, unknown>[]> = {
      throughput: overviewPoints,
      "error-rate": overviewPoints,
      latency: overviewPoints,
      "log-volume": logPoints,
    }

    return OVERVIEW_CHARTS.map((chart) => ({
      id: chart.id,
      chartId: chart.chartId,
      title: chart.title,
      layout: chart.layout,
      data: dataMap[chart.id] ?? EMPTY_ARRAY,
      legend: chart.legend,
      tooltip: chart.tooltip,
      isLoading: loadingMap[chart.id] ?? false,
    }))
  }, [overviewPoints, logPoints, isOverviewLoading, isLogVolumeLoading])

  const environmentItems = useMemo(() => [
    { value: "__all__", label: "All Environments" },
    ...environments.map((e) => ({ value: e.name, label: e.name })),
  ], [environments])

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Overview" }]}
      title="Dashboard"
      description="Observability overview for your services."
      headerActions={
        <div className="flex items-center gap-2">
          <Select
            value={selectedEnvironment}
            onValueChange={handleEnvironmentChange}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {environmentItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TimeRangePicker
            startTime={search.startTime}
            endTime={search.endTime}
            presetValue={search.timePreset ?? "24h"}
            onChange={handleTimeChange}
          />
        </div>
      }
    >
      <ServiceUsageCards startTime={effectiveStartTime} endTime={effectiveEndTime} />
      <MetricsGrid items={metrics} className="mt-4" />
    </DashboardLayout>
  )
}
