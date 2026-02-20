"use client"

import { useMemo } from "react"
import { LabelList, Pie, PieChart } from "recharts"
import { ChartContainer } from "../../ui/chart"
import type { BaseChartProps } from "../_shared/chart-types"
import { buildChartConfig } from "../_shared/build-chart-config"
import { pieData } from "../_shared/sample-data"

export function RoundedPieChart({ data = pieData, className }: BaseChartProps) {
  const { config, data: coloredData } = useMemo(() => buildChartConfig(data), [data])

  return (
    <ChartContainer config={config} className={className}>
      <PieChart>
        <Pie
          data={coloredData}
          dataKey="value"
          nameKey="name"
          innerRadius={60}
          cornerRadius={8}
          paddingAngle={4}
          isAnimationActive={false}
        >
          <LabelList dataKey="value" position="outside" />
        </Pie>
      </PieChart>
    </ChartContainer>
  )
}
