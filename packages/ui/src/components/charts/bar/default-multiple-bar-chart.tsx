"use client"

import { useId } from "react"
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { multiBarData } from "../_shared/sample-data"
import { DottedPattern } from "../_shared/svg-patterns"

const chartConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function DefaultMultipleBarChart({ data = multiBarData, className }: BaseChartProps) {
  const id = useId()
  const desktopPatternId = `multi-bar-dots-desktop-${id}`
  const mobilePatternId = `multi-bar-dots-mobile-${id}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <BarChart data={data} barSize={20} barGap={4}>
        <defs>
          <DottedPattern id={desktopPatternId} />
          <DottedPattern id={mobilePatternId} />
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} />
        <Bar
          dataKey="desktop"
          fill={`url(#${desktopPatternId})`}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="mobile"
          fill={`url(#${mobilePatternId})`}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
