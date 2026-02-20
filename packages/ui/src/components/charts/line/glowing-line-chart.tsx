import { useId } from "react"
import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { lineTimeSeriesData } from "../_shared/sample-data"
import { GlowFilter } from "../_shared/svg-filters"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function GlowingLineChart({ data, className }: BaseChartProps) {
  const id = useId()
  const glowId = `glow-${id.replace(/:/g, "")}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data ?? lineTimeSeriesData}>
        <defs>
          <GlowFilter id={glowId} />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="bump"
          dataKey="value"
          stroke="var(--color-value)"
          dot={false}
          style={{ filter: `url(#${glowId})` }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
