"use client"

import { useId } from "react"
import { PolarAngleAxis, PolarGrid, Radar, RadarChart } from "recharts"
import { type ChartConfig, ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { radarData } from "../_shared/sample-data"
import { GlowFilter } from "../_shared/svg-filters"

const chartConfig = {
  a: { label: "Student A", color: "var(--chart-1)" },
} satisfies ChartConfig

export function GlowingStrokeRadarChart({ data = radarData, className }: BaseChartProps) {
  const id = useId()
  const glowId = `radar-glow-${id}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <RadarChart data={data}>
        <defs>
          <GlowFilter id={glowId} />
        </defs>
        <PolarGrid />
        <PolarAngleAxis dataKey="subject" />
        <Radar
          dataKey="a"
          stroke="var(--color-a)"
          strokeWidth={2}
          fill="none"
          isAnimationActive={false}
          style={{ filter: `url(#${glowId})` }}
        />
      </RadarChart>
    </ChartContainer>
  )
}
