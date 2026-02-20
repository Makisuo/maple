import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../../ui/chart"
import { formatNumber, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const fallbackData: Record<string, unknown>[] = [
  { bucket: "2026-01-01T00:00:00Z", A: 12, B: 8 },
  { bucket: "2026-01-01T01:00:00Z", A: 15, B: 9 },
  { bucket: "2026-01-01T02:00:00Z", A: 11, B: 10 },
  { bucket: "2026-01-01T03:00:00Z", A: 18, B: 12 },
  { bucket: "2026-01-01T04:00:00Z", A: 16, B: 11 },
]

function asFiniteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatBucketTime(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function QueryBuilderBarChart({ data, className, legend, tooltip }: BaseChartProps) {
  const { chartData, seriesDefinitions } = React.useMemo(() => {
    const source = Array.isArray(data) && data.length > 0 ? data : fallbackData
    const rawSeriesKeys: string[] = []
    const seenSeriesKeys = new Set<string>()

    for (const row of source) {
      for (const key of Object.keys(row)) {
        if (key === "bucket" || seenSeriesKeys.has(key)) continue
        seenSeriesKeys.add(key)
        rawSeriesKeys.push(key)
      }
    }

    const seriesDefinitions = rawSeriesKeys.map((rawKey, index) => ({
      rawKey,
      chartKey: `s${index + 1}`,
    }))

    const chartData = source.map((row) => {
      const next: Record<string, unknown> = { bucket: row.bucket }
      for (const definition of seriesDefinitions) {
        next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
      }
      return next
    })

    return { chartData, seriesDefinitions }
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

  const chartConfig = React.useMemo(() => {
    return seriesDefinitions.reduce((config, definition, index) => {
      config[definition.chartKey] = {
        label: definition.rawKey,
        color: `var(--chart-${(index % 5) + 1})`,
      }
      return config
    }, {} as ChartConfig)
  }, [seriesDefinitions])

  const labelByChartKey = React.useMemo(() => {
    return new Map(
      seriesDefinitions.map((definition) => [definition.chartKey, definition.rawKey]),
    )
  }, [seriesDefinitions])

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={chartData} accessibilityLayer>
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
          tickFormatter={(value) => formatNumber(asFiniteNumber(value))}
        />

        {tooltip !== "hidden" && (
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  if (!payload?.[0]?.payload?.bucket) return ""
                  return formatBucketLabel(payload[0].payload.bucket, axisContext, "tooltip")
                }}
                formatter={(value, name) => {
                  const label = labelByChartKey.get(String(name)) ?? String(name)
                  return (
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-mono font-medium">
                        {formatNumber(asFiniteNumber(value))}
                      </span>
                    </span>
                  )
                }}
              />
            }
          />
        )}

        {legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}

        {seriesDefinitions.map((definition) => (
          <Bar
            key={definition.chartKey}
            dataKey={definition.chartKey}
            fill={`var(--color-${definition.chartKey})`}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}
