"use client"

import { useMemo } from "react"
import { RadialBar, RadialBarChart } from "recharts"
import { ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { buildChartConfig } from "../_shared/build-chart-config"
import { radialData } from "../_shared/sample-data"

export function DefaultRadialChart({ data = radialData, className }: BaseChartProps) {
  const { config, data: coloredData } = useMemo(() => buildChartConfig(data), [data])

  return (
    <ChartContainer config={config} className={className}>
      <RadialBarChart
        data={coloredData}
        innerRadius={30}
        outerRadius={110}
      >
        <RadialBar
          dataKey="value"
          cornerRadius={10}
          background
          isAnimationActive={false}
        />
      </RadialBarChart>
    </ChartContainer>
  )
}
