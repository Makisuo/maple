import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { lineTimeSeriesData } from "../_shared/sample-data"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

function PingingDot(props: Record<string, unknown>) {
  const { cx, cy, index, dataLength } = props as {
    cx: number
    cy: number
    index: number
    dataLength: number
  }

  if (index !== dataLength - 1) return null

  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill="var(--color-value)" opacity={0.4}>
        <animate
          attributeName="r"
          from="6"
          to="16"
          dur="1.5s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="opacity"
          from="0.4"
          to="0"
          dur="1.5s"
          repeatCount="indefinite"
        />
      </circle>
      <circle cx={cx} cy={cy} r={4} fill="var(--color-value)" />
    </g>
  )
}

export function PingingDotChart({ data, className }: BaseChartProps) {
  const chartData = data ?? lineTimeSeriesData

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          dot={(props) => (
            <PingingDot
              key={props.index}
              {...props}
              dataLength={chartData.length}
            />
          )}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
