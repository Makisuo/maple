import * as React from "react"
import { Cell, Pie, PieChart } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatValueByUnit } from "../../../lib/format"
import { pieSampleData } from "../_shared/sample-data"
import { getSemanticSeriesColor } from "../../../lib/semantic-series-colors"

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

export function QueryBuilderPieChart({ data, className, legend, tooltip, unit, pie }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> =
		Array.isArray(data) && data.length > 0
			? data
			: (pieSampleData as ReadonlyArray<Record<string, unknown>>)
	const valueField = React.useMemo(() => pickValueField(source), [source])

	const chartData = React.useMemo(
		() =>
			source.map((row) => ({
				name: String(row.name ?? "—"),
				value: asFiniteNumber(row[valueField]),
			})),
		[source, valueField],
	)

	const total = chartData.reduce((acc, row) => acc + row.value, 0)

	const chartConfig = React.useMemo(() => {
		return chartData.reduce((config, row, index) => {
			config[row.name] = {
				label: row.name,
				color: getSemanticSeriesColor(row.name) ?? `var(--chart-${(index % 5) + 1})`,
			}
			return config
		}, {} as ChartConfig)
	}, [chartData])

	const innerRadius = pie?.donut ? (pie.innerRadius ?? 50) : 0

	return (
		<ChartContainer config={chartConfig} className={className}>
			<PieChart>
				{tooltip !== "hidden" && (
					<ChartTooltip
						content={
							<ChartTooltipContent
								formatter={(value, name, item) => {
									const numericValue = asFiniteNumber(value)
									const pct = total > 0 ? (numericValue / total) * 100 : 0
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="text-muted-foreground">{String(name)}</span>
											<span className="font-mono font-medium">
												{formatValueByUnit(numericValue, unit)}
											</span>
											{pie?.showPercent !== false && (
												<span className="text-muted-foreground">
													({pct.toFixed(1)}%)
												</span>
											)}
										</span>
									)
								}}
							/>
						}
					/>
				)}
				<Pie
					data={chartData}
					dataKey="value"
					nameKey="name"
					innerRadius={innerRadius}
					outerRadius="80%"
					isAnimationActive={false}
					label={
						pie?.showLabels
							? (entry) => {
									const v = asFiniteNumber(entry.value)
									if (pie?.showPercent !== false && total > 0) {
										return `${((v / total) * 100).toFixed(1)}%`
									}
									return formatValueByUnit(v, unit)
								}
							: false
					}
					labelLine={pie?.showLabels ? true : false}
				>
					{chartData.map((entry, index) => (
						<Cell
							key={entry.name}
							fill={getSemanticSeriesColor(entry.name) ?? `var(--chart-${(index % 5) + 1})`}
						/>
					))}
				</Pie>
				{legend === "visible" && <ChartLegend content={<ChartLegendContent />} />}
				{legend === "right" && (
					<ChartLegend
						layout="vertical"
						verticalAlign="middle"
						align="right"
						content={<ChartLegendContent />}
					/>
				)}
			</PieChart>
		</ChartContainer>
	)
}
