"use client"

import { useId } from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { defaultBarData } from "../_shared/sample-data"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

function GradientBarShape(props: Record<string, unknown>) {
  const { x, y, width, height, fill } = props as {
    x: number
    y: number
    width: number
    height: number
    fill: string
  }

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} rx={4} ry={4} />
      <rect x={x} y={y} width={width} height={2} fill="var(--color-value)" rx={1} />
    </g>
  )
}

export function GradientBarChart({ data = defaultBarData, className }: BaseChartProps) {
  const id = useId()
  const gradientId = `gradient-bar-gradient-${id}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={data}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-value)" stopOpacity={1} />
            <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} />
        <Bar
          dataKey="value"
          fill={`url(#${gradientId})`}
          shape={<GradientBarShape />}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
