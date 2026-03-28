import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result } from "@/lib/effect-atom"
import { Schema } from "effect"
import { toast } from "sonner"
import { formatDistanceToNow, format } from "date-fns"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@maple/ui/components/ui/chart"
import {
  formatDuration,
  formatNumber,
  formatBucketLabel,
  inferBucketSeconds,
  inferRangeMs,
} from "@/lib/format"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { HttpSpanLabel } from "@/components/traces/http-span-label"
import {
  getErrorsByTypeResultAtom,
  getErrorDetailTracesResultAtom,
  getErrorsTimeseriesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { computeBucketSeconds, toIsoBucket } from "@/api/tinybird/timeseries-utils"
import { OptionalStringArrayParam } from "@/lib/search-params"
import type { ErrorByType, ErrorDetailTrace, ErrorsTimeseriesItem } from "@/api/tinybird/errors"

const errorDetailSearchSchema = Schema.Struct({
  startTime: Schema.optional(Schema.String),
  endTime: Schema.optional(Schema.String),
  timePreset: Schema.optional(Schema.String),
  services: OptionalStringArrayParam,
})

export const Route = createFileRoute("/errors/$errorType")({
  component: ErrorDetailPage,
  validateSearch: Schema.toStandardSchemaV1(errorDetailSearchSchema),
})

function ErrorDetailPage() {
  const search = Route.useSearch()
  return (
    <PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
      <ErrorDetailContent />
    </PageRefreshProvider>
  )
}

function truncateErrorType(errorType: string, maxLength = 50): string {
  if (errorType.length <= maxLength) return errorType
  return `${errorType.slice(0, maxLength)}...`
}

function ErrorDetailContent() {
  const { errorType: rawErrorType } = Route.useParams()
  const errorType = decodeURIComponent(rawErrorType)
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(search.startTime, search.endTime, search.timePreset ?? "24h")

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

  const bucketSeconds = computeBucketSeconds(effectiveStartTime, effectiveEndTime)

  const errorResult = useRefreshableAtomValue(
    getErrorsByTypeResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: search.services,
        errorTypes: [errorType],
      },
    }),
  )

  const tracesResult = useRefreshableAtomValue(
    getErrorDetailTracesResultAtom({
      data: {
        errorType,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: search.services,
        limit: 20,
      },
    }),
  )

  const timeseriesResult = useRefreshableAtomValue(
    getErrorsTimeseriesResultAtom({
      data: {
        errorType,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        services: search.services,
        bucketSeconds,
      },
    }),
  )

  const statsSection = Result.builder(errorResult)
    .onInitial(() => (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    ))
    .onError(() => null)
    .onSuccess((data: { data: ErrorByType[] }) => {
      const error = data.data[0]
      if (!error) return null

      return (
        <div
          className={`grid grid-cols-2 gap-4 lg:grid-cols-4 transition-opacity ${errorResult.waiting ? "opacity-60" : ""}`}
        >
          <StatCard label="Total Occurrences" value={formatNumber(error.count)} />
          <StatCard
            label="First Seen"
            value={formatDistanceToNow(error.firstSeen, { addSuffix: true })}
            sub={format(error.firstSeen, "MMM d, yyyy HH:mm:ss")}
          />
          <StatCard
            label="Last Seen"
            value={formatDistanceToNow(error.lastSeen, { addSuffix: true })}
            sub={format(error.lastSeen, "MMM d, yyyy HH:mm:ss")}
          />
          <StatCard label="Affected Services" value={String(error.affectedServicesCount)} />
        </div>
      )
    })
    .render()

  const messageSection = Result.builder(errorResult)
    .onInitial(() => (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    ))
    .onError(() => null)
    .onSuccess((data: { data: ErrorByType[] }) => {
      const error = data.data[0]
      if (!error) return null

      return (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Error Message</h3>
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
            <pre className="text-sm font-mono whitespace-pre-wrap break-all">
              {error.sampleMessage}
            </pre>
            <button
              type="button"
              className="mt-2 text-xs text-primary hover:underline"
              onClick={() => {
                navigator.clipboard.writeText(error.sampleMessage)
                toast.success("Error message copied to clipboard")
              }}
            >
              Copy error message
            </button>
          </div>
        </div>
      )
    })
    .render()

  const chartSection = Result.builder(timeseriesResult)
    .onInitial(() => (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-[160px] w-full" />
      </div>
    ))
    .onError(() => null)
    .onSuccess((data: { data: ErrorsTimeseriesItem[] }) => {
      const chartData = data.data.map((item) => ({
        bucket: toIsoBucket(item.bucket),
        count: item.count,
      }))

      if (chartData.length === 0) return null

      const rangeMs = inferRangeMs(chartData)
      const dataBucketSeconds = inferBucketSeconds(chartData)

      return (
        <div
          className={`space-y-2 transition-opacity ${timeseriesResult.waiting ? "opacity-60" : ""}`}
        >
          <h3 className="text-sm font-semibold">Error Frequency</h3>
          <ChartContainer config={chartConfig} className="h-[160px] w-full">
            <BarChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                fontSize={10}
                minTickGap={50}
                tickFormatter={(value) =>
                  formatBucketLabel(value, { rangeMs, bucketSeconds: dataBucketSeconds }, "tick")
                }
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                fontSize={10}
                width={40}
                tickFormatter={(value) => formatNumber(value)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) =>
                      formatBucketLabel(
                        value,
                        { rangeMs, bucketSeconds: dataBucketSeconds },
                        "tooltip",
                      )
                    }
                  />
                }
              />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        </div>
      )
    })
    .render()

  const tracesSection = Result.builder(tracesResult)
    .onInitial(() => (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <div className="rounded-md border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 border-b p-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    ))
    .onError(() => (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
        <p className="text-sm text-destructive">Failed to load sample traces</p>
      </div>
    ))
    .onSuccess((data: { data: ErrorDetailTrace[] }) => {
      if (data.data.length === 0) {
        return (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Sample Traces</h3>
            <p className="text-sm text-muted-foreground">
              No traces found for this error in the selected time range.
            </p>
          </div>
        )
      }

      return (
        <div
          className={`space-y-2 transition-opacity ${tracesResult.waiting ? "opacity-60" : ""}`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Sample Traces</h3>
            <span className="text-xs text-muted-foreground">
              Showing {data.data.length} sample traces
            </span>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trace</TableHead>
                  <TableHead>Root Span</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((trace) => (
                  <TableRow key={trace.traceId} className="hover:bg-muted/50">
                    <TableCell>
                      <Link
                        to="/traces/$traceId"
                        params={{ traceId: trace.traceId }}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {trace.traceId.slice(0, 12)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <HttpSpanLabel spanName={trace.rootSpanName} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {trace.services.map((service) => (
                          <Badge key={service} variant="outline" className="text-xs">
                            {service}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatDuration(trace.durationMicros / 1000)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDistanceToNow(trace.startTime, { addSuffix: true })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )
    })
    .render()

  return (
    <DashboardLayout
      breadcrumbs={[
        { label: "Errors", href: "/errors" },
        { label: truncateErrorType(errorType, 50) },
      ]}
      title={errorType}
      headerActions={
        <TimeRangeHeaderControls
          startTime={search.startTime}
          endTime={search.endTime}
          presetValue={search.timePreset ?? "24h"}
          onTimeChange={handleTimeChange}
        />
      }
    >
      <div className="space-y-6">
        {statsSection}
        {messageSection}
        {chartSection}
        {tracesSection}
      </div>
    </DashboardLayout>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border p-4 space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground font-mono">{sub}</p>}
    </div>
  )
}

const chartConfig: ChartConfig = {
  count: {
    label: "Errors",
    color: "var(--color-severity-error)",
  },
}
