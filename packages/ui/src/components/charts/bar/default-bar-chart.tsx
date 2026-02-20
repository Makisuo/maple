"use client"

import { useId } from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { defaultBarData } from "../_shared/sample-data"
import { DottedPattern } from "../_shared/svg-patterns"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function DefaultBarChart({ data = defaultBarData, className }: BaseChartProps) {
  const id = useId()
  const patternId = `default-bar-dots-${id}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={data}>
        <defs>
          <DottedPattern id={patternId} />
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} />
        <Bar
          dataKey="value"
          fill={`url(#${patternId})`}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
