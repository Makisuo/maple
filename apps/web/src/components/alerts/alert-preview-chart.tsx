import * as React from "react"
import { Area, AreaChart, CartesianGrid, Legend, ReferenceLine, XAxis, YAxis } from "recharts"

import type { AlertSignalType } from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@maple/ui/components/ui/chart"
import { inferBucketSeconds, inferRangeMs, formatBucketLabel } from "@maple/ui/lib/format"
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

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function AlertPreviewChart({
  data,
  threshold,
  signalType,
  loading,
  className,
}: AlertPreviewChartProps) {
  const { chartData, seriesKeys, seriesLabels } = React.useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return { chartData: [], seriesKeys: ["value"], seriesLabels: ["value"] }
    }

    // Collect all non-bucket keys across all rows
    const keySet = new Set<string>()
    for (const row of data) {
      for (const key of Object.keys(row)) {
        if (key !== "bucket") keySet.add(key)
      }
    }
    const allKeys = Array.from(keySet)

    if (allKeys.length === 0) {
      return { chartData: [], seriesKeys: ["value"], seriesLabels: ["value"] }
    }

    // Single series: flatten to "value" key (preserves old behavior)
    if (allKeys.length === 1) {
      const label = allKeys[0]!
      const chartData: Record<string, unknown>[] = data.map((row) => ({
        bucket: row.bucket,
        value: asFiniteNumber(row[label]),
      }))
      return { chartData, seriesKeys: ["value"], seriesLabels: [label] }
    }

    // Multiple series: keep each service as its own key
    const chartData: Record<string, unknown>[] = data.map((row) => {
      const point: Record<string, unknown> = { bucket: row.bucket }
      for (const key of allKeys) {
        point[key] = asFiniteNumber(row[key])
      }
      return point
    })
    return { chartData, seriesKeys: allKeys, seriesLabels: allKeys }
  }, [data])

  const isMultiSeries = seriesKeys.length > 1

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

  const chartConfig: ChartConfig = React.useMemo(() => {
    const config: ChartConfig = {}
    for (let i = 0; i < seriesKeys.length; i++) {
      config[seriesKeys[i]!] = {
        label: seriesLabels[i]!,
        color: SERIES_COLORS[i % SERIES_COLORS.length]!,
      }
    }
    return config
  }, [seriesKeys, seriesLabels])

  const yAxisFormatter = React.useCallback(
    (value: unknown) => formatSignalValue(signalType, asFiniteNumber(value)),
    [signalType],
  )

  // Ensure the threshold line is visible in the y-axis domain
  const yDomain = React.useMemo(() => {
    if (chartData.length === 0) return [0, threshold * 1.5]
    let maxVal = 0
    for (const d of chartData) {
      for (const key of seriesKeys) {
        maxVal = Math.max(maxVal, asFiniteNumber(d[key]))
      }
    }
    const upper = Math.max(maxVal * 1.15, threshold * 1.3)
    return [0, upper]
  }, [chartData, threshold, seriesKeys])

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
          {seriesKeys.map((key, i) => (
            <linearGradient key={key} id={`alert-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={isMultiSeries ? 0.4 : 0.8} />
              <stop offset="95%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.05} />
            </linearGradient>
          ))}
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
              formatter={(value, name) => (
                <span className="flex items-center gap-2">
                  <span
                    className="shrink-0 size-2.5 rounded-[2px]"
                    style={{ backgroundColor: chartConfig[name as string]?.color ?? "var(--chart-1)" }}
                  />
                  <span className="text-muted-foreground">{chartConfig[name as string]?.label ?? name}</span>
                  <span className="font-mono font-medium">
                    {formatSignalValue(signalType, asFiniteNumber(value))}
                  </span>
                </span>
              )}
            />
          }
        />

        {isMultiSeries && (
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ overflowX: "auto", overflowY: "hidden", whiteSpace: "nowrap" }}
            formatter={(value: string) => (
              <span className="text-xs text-muted-foreground">{value}</span>
            )}
          />
        )}

        <ReferenceLine
          y={threshold}
          stroke="var(--destructive)"
          strokeDasharray="6 4"
          strokeWidth={1.5}
          label={{
            value: `Threshold: ${formatSignalValue(signalType, threshold)}`,
            position: "insideTopRight",
            fill: "var(--destructive)",
            fontSize: 11,
          }}
        />

        {seriesKeys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={`url(#alert-fill-${i})`}
            strokeWidth={isMultiSeries ? 1.5 : 2}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}
