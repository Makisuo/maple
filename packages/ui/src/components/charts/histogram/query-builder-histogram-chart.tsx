import * as React from "react"
import { Bar, BarChart } from "recharts"

import type { BaseChartProps } from "../_shared/chart-types"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent, ChartGrid, ChartXAxis, ChartYAxis } from "../../ui/chart"
import { formatValueByUnit, formatNumber } from "../../../lib/format"
import { cn } from "../../../lib/utils"

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
	// No sample-data fallback: substituting fixtures for real rows made every
	// misconfigured histogram (a source with no numeric column, an empty result)
	// render a plausible-looking distribution instead of an empty state.
	const source = Array.isArray(data) ? data : []
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

	if (chartData.length === 0) {
		return (
			<div className={cn("relative h-full w-full grid place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	return (
		<ChartContainer config={chartConfig} className={className}>
			<BarChart data={chartData} accessibilityLayer barCategoryGap={1}>
				<ChartGrid />
				<ChartXAxis
					dataKey="name"
					interval="preserveStartEnd"
					minTickGap={32}
					// Axis ticks show only the bucket's lower bound ("150" instead
					// of "150-200") — halves label width so ticks stop overlapping;
					// the full range stays in the tooltip.
					tickFormatter={(value) => String(value).split("-")[0] || String(value)}
				/>
				<ChartYAxis
					width={48}
					scale={useLogY ? "log" : "auto"}
					domain={useLogY ? [1, "auto"] : ["auto", "auto"]}
					allowDecimals={false}
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
