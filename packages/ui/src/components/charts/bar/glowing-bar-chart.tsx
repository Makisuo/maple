"use client"

import { useId } from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { multiBarData } from "../_shared/sample-data"
import { GlowFilter } from "../_shared/svg-filters"

const chartConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function GlowingBarChart({ data = multiBarData, className }: BaseChartProps) {
  const id = useId()
  const glowId = `glowing-bar-glow-${id}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={data}>
        <defs>
          <GlowFilter id={glowId} />
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} />
        <Bar
          dataKey="desktop"
          stackId="a"
          fill="var(--color-desktop)"
          radius={[0, 0, 0, 0]}
          isAnimationActive={false}
          style={{ filter: `url(#${glowId})` }}
        />
        <Bar
          dataKey="mobile"
          stackId="a"
          fill="var(--color-mobile)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          style={{ filter: `url(#${glowId})` }}
        />
      </BarChart>
    </ChartContainer>
  )
}
