import { useId, useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { hostInfraTimeseriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import type { HostInfraMetric } from "@/api/tinybird/infra"
import { formatBytesPerSecond, formatPercent } from "./format"

interface HostDetailChartProps {
  hostName: string
  metric: HostInfraMetric
  startTime: string
  endTime: string
  bucketSeconds?: number
}

function isoToLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

interface TransformedPoint extends Record<string, string | number> {
  bucket: string
  time: string
}

function transformRows(
  rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>,
): { data: TransformedPoint[]; series: string[] } {
  const seriesSet = new Set<string>()
  const byBucket = new Map<string, TransformedPoint>()
  for (const row of rows) {
    const series = row.attributeValue || "value"
    seriesSet.add(series)
    const existing =
      byBucket.get(row.bucket) ?? ({
        bucket: row.bucket,
        time: isoToLabel(row.bucket),
      } as TransformedPoint)
    existing[series] = row.value
    byBucket.set(row.bucket, existing)
  }
  const data = [...byBucket.values()].sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  )
  return { data, series: [...seriesSet] }
}

const COLOR_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-p50)",
]

const CHART_HEIGHT = 220

export function HostDetailChart({
  hostName,
  metric,
  startTime,
  endTime,
  bucketSeconds,
}: HostDetailChartProps) {
  const result = useAtomValue(
    hostInfraTimeseriesResultAtom({
      data: { hostName, metric, startTime, endTime, bucketSeconds },
    }),
  )

  return Result.builder(result)
    .onInitial(() => (
      <Skeleton className="h-[220px] w-full rounded-none" />
    ))
    .onError((err) => (
      <div className="flex h-[220px] items-center justify-center border border-destructive/40 bg-destructive/5 font-mono text-[11px] text-destructive">
        {err.message ?? "Failed to load chart"}
      </div>
    ))
    .onSuccess((response, holder) => (
      <ChartView
        rows={response.data}
        unit={response.unit}
        metric={metric}
        waiting={Boolean(holder.waiting)}
      />
    ))
    .render()
}

interface ChartViewProps {
  rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
  unit: "percent" | "load" | "bytes_per_second"
  metric: HostInfraMetric
  waiting: boolean
}

function ChartView({ rows, unit, metric, waiting }: ChartViewProps) {
  const gradientPrefix = useId().replace(/:/g, "")

  const { data, series } = useMemo(() => transformRows(rows), [rows])

  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        series.map((name, idx) => [
          name,
          {
            label: name || "value",
            color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
          },
        ]),
      ),
    [series],
  )

  const lastValues = useMemo(() => {
    const out: Record<string, number> = {}
    const latest = data[data.length - 1]
    if (!latest) return out
    for (const s of series) {
      const v = latest[s]
      if (typeof v === "number") out[s] = v
    }
    return out
  }, [data, series])

  if (data.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center border border-dashed border-border/60 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        No data
      </div>
    )
  }

  const tickFormatter = (v: number) => {
    if (unit === "percent") return `${Math.round(v * 100)}%`
    if (unit === "bytes_per_second") return formatBytesPerSecond(v)
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }

  const tooltipFormatter = (val: unknown): string => {
    const num = typeof val === "number" ? val : Number(val)
    if (!Number.isFinite(num)) return "—"
    if (unit === "percent") return formatPercent(num)
    if (unit === "bytes_per_second") return formatBytesPerSecond(num)
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }

  const isStacked = metric === "cpu" || metric === "memory"
  const showThreshold = metric === "cpu" || metric === "memory"
  const margin = { top: 12, right: 12, left: 0, bottom: 0 }

  return (
    <div className={cn("transition-opacity", waiting && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-3 py-2">
        {series.map((s) => {
          const value = lastValues[s]
          return (
            <div key={s} className="inline-flex items-baseline gap-1.5">
              <span
                aria-hidden
                className="size-1.5 rounded-full translate-y-[-1px]"
                style={{ background: `var(--color-${s})` }}
              />
              <span className="text-[11px] text-muted-foreground">
                {config[s]?.label ?? s}
              </span>
              {value !== undefined && (
                <span className="font-mono text-[11px] tabular-nums text-foreground/85">
                  {tooltipFormatter(value)}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <ChartContainer
        config={config}
        className="w-full"
        style={{ height: CHART_HEIGHT }}
      >
        {isStacked ? (
          <AreaChart data={data} margin={margin}>
            <defs>
              {series.map((s) => {
                const id = `${gradientPrefix}-${s.replace(/\W+/g, "_")}`
                return (
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor={`var(--color-${s})`}
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="95%"
                      stopColor={`var(--color-${s})`}
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                )
              })}
            </defs>
            <CartesianGrid
              strokeDasharray="2 4"
              stroke="var(--border)"
              vertical={false}
            />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              stroke="var(--muted-foreground)"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              width={52}
              stroke="var(--muted-foreground)"
              tickFormatter={tickFormatter}
            />
            {showThreshold && (
              <ReferenceLine
                y={0.8}
                stroke="var(--severity-warn)"
                strokeOpacity={0.7}
                className="infra-ref-line"
                label={{
                  value: "80%",
                  position: "right",
                  fill: "var(--severity-warn)",
                  fontSize: 9,
                }}
              />
            )}
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  formatter={(v) => tooltipFormatter(v)}
                />
              }
            />
            {series.map((s) => {
              const id = `${gradientPrefix}-${s.replace(/\W+/g, "_")}`
              return (
                <Area
                  key={s}
                  dataKey={s}
                  type="monotone"
                  stackId="a"
                  stroke={`var(--color-${s})`}
                  strokeWidth={1.4}
                  fill={`url(#${id})`}
                  fillOpacity={1}
                />
              )
            })}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={margin}>
            <CartesianGrid
              strokeDasharray="2 4"
              stroke="var(--border)"
              vertical={false}
            />
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              stroke="var(--muted-foreground)"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              width={64}
              stroke="var(--muted-foreground)"
              tickFormatter={tickFormatter}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  indicator="line"
                  formatter={(v) => tooltipFormatter(v)}
                />
              }
            />
            {series.map((s) => (
              <Line
                key={s}
                dataKey={s}
                type="monotone"
                stroke={`var(--color-${s})`}
                strokeWidth={1.6}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            ))}
          </LineChart>
        )}
      </ChartContainer>
    </div>
  )
}

interface MetricStripProps {
  label: string
  caption?: string
  hostName: string
  metric: HostInfraMetric
  startTime: string
  endTime: string
  bucketSeconds?: number
}

export function MetricStrip({
  label,
  caption,
  hostName,
  metric,
  startTime,
  endTime,
  bucketSeconds,
}: MetricStripProps) {
  return (
    <section className="grid grid-cols-1 gap-0 border-t first:border-t-0 lg:grid-cols-[160px_1fr]">
      <div className="border-b px-1 py-3 lg:border-b-0 lg:border-r lg:py-5">
        <div className="text-[12px] font-medium text-foreground">{label}</div>
        {caption ? (
          <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {caption}
          </div>
        ) : null}
      </div>
      <div className="lg:pl-4">
        <HostDetailChart
          hostName={hostName}
          metric={metric}
          startTime={startTime}
          endTime={endTime}
          bucketSeconds={bucketSeconds}
        />
      </div>
    </section>
  )
}
