import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { errorRateTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../../ui/chart"
import { formatErrorRate, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const chartConfig = {
  errorRate: { label: "Error Rate", color: "var(--color-destructive, #ef4444)" },
} satisfies ChartConfig

export function ErrorRateAreaChart({ data, className, legend, tooltip }: BaseChartProps) {
  const id = useId()
  const gradientId = `errorRateGradient-${id.replace(/:/g, "")}`
  const chartData = data ?? errorRateTimeSeriesData

  const axisContext = useMemo(
    () => ({
      rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
      bucketSeconds: inferBucketSeconds(chartData as Array<{ bucket: string }>),
    }),
    [chartData],
  )

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={chartData} accessibilityLayer>
        <defs>
          <VerticalGradient id={gradientId} color="var(--color-errorRate)" />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => formatBucketLabel(v, axisContext, "tick")}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => formatErrorRate(v)}
        />
        {tooltip !== "hidden" && (
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  if (!payload?.[0]?.payload?.bucket) return ""
                  return formatBucketLabel(payload[0].payload.bucket, axisContext, "tooltip")
                }}
                formatter={(value) => (
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">Error Rate</span>
                    <span className="font-mono font-medium">{formatErrorRate(value as number)}</span>
                  </span>
                )}
              />
            }
          />
        )}
        {legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
        <Area
          type="monotone"
          dataKey="errorRate"
          stroke="var(--color-errorRate)"
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
