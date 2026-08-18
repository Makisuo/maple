"use client"

import { useId } from "react"
import { Bar, BarChart } from "recharts"
import { type ChartConfig, ChartContainer, ChartGrid, ChartXAxis } from "../../ui/chart"
import type { SimpleChartProps } from "../_shared/chart-types"
import { defaultBarData } from "../_shared/sample-data"
import { DottedPattern } from "../_shared/svg-patterns"

const chartConfig = {
	value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig

export function DefaultBarChart({ data = defaultBarData, className, syncId }: SimpleChartProps) {
	const id = useId()
	const patternId = `default-bar-dots-${id}`

	return (
		<ChartContainer config={chartConfig} className={className}>
			<BarChart data={data} syncId={syncId} syncMethod="value">
				<defs>
					<DottedPattern id={patternId} />
				</defs>
				<ChartGrid />
				<ChartXAxis dataKey="name" />
				<Bar
					dataKey="value"
					fill={`url(#${patternId})`}
					radius={[4, 4, 0, 0]}
					isAnimationActive={false}
				/>
			</BarChart>
		</ChartContainer>
	)
}
