import { useId } from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { areaTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function GradientRoundedAreaChart({ data, className }: BaseChartProps) {
  const id = useId()
  const desktopGradientId = `desktopGradient-${id.replace(/:/g, "")}`
  const mobileGradientId = `mobileGradient-${id.replace(/:/g, "")}`

  return (
    <ChartContainer config={chartConfig} className={className}>
      <AreaChart data={data ?? areaTimeSeriesData} accessibilityLayer>
        <defs>
          <VerticalGradient id={desktopGradientId} color="var(--color-desktop)" />
          <VerticalGradient id={mobileGradientId} color="var(--color-mobile)" />
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <Area
          type="natural"
          dataKey="desktop"
          stackId="a"
          stroke="var(--color-desktop)"
          fill={`url(#${desktopGradientId})`}
          isAnimationActive={false}
        />
        <Area
          type="natural"
          dataKey="mobile"
          stackId="a"
          stroke="var(--color-mobile)"
          fill={`url(#${mobileGradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
