import { useId } from "react"
import { Area, AreaChart } from "recharts"

import type { SimpleChartProps } from "../_shared/chart-types"
import { areaTimeSeriesData } from "../_shared/sample-data"
import { VerticalGradient } from "../_shared/svg-patterns"
import { type ChartConfig, ChartContainer, ChartGrid, ChartXAxis } from "../../ui/chart"

const chartConfig = {
	desktop: { label: "Desktop", color: "var(--chart-1)" },
	mobile: { label: "Mobile", color: "var(--chart-2)" },
} satisfies ChartConfig

export function GradientAreaChart({ data, className, syncId }: SimpleChartProps) {
	const id = useId()
	const desktopGradientId = `desktopGradient-${id.replace(/:/g, "")}`
	const mobileGradientId = `mobileGradient-${id.replace(/:/g, "")}`

	return (
		<ChartContainer config={chartConfig} className={className}>
			<AreaChart
				data={data ?? areaTimeSeriesData}
				accessibilityLayer
				syncId={syncId}
				syncMethod="value"
			>
				<defs>
					<VerticalGradient id={desktopGradientId} color="var(--color-desktop)" />
					<VerticalGradient id={mobileGradientId} color="var(--color-mobile)" />
				</defs>
				<ChartGrid />
				<ChartXAxis dataKey="month" />
				<Area
					type="linear"
					dataKey="desktop"
					stackId="a"
					stroke="var(--color-desktop)"
					strokeDasharray="3 3"
					fill={`url(#${desktopGradientId})`}
					isAnimationActive={false}
				/>
				<Area
					type="linear"
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
