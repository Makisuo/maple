import { useMemo } from "react"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { latencyTimeSeriesData } from "../_shared/sample-data"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../../ui/chart"
import { formatLatency, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const chartConfig = {
  p99LatencyMs: { label: "P99", color: "var(--chart-p99)" },
  p95LatencyMs: { label: "P95", color: "var(--chart-p95)" },
  p50LatencyMs: { label: "P50", color: "var(--chart-p50)" },
} satisfies ChartConfig

export function LatencyLineChart({ data, className, legend, tooltip }: BaseChartProps) {
  const chartData = data ?? latencyTimeSeriesData

  const axisContext = useMemo(
    () => ({
      rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
      bucketSeconds: inferBucketSeconds(chartData as Array<{ bucket: string }>),
    }),
    [chartData],
  )

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={chartData} accessibilityLayer>
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
          tickFormatter={(v) => formatLatency(v)}
        />
        {tooltip !== "hidden" && (
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  if (!payload?.[0]?.payload?.bucket) return ""
                  return formatBucketLabel(payload[0].payload.bucket, axisContext, "tooltip")
                }}
                formatter={(value, name, item) => {
                  const config = chartConfig[name as keyof typeof chartConfig]
                  return (
                    <span className="flex items-center gap-2">
                      <span
                        className="shrink-0 size-2.5 rounded-[2px]"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-muted-foreground">{config?.label ?? name}</span>
                      <span className="font-mono font-medium">{formatLatency(value as number)}</span>
                    </span>
                  )
                }}
              />
            }
          />
        )}
        {legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
        <Line type="monotone" dataKey="p99LatencyMs" stroke="var(--color-p99LatencyMs)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="p95LatencyMs" stroke="var(--color-p95LatencyMs)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="p50LatencyMs" stroke="var(--color-p50LatencyMs)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  )
}
