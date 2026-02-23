import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { MetricsGrid } from "@/components/dashboard/metrics-grid"
import { MethodBadge } from "@/components/endpoints/method-badge"
import { EndpointSummaryStats } from "@/components/endpoints/endpoint-summary-stats"
import { EndpointStatusBreakdown } from "@/components/endpoints/endpoint-status-breakdown"
import { EndpointRecentTraces } from "@/components/endpoints/endpoint-recent-traces"
import { ReadonlyWidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"
import {
  getEndpointDetailTimeSeriesResultAtom,
  getEndpointStatusCodeBreakdownResultAtom,
  getHttpEndpointsOverviewResultAtom,
  listTracesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import type { ChartLegendMode, ChartTooltipMode } from "@maple/ui/components/charts/_shared/chart-types"

const endpointDetailSearchSchema = Schema.Struct({
  service: Schema.String,
  endpoint: Schema.String,
  method: Schema.String,
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/endpoints/detail")({
  component: EndpointDetailPage,
  validateSearch: Schema.standardSchemaV1(endpointDetailSearchSchema),
})

interface EndpointChartConfig {
  id: string
  chartId: string
  title: string
  layout: { x: number; y: number; w: number; h: number }
  legend?: ChartLegendMode
  tooltip?: ChartTooltipMode
}

const ENDPOINT_CHARTS: EndpointChartConfig[] = [
  { id: "latency", chartId: "latency-line", title: "Latency", layout: { x: 0, y: 0, w: 6, h: 4 }, legend: "visible", tooltip: "visible" },
  { id: "throughput", chartId: "throughput-area", title: "Throughput", layout: { x: 6, y: 0, w: 6, h: 4 }, tooltip: "visible" },
  { id: "error-rate", chartId: "error-rate-area", title: "Error Rate", layout: { x: 0, y: 4, w: 6, h: 4 }, tooltip: "visible" },
]

function EndpointDetailPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime)

  const durationSeconds = Math.max(
    (new Date(effectiveEndTime).getTime() - new Date(effectiveStartTime).getTime()) / 1000,
    1,
  )

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
      search: {
        ...search,
        startTime,
        endTime,
        timePreset: presetValue,
      },
    })
  }

  // Time series data for charts
  const timeSeriesResult = useAtomValue(
    getEndpointDetailTimeSeriesResultAtom({
      data: {
        serviceName: search.service,
        spanName: search.endpoint,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  // Status code breakdown
  const statusCodeResult = useAtomValue(
    getEndpointStatusCodeBreakdownResultAtom({
      data: {
        serviceName: search.service,
        spanName: search.endpoint,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
      },
    }),
  )

  // Overview stats (reuse existing endpoint, filter client-side)
  const overviewResult = useAtomValue(
    getHttpEndpointsOverviewResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: [search.service],
      },
    }),
  )

  // Recent traces — filter by http.route attribute since endpointName
  // comes from http.route (not rootSpanName which list_traces filters on)
  const tracesResult = useAtomValue(
    listTracesResultAtom({
      data: {
        service: search.service,
        httpMethod: search.method,
        attributeKey: "http.route",
        attributeValue: search.endpoint,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        limit: 20,
      },
    }),
  )

  // Extract matching endpoint from overview
  const matchingEndpoint = Result.builder(overviewResult)
    .onSuccess((response) =>
      response.data.find(
        (ep) =>
          ep.serviceName === search.service &&
          ep.endpointName === search.endpoint &&
          ep.httpMethod === search.method,
      ),
    )
    .orElse(() => undefined)

  // Chart data
  const detailPoints = Result.builder(timeSeriesResult)
    .onSuccess((response) => response.data as unknown as Record<string, unknown>[])
    .orElse(() => [])

  const metrics = ENDPOINT_CHARTS.map((chart) => ({
    id: chart.id,
    chartId: chart.chartId,
    title: chart.title,
    layout: chart.layout,
    data: detailPoints,
    legend: chart.legend,
    tooltip: chart.tooltip,
  }))

  // Status code data
  const statusCodeData = Result.builder(statusCodeResult)
    .onSuccess((response) => response.data)
    .orElse(() => [])

  // Traces data
  const traces = Result.builder(tracesResult)
    .onSuccess((response) => response.data)
    .orElse(() => [])

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Endpoints", href: "/endpoints" },
        { label: `${search.method} ${search.endpoint}` },
      ]}
      titleContent={
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MethodBadge method={search.method} />
            <h1 className="text-2xl font-bold tracking-tight font-mono truncate" title={search.endpoint}>
              {search.endpoint}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Service:{" "}
            <Link
              to="/services/$serviceName"
              params={{ serviceName: search.service }}
              search={{ startTime: search.startTime, endTime: search.endTime }}
              className="text-primary hover:underline"
            >
              {search.service}
            </Link>
          </p>
        </div>
      }
      headerActions={
        <TimeRangePicker
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "12h"}
          onChange={handleTimeChange}
        />
      }
    >
      <div className="space-y-6">
        {/* Summary Stats */}
        <EndpointSummaryStats endpoint={matchingEndpoint} durationSeconds={durationSeconds} />

        {/* Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Latency, Throughput, Error Rate charts */}
          <div className="md:col-span-2">
            <MetricsGrid items={metrics} />
          </div>

          {/* Status Code Breakdown */}
          <div className="md:col-span-2 lg:col-span-1">
            <ReadonlyWidgetShell title="Status Code Distribution">
              <EndpointStatusBreakdown data={statusCodeData} />
            </ReadonlyWidgetShell>
          </div>
        </div>

        {/* Recent Traces */}
        <div>
          <h2 className="mb-3 text-lg font-semibold">Recent Traces</h2>
          <EndpointRecentTraces
            traces={traces}
            service={search.service}
            endpoint={search.endpoint}
            method={search.method}
            startTime={search.startTime}
            endTime={search.endTime}
          />
        </div>
      </div>
    </DashboardLayout>
  )
}
