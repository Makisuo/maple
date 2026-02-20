import { CartesianGrid, Customized, Line, LineChart, XAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { partialLineData } from "../_shared/sample-data"
import { useDynamicDasharray } from "../_shared/use-dynamic-dasharray"
import { type ChartConfig, ChartContainer } from "../../ui/chart"

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function PartialLineChart({ data, className }: BaseChartProps) {
  const chartData = data ?? partialLineData
  const { strokeDasharray, onRender } = useDynamicDasharray("forecast")

  return (
    <ChartContainer config={chartConfig} className={className}>
      <LineChart data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeDasharray={strokeDasharray}
          dot={false}
          isAnimationActive={false}
        />
        <Customized
          component={(props: Record<string, unknown>) => {
            const formattedData = props.formattedGraphicalItems as
              | Array<{ props: { points: Array<{ x: number; y: number }> } }>
              | undefined
            const points = formattedData?.[0]?.props?.points
            return onRender({
              points,
              data: chartData as Array<Record<string, unknown>>,
              forecastKey: "forecast",
            })
          }}
        />
      </LineChart>
    </ChartContainer>
  )
}
