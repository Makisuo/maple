import { useId } from "react"
import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { lineTimeSeriesData } from "../_shared/sample-data"
import { GlowFilter, RainbowGradient } from "../_shared/svg-filters"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function RainbowGlowGradientLineChart({ data, className }: BaseChartProps) {
  const id = useId()
  const rainbowId = `rainbow-${id.replace(/:/g, "")}`
  const glowId = `glow-${id.replace(/:/g, "")}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data ?? lineTimeSeriesData}>
        <defs>
          <RainbowGradient id={rainbowId} />
          <GlowFilter id={glowId} />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="monotone"
          dataKey="value"
          stroke={`url(#${rainbowId})`}
          style={{ filter: `url(#${glowId})` }}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
