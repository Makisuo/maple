import { useMemo, useId } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "@/components/charts/_shared/chart-types"
import { throughputTimeSeriesData } from "@/components/charts/_shared/sample-data"
import { VerticalGradient } from "@/components/charts/_shared/svg-patterns"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { inferBucketSeconds, inferRangeMs, formatBucketLabel, bucketIntervalLabel, formatThroughput } from "@/lib/format"

export function ThroughputAreaChart({ data, className, legend, tooltip }: BaseChartProps) {
  const id = useId()
  const gradientId = `throughputGradient-${id.replace(/:/g, "")}`
  const chartData = data ?? throughputTimeSeriesData

  const bucketSeconds = useMemo(
    () => inferBucketSeconds(chartData as Array<{ bucket: string }>),
    [chartData],
  )

  const rateLabel = useMemo(() => bucketIntervalLabel(bucketSeconds), [bucketSeconds])

  const axisContext = useMemo(
    () => ({
      rangeMs: inferRangeMs(chartData as Array<Record<string, unknown>>),
      bucketSeconds,
    }),
    [chartData, bucketSeconds],
  )

  const chartConfig = useMemo(
    () =>
      ({
        throughput: {
          label: rateLabel ? `Throughput (${rateLabel})` : "Throughput",
          color: "var(--chart-4)",
        },
      }) satisfies ChartConfig,
    [rateLabel],
  )

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={chartData} accessibilityLayer>
        <defs>
          <VerticalGradient id={gradientId} color="var(--color-throughput)" />
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
          tickFormatter={(value: number) => formatThroughput(value, rateLabel)}
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
                    <span className="text-muted-foreground">Throughput</span>
                    <span className="font-mono font-medium">
                      {Number(value).toLocaleString()}{rateLabel}
                    </span>
                  </span>
                )}
              />
            }
          />
        )}
        {legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
        <Area
          type="monotone"
          dataKey="throughput"
          stroke="var(--color-throughput)"
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
