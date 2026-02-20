import { useId, useMemo } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { apdexTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../../ui/chart"
import { inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const chartConfig = {
  apdexScore: { label: "Apdex", color: "var(--chart-5)" },
} satisfies ChartConfig

export function ApdexAreaChart({ data, className, legend, tooltip }: BaseChartProps) {
  const id = useId()
  const gradientId = `apdexGradient-${id.replace(/:/g, "")}`
  const chartData = data ?? apdexTimeSeriesData

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
          <VerticalGradient id={gradientId} color="var(--color-apdexScore)" />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="bucket"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => formatBucketLabel(v, axisContext, "tick")}
        />
        <YAxis domain={[0, 1]} tickLine={false} axisLine={false} tickMargin={8} />
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
                    <span className="text-muted-foreground">Apdex</span>
                    <span className="font-mono font-medium">{Number(value).toFixed(2)}</span>
                  </span>
                )}
              />
            }
          />
        )}
        {legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
        <Area
          type="monotone"
          dataKey="apdexScore"
          stroke="var(--color-apdexScore)"
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
