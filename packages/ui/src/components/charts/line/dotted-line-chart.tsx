import { Line, LineChart } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { lineTimeSeriesData } from "../_shared/sample-data"
import { type ChartConfig, ChartContainer, ChartGrid, ChartXAxis } from "../../ui/chart"

const chartConfig = {
	value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function DottedLineChart({ data, className, syncId }: BaseChartProps) {
	return (
		<ChartContainer config={chartConfig} className={className}>
			<LineChart data={data ?? lineTimeSeriesData} syncId={syncId} syncMethod="value">
				<ChartGrid />
				<ChartXAxis dataKey="date" />
				<Line
					type="linear"
					dataKey="value"
					stroke="var(--color-value)"
					strokeDasharray="4 4"
					dot={false}
					isAnimationActive={false}
				/>
			</LineChart>
		</ChartContainer>
	)
}
