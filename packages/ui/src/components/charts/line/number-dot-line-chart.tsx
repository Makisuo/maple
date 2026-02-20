import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { lineTimeSeriesData } from "../_shared/sample-data"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

function NumberDot(props: Record<string, unknown>) {
  const { cx, cy, value } = props as {
    cx: number
    cy: number
    value: number
  }

  return (
    <g>
      <circle cx={cx} cy={cy} r={12} fill="var(--color-value)" />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize={10}
        fontWeight={500}
      >
        {value}
      </text>
    </g>
  )
}

export function NumberDotLineChart({ data, className }: BaseChartProps) {
  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data ?? lineTimeSeriesData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          dot={<NumberDot />}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
