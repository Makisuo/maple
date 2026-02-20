import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type GetMetricTimeSeriesInput, type MetricTimeSeriesResponse } from "@/api/tinybird/metrics"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { getMetricTimeSeriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"

const chartConfig = {
  avgValue: {
    label: "Avg Value",
    color: "var(--color-primary)",
  },
  dataPointCount: {
    label: "Data Points",
    color: "var(--color-secondary)",
  },
} satisfies ChartConfig

interface MetricsVolumeChartProps {
  metricName: string | null
  metricType: GetMetricTimeSeriesInput["metricType"] | null
}

export function MetricsVolumeChart({ metricName, metricType }: MetricsVolumeChartProps) {
  const chartResult = useAtomValue(
    metricName && metricType
      ? getMetricTimeSeriesResultAtom({
        data: {
          metricName,
          metricType,
          bucketSeconds: 60,
        },
      })
      : disabledResultAtom<MetricTimeSeriesResponse>(),
  )

  if (!metricName || !metricType) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Metric Trend</CardTitle>
          <CardDescription>Select a metric from the table below to view its trend</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-[200px] items-center justify-center text-muted-foreground">
            No metric selected
          </div>
        </CardContent>
      </Card>
    )
  }

  return Result.builder(chartResult)
    .onInitial(() => (
      <Card>
        <CardHeader>
          <CardTitle>{metricName}</CardTitle>
          <CardDescription>Loading trend data...</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    ))
    .onError((error) => (
      <Card>
        <CardHeader>
          <CardTitle>{metricName}</CardTitle>
          <CardDescription>Failed to load trend data</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-[200px] items-center justify-center text-destructive">
            {error.message}
          </div>
        </CardContent>
      </Card>
    ))
    .onSuccess((response) => {
      const chartData = response.data.map((point) => ({
        time: new Date(point.bucket).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        avgValue: point.avgValue,
        dataPointCount: point.dataPointCount,
      }))

      return (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-sm">{metricName}</CardTitle>
            <CardDescription>
              Time series showing average value over time
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-muted-foreground">
                No data available for this time range
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[200px] w-full">
                <AreaChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="fillAvgValue" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        stopColor="var(--color-avgValue)"
                        stopOpacity={0.8}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--color-avgValue)"
                        stopOpacity={0.1}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={10}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={10}
                    width={60}
                    tickFormatter={(value) => {
                      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
                      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
                      return value.toFixed(2)
                    }}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent indicator="line" />}
                  />
                  <Area
                    dataKey="avgValue"
                    type="monotone"
                    fill="url(#fillAvgValue)"
                    stroke="var(--color-avgValue)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      )
    })
    .render()
}
