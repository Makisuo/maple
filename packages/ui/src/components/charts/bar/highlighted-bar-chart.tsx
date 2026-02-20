"use client"

import { useState } from "react"
import { Bar, BarChart, CartesianGrid, Cell, XAxis } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { defaultBarData } from "../_shared/sample-data"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function HighlightedBarChart({ data = defaultBarData, className }: BaseChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} />
        <Bar
          dataKey="value"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          onMouseEnter={(_, index) => setActiveIndex(index)}
          onMouseLeave={() => setActiveIndex(null)}
        >
          {data.map((_, index) => (
            <Cell
              key={index}
              fill="var(--color-value)"
              opacity={activeIndex === null || activeIndex === index ? 1 : 0.3}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
