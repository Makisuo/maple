"use client"

import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { radarData } from "../_shared/sample-data"

const chartConfig = {
  a: { label: "Student A", color: "var(--chart-1)" },
} satisfies ChartConfig

export function StrokeRadarChart({ data = radarData, className }: BaseChartProps) {
  return (
    <ChartContainer config={chartConfig} className={className}>
      <RadarChart data={data}>
        <PolarGrid />
        <PolarAngleAxis dataKey="subject" />
        <Radar
          dataKey="a"
          stroke="var(--color-a)"
          strokeWidth={2}
          fillOpacity={0.1}
          fill="var(--color-a)"
          isAnimationActive={false}
        />
      </RadarChart>
    </ChartContainer>
  )
}
