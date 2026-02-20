import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useRef, useEffect } from "react"
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
    useEffectiveTimeRange(search.startTime, search.endTime, "7d")

  const environmentFilter = search.environment
    ? [search.environment]
    : undefined

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

  // Default to production environment on first load
  const defaultEnvApplied = useRef(false)
  useEffect(() => {
    if (
      !defaultEnvApplied.current &&
      !search.environment &&
      environments.length > 0
    ) {
      defaultEnvApplied.current = true
      const hasProduction = environments.some((e) => e.name === "production")
      if (hasProduction) {
        navigate({
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            environment: "production",
          }),
        })
      }
    }
  }, [environments, search.environment, navigate])

  const overviewResult = useAtomValue(
    getOverviewTimeSeriesResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        environments: environmentFilter,
      },
    }),
  )

  const logVolumeResult = useAtomValue(
    getCustomChartTimeSeriesResultAtom({
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
    }),
  )

  const overviewPoints = Result.builder(overviewResult)
    .onSuccess((response) => response.data as unknown as Record<string, unknown>[])
    .orElse(() => [])

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
    .orElse(() => [])

  const widgetData: Record<string, Record<string, unknown>[]> = {
    throughput: overviewPoints,
    "error-rate": overviewPoints,
    latency: overviewPoints,
    "log-volume": logPoints,
  }

  const metrics = OVERVIEW_CHARTS.map((chart) => ({
    id: chart.id,
    chartId: chart.chartId,
    title: chart.title,
    layout: chart.layout,
    data: widgetData[chart.id] ?? [],
    legend: chart.legend,
    tooltip: chart.tooltip,
  }))

  const environmentItems = [
    { value: "__all__", label: "All Environments" },
    ...environments.map((e) => ({ value: e.name, label: e.name })),
  ]

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Overview" }]}
      title="Dashboard"
      description="Observability overview for your services."
      headerActions={
        <div className="flex items-center gap-2">
          <Select
            value={search.environment ?? "__all__"}
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
            presetValue={search.timePreset ?? "7d"}
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
