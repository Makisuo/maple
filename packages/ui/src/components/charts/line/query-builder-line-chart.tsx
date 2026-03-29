import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import { getSemanticSeriesColor } from "../../../lib/semantic-series-colors"
import type { BaseChartProps } from "../_shared/chart-types"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
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
  if (!Number.isFinite(parsed)) {
    return 0
  }

  return parsed
}

function formatBucketTime(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function QueryBuilderLineChart({ data, className, legend, tooltip, curveType }: BaseChartProps) {
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
      const next: Record<string, unknown> = {
        bucket: row.bucket,
      }

      for (const definition of seriesDefinitions) {
        next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
      }

      return next
    })

    return {
      chartData,
      seriesDefinitions,
    }
  }, [data])

  const valueKeys = React.useMemo(
    () => seriesDefinitions.map((d) => d.chartKey),
    [seriesDefinitions],
  )

  const { data: processedData, hasIncomplete, incompleteKeys } = useIncompleteSegments(chartData, valueKeys)

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
    const base = seriesDefinitions.reduce((config, definition, index) => {
      config[definition.chartKey] = {
        label: definition.rawKey,
        color: getSemanticSeriesColor(definition.rawKey) ?? `var(--chart-${(index % 5) + 1})`,
      }
      return config
    }, {} as ChartConfig)
    return extendConfigWithIncomplete(base, incompleteKeys)
  }, [seriesDefinitions, incompleteKeys])

  const labelByChartKey = React.useMemo(() => {
    return new Map(
      seriesDefinitions.map((definition) => [
        definition.chartKey,
        definition.rawKey,
      ]),
    )
  }, [seriesDefinitions])

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={processedData} accessibilityLayer>
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
                  const bucket = payload[0].payload.bucket
                  return formatBucketLabel(bucket, axisContext, "tooltip")
                }}
                formatter={(value, name, item) => {
                  const nameStr = String(name)
                  const isIncomplete = nameStr.endsWith("_incomplete")
                  const baseKey = isIncomplete ? nameStr.replace(/_incomplete$/, "") : nameStr
                  if (isIncomplete && item.payload?.[baseKey] != null) return null
                  if (!isIncomplete && value == null) return null
                  const label = labelByChartKey.get(baseKey) ?? baseKey
                  return (
                    <span className="flex items-center gap-2">
                      <span className="shrink-0 size-2.5 rounded-[2px]" style={{ backgroundColor: item.color }} />
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
        {legend === "right" && <ChartLegend layout="vertical" verticalAlign="middle" align="right" content={<ChartLegendContent />} />}

        {seriesDefinitions.map((definition) => (
          <Line
            key={definition.chartKey}
            type={curveType ?? "linear"}
            dataKey={definition.chartKey}
            stroke={`var(--color-${definition.chartKey})`}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
        {hasIncomplete && seriesDefinitions.map((definition) => (
          <Line
            key={`${definition.chartKey}_incomplete`}
            type={curveType ?? "linear"}
            dataKey={`${definition.chartKey}_incomplete`}
            stroke={`var(--color-${definition.chartKey})`}
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
            legendType="none"
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
