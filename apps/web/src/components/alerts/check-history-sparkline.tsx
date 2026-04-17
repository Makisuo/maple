import * as React from "react"
import {
  CartesianGrid,
  Dot,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import type { AlertCheckDocument, AlertSignalType } from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@maple/ui/components/ui/chart"

interface CheckHistorySparklineProps {
  checks: ReadonlyArray<AlertCheckDocument>
  threshold: number
  signalType: AlertSignalType
  className?: string
}

const chartConfig = {
  value: {
    label: "Observed",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig

interface ChartPoint {
  t: number
  value: number | null
  status: AlertCheckDocument["status"]
}

export function CheckHistorySparkline({
  checks,
  threshold,
  signalType,
  className,
}: CheckHistorySparklineProps) {
  const data = React.useMemo<ChartPoint[]>(() => {
    return [...checks]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map((check) => ({
        t: new Date(check.timestamp).getTime(),
        value: check.observedValue,
        status: check.status,
      }))
  }, [checks])

  if (data.length === 0) {
    return null
  }

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="t"
          tickFormatter={(v: number) =>
            new Date(v).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          }
          fontSize={11}
        />
        <YAxis
          tickFormatter={(v: number) => formatSignalValue(signalType, v)}
          fontSize={11}
          width={52}
        />
        <ReferenceLine
          y={threshold}
          stroke="var(--destructive)"
          strokeDasharray="4 4"
          label={{
            value: `threshold ${formatSignalValue(signalType, threshold)}`,
            position: "insideTopRight",
            fontSize: 10,
            fill: "var(--destructive)",
          }}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const raw = payload?.[0]?.payload as ChartPoint | undefined
                return raw ? new Date(raw.t).toLocaleString() : ""
              }}
              formatter={(value) => (
                <span className="font-mono font-medium">
                  {typeof value === "number" ? formatSignalValue(signalType, value) : String(value)}
                </span>
              )}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={1.5}
          dot={(props) => {
            const payload = props.payload as ChartPoint
            const color =
              payload.status === "breached"
                ? "var(--destructive)"
                : "var(--color-value)"
            return (
              <Dot
                {...props}
                r={payload.status === "breached" ? 3 : 1.5}
                fill={color}
                stroke={color}
              />
            )
          }}
          isAnimationActive={false}
          connectNulls
        />
      </LineChart>
    </ChartContainer>
  )
}
