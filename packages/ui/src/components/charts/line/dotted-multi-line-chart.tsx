import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { multiLineData } from "../_shared/sample-data"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  desktop: { label: "Desktop", color: "var(--chart-1)" },
  mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function DottedMultiLineChart({ data, className }: BaseChartProps) {
  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={data ?? multiLineData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="linear"
          dataKey="desktop"
          stroke="var(--color-desktop)"
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="linear"
          dataKey="mobile"
          stroke="var(--color-mobile)"
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
