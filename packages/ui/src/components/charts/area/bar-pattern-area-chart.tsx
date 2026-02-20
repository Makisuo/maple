import { useId } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { areaTimeSeriesData } from "../_shared/sample-data"
import { BarPattern } from "../_shared/svg-patterns"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function BarPatternAreaChart({ data, className }: BaseChartProps) {
  const id = useId()
  const desktopPatternId = `desktopBar-${id.replace(/:/g, "")}`
  const mobilePatternId = `mobileBar-${id.replace(/:/g, "")}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={data ?? areaTimeSeriesData} accessibilityLayer>
        <defs>
          <BarPattern id={desktopPatternId} />
          <BarPattern id={mobilePatternId} />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <Area
          type="monotone"
          dataKey="desktop"
          stackId="a"
          stroke="var(--color-desktop)"
          fill={`url(#${desktopPatternId})`}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="mobile"
          stackId="a"
          stroke="var(--color-mobile)"
          fill={`url(#${mobilePatternId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
