import * as React from "react"
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import type { AlertSignalType } from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@maple/ui/components/ui/chart"
import { formatNumber, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

interface AlertPreviewChartProps {
  data?: Record<string, unknown>[]
  threshold: number
  signalType: AlertSignalType
  loading?: boolean
  className?: string
}

function asFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatBucketTime(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function AlertPreviewChart({
  data,
  threshold,
  signalType,
  loading,
  className,
}: AlertPreviewChartProps) {
  const { chartData, seriesKey, seriesLabel } = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return { chartData: [], seriesKey: "value", seriesLabel: "value" }
    }

    // Find the first non-bucket key as the series
    let seriesLabel = "value"
    for (const row of data) {
      for (const key of Object.keys(row)) {
        if (key !== "bucket") {
          seriesLabel = key
          break
        }
      }
      if (seriesLabel !== "value") break
    }

    const chartData = data.map((row) => ({
      bucket: row.bucket,
      value: asFiniteNumber(row[seriesLabel]),
    }))

    return { chartData, seriesKey: "value", seriesLabel }
  }, [data])

  const axisContext = React.useMemo(
    () => ({
      rangeMs: inferRangeMs(chartData),
      bucketSeconds: inferBucketSeconds(
        chartData
          .map((row) => ({ bucket: formatBucketTime(row.bucket) }))
          .filter((row) => row.bucket.length > 0),
      ),
    }),
    [chartData],
  )

  const chartConfig: ChartConfig = React.useMemo(
    () => ({
      value: {
        label: seriesLabel,
        color: "var(--chart-1)",
      },
    }),
    [seriesLabel],
  )

  const yAxisFormatter = React.useCallback(
    (value: unknown) => formatSignalValue(signalType, asFiniteNumber(value)),
    [signalType],
  )

  // Ensure the threshold line is visible in the y-axis domain
  const yDomain = React.useMemo(() => {
    if (chartData.length === 0) return [0, threshold * 1.5]
    const maxVal = Math.max(...chartData.map((d) => d.value))
    const upper = Math.max(maxVal * 1.15, threshold * 1.3)
    return [0, upper]
  }, [chartData, threshold])

  if (loading) {
    return <Skeleton className={className ?? "h-[300px] w-full"} />
  }

  if (chartData.length === 0) {
    return (
      <div className={`flex items-center justify-center text-muted-foreground text-sm ${className ?? "h-[300px] w-full"}`}>
        Select a signal type to preview data
      </div>
    )
  }

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={chartData} accessibilityLayer>
        <defs>
          <linearGradient id="alert-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.8} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value) => formatBucketLabel(value, axisContext, "tick")}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={yAxisFormatter}
          domain={yDomain}
        />

        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                if (!payload?.[0]?.payload?.bucket) return ""
                return formatBucketLabel(payload[0].payload.bucket, axisContext, "tooltip")
              }}
              formatter={(value) => (
                <span className="flex items-center gap-2">
                  <span className="shrink-0 size-2.5 rounded-[2px]" style={{ backgroundColor: "var(--color-value)" }} />
                  <span className="text-muted-foreground">{seriesLabel}</span>
                  <span className="font-mono font-medium">
                    {formatSignalValue(signalType, asFiniteNumber(value))}
                  </span>
                </span>
              )}
            />
          }
        />

        <ReferenceLine
          y={threshold}
          stroke="hsl(var(--destructive))"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          label={{
            value: `Threshold: ${formatSignalValue(signalType, threshold)}`,
            position: "insideTopRight",
            fill: "hsl(var(--destructive))",
            fontSize: 11,
          }}
        />

        <Area
          type="monotone"
          dataKey={seriesKey}
          stroke="var(--color-value)"
          fill="url(#alert-fill)"
          strokeWidth={2}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
