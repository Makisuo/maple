import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useMemo } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getCustomChartTimeSeriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { computeBucketSeconds } from "@/api/tinybird/timeseries-utils"
import {
  formatBucketLabel,
  formatNumber,
  inferBucketSeconds,
  inferRangeMs,
} from "@/lib/format"
import type { LogsSearchParams } from "@/routes/logs"
import { SEVERITY_COLORS, SEVERITY_ORDER } from "@/lib/severity"

/** More bars than the default 40-point target for a denser histogram. */
const HISTOGRAM_TARGET_POINTS = 150

function buildChartConfig(seriesKeys: string[]): ChartConfig {
  const config: ChartConfig = {}
  for (const key of seriesKeys) {
    const upper = key.toUpperCase()
    config[key] = {
      label: upper,
      color: SEVERITY_COLORS[upper] ?? "var(--color-muted-foreground)",
    }
  }
  return config
}

interface LogsVolumeChartProps {
  filters?: LogsSearchParams
}

export function LogsVolumeChart({ filters }: LogsVolumeChartProps) {
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(filters?.startTime, filters?.endTime)

  const bucketSeconds = useMemo(
    () => computeBucketSeconds(effectiveStartTime, effectiveEndTime, HISTOGRAM_TARGET_POINTS),
    [effectiveStartTime, effectiveEndTime],
  )

  const timeSeriesResult = useAtomValue(
    getCustomChartTimeSeriesResultAtom({
      data: {
        source: "logs",
        metric: "count",
        groupBy: "severity",
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        bucketSeconds,
        filters: {
          serviceName: filters?.services?.[0],
          severity: filters?.severities?.[0],
        },
      },
    }),
  )

  return Result.builder(timeSeriesResult)
    .onInitial(() => <Skeleton className="h-[120px] w-full rounded-md" />)
    .onError(() => null)
    .onSuccess((response, result) => {
      const points = response.data
      if (points.length === 0) return null

      const seriesKeysSet = new Set<string>()
      for (const point of points) {
        for (const key of Object.keys(point.series)) {
          seriesKeysSet.add(key)
        }
      }

      const seriesKeys = SEVERITY_ORDER.filter((s) => seriesKeysSet.has(s))
      for (const key of seriesKeysSet) {
        if (!seriesKeys.includes(key)) seriesKeys.push(key)
      }

      const chartData = points.map((point) => ({
        bucket: point.bucket,
        ...point.series,
      }))

      const totalCount = points.reduce((sum, point) => {
        return (
          sum +
          Object.values(point.series).reduce<number>(
            (s, v) => s + (typeof v === "number" ? v : 0),
            0,
          )
        )
      }, 0)

      const chartConfig = buildChartConfig(seriesKeys)
      const rangeMs = inferRangeMs(chartData)
      const dataBucketSeconds = inferBucketSeconds(chartData)

      return (
        <div className={`transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-sm font-medium">{formatNumber(totalCount)} logs</span>
            <span className="text-xs text-muted-foreground">in selected range</span>
          </div>
          <ChartContainer config={chartConfig} className="h-[120px] w-full">
            <BarChart
              data={chartData}
              margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
            >
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
              {seriesKeys.map((key) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId="severity"
                  fill={
                    SEVERITY_COLORS[key.toUpperCase()] ??
                    "var(--color-muted-foreground)"
                  }
                  radius={0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ChartContainer>
        </div>
      )
    })
    .render()
}
