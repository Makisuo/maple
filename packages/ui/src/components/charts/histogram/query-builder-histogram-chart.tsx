import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../../ui/chart"
import { formatValueByUnit, formatNumber } from "../../../lib/format"
import { histogramSampleData } from "../_shared/sample-data"

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function bucketize(
	rows: Record<string, unknown>[],
	bucketCount: number,
	bucketWidth?: number,
	unit?: string,
): Array<{ name: string; value: number }> {
	if (rows.length === 0) return []

	const valueField =
		Object.keys(rows[0]).find((k) => k !== "name" && k !== "bucket" && typeof rows[0][k] === "number") ??
		"value"

	const numerics = rows.map((row) => asFiniteNumber(row[valueField])).filter((n) => Number.isFinite(n))
	if (numerics.length === 0) return []

	const min = Math.min(...numerics)
	const max = Math.max(...numerics)
	const span = max - min
	const width = bucketWidth ?? (span > 0 ? span / bucketCount : 1)
	const safeWidth = width > 0 ? width : 1

	const buckets = new Map<number, number>()
	for (const value of numerics) {
		const idx = Math.floor((value - min) / safeWidth)
		const clamped = Math.min(idx, bucketCount - 1)
		buckets.set(clamped, (buckets.get(clamped) ?? 0) + 1)
	}

	return Array.from({ length: bucketCount }, (_, i) => {
		const lower = min + i * safeWidth
		const upper = lower + safeWidth
		return {
			name:
				unit === "duration_ms" ||
				unit === "duration_us" ||
				unit === "duration_s" ||
				unit === "duration_ns"
					? `${formatValueByUnit(lower, unit)}-${formatValueByUnit(upper, unit)}`
					: `${formatNumber(lower)}-${formatNumber(upper)}`,
			value: buckets.get(i) ?? 0,
		}
	})
}

function isPrebucketed(rows: Record<string, unknown>[]): boolean {
	if (rows.length === 0) return false
	return (
		rows.every((row) => typeof row.name === "string" && typeof row.value === "number") &&
		rows.length <= 200
	)
}

export function QueryBuilderHistogramChart({
	data,
	className,
	tooltip,
	unit,
	histogram,
	logScale,
}: BaseChartProps) {
	const source = Array.isArray(data) && data.length > 0 ? data : histogramSampleData
	const bucketCount = histogram?.bucketCount ?? 30
	const bucketWidth = histogram?.bucketWidth
	const useLogY = histogram?.logScaleY ?? logScale ?? false

	const chartData = React.useMemo(() => {
		if (isPrebucketed(source)) {
			return source.map((row) => ({
				name: String(row.name ?? "—"),
				value: asFiniteNumber(row.value),
			}))
		}
		return bucketize(source, bucketCount, bucketWidth, unit)
	}, [source, bucketCount, bucketWidth, unit])

	const chartConfig = React.useMemo(
		() =>
			({
				value: {
					label: "Count",
					color: "var(--chart-1)",
				},
			}) satisfies ChartConfig,
		[],
	)

	return (
		<ChartContainer config={chartConfig} className={className}>
			<BarChart data={chartData} accessibilityLayer barCategoryGap={1}>
				<CartesianGrid vertical={false} />
				<XAxis
					dataKey="name"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					interval="preserveStartEnd"
					minTickGap={20}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					scale={useLogY ? "log" : "auto"}
					domain={useLogY ? [1, "auto"] : ["auto", "auto"]}
					allowDataOverflow={useLogY}
					tickFormatter={(value) => formatNumber(asFiniteNumber(value))}
				/>
				{tooltip !== "hidden" && (
					<ChartTooltip
						content={
							<ChartTooltipContent
								formatter={(value, _name, item) => (
									<span className="flex items-center gap-2">
										<span
											className="shrink-0 size-2.5 rounded-[2px]"
											style={{ backgroundColor: item.color }}
										/>
										<span className="text-muted-foreground">Count</span>
										<span className="font-mono font-medium">
											{formatNumber(asFiniteNumber(value))}
										</span>
									</span>
								)}
							/>
						}
					/>
				)}
				<Bar
					dataKey="value"
					fill="var(--color-value)"
					radius={[2, 2, 0, 0]}
					isAnimationActive={false}
				/>
			</BarChart>
		</ChartContainer>
	)
}
