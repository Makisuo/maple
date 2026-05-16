import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { getSemanticSeriesColor } from "../../../lib/semantic-series-colors"
import type { BaseChartProps } from "../_shared/chart-types"
import {
	type LegendSeries,
	QueryBuilderLegend,
	computeSeriesStats,
} from "../_shared/query-builder-legend"
import { thresholdReferenceLines } from "../_shared/threshold-lines"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatValueByUnit, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

const fallbackData: Record<string, unknown>[] = [
	{ bucket: "2026-01-01T00:00:00Z", A: 12, B: 8 },
	{ bucket: "2026-01-01T01:00:00Z", A: 15, B: 9 },
	{ bucket: "2026-01-01T02:00:00Z", A: 11, B: 10 },
	{ bucket: "2026-01-01T03:00:00Z", A: 18, B: 12 },
	{ bucket: "2026-01-01T04:00:00Z", A: 16, B: 11 },
]

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function formatBucketTime(value: unknown): string {
	return typeof value === "string" ? value : ""
}

export function QueryBuilderBarChart({
	data,
	className,
	legend,
	tooltip,
	stacked,
	unit,
	logScale,
	softMin,
	softMax,
	syncId,
	thresholds,
}: BaseChartProps) {
	const { chartData, seriesDefinitions } = React.useMemo(() => {
		const source = Array.isArray(data) && data.length > 0 ? data : fallbackData
		const rawSeriesKeys: string[] = []
		const seenSeriesKeys = new Set<string>()

		for (const row of source) {
			for (const key of Object.keys(row)) {
				if (key === "bucket" || seenSeriesKeys.has(key)) continue
				seenSeriesKeys.add(key)
				rawSeriesKeys.push(key)
			}
		}

		const seriesDefinitions = rawSeriesKeys.map((rawKey, index) => ({
			rawKey,
			chartKey: `s${index + 1}`,
		}))

		const chartData = source.map((row) => {
			const next: Record<string, unknown> = { bucket: row.bucket }
			for (const definition of seriesDefinitions) {
				next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
			}
			return next
		})

		return { chartData, seriesDefinitions }
	}, [data])

	const bucketSeconds = React.useMemo(
		() =>
			inferBucketSeconds(
				chartData
					.map((row) => ({ bucket: formatBucketTime(row.bucket) }))
					.filter((row) => row.bucket.length > 0),
			),
		[chartData],
	)

	const displayData = React.useMemo(() => {
		if (unit !== "requests_per_sec" || !bucketSeconds) return chartData
		return chartData.map((row) => {
			const next: Record<string, unknown> = { bucket: row.bucket }
			for (const key of Object.keys(row)) {
				if (key === "bucket") continue
				const val = row[key]
				next[key] = typeof val === "number" ? val / bucketSeconds : val
			}
			return next
		})
	}, [chartData, unit, bucketSeconds])

	const axisContext = React.useMemo(
		() => ({
			rangeMs: inferRangeMs(chartData),
			bucketSeconds,
		}),
		[chartData, bucketSeconds],
	)

	const chartConfig = React.useMemo(() => {
		return seriesDefinitions.reduce((config, definition, index) => {
			config[definition.chartKey] = {
				label: definition.rawKey,
				color: getSemanticSeriesColor(definition.rawKey) ?? `var(--chart-${(index % 5) + 1})`,
			}
			return config
		}, {} as ChartConfig)
	}, [seriesDefinitions])

	const labelByChartKey = React.useMemo(() => {
		return new Map(seriesDefinitions.map((definition) => [definition.chartKey, definition.rawKey]))
	}, [seriesDefinitions])

	const [hiddenSeries, setHiddenSeries] = React.useState<ReadonlySet<string>>(() => new Set())

	const toggleSeries = React.useCallback((key: string) => {
		setHiddenSeries((prev) => {
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	}, [])

	const seriesStats = React.useMemo(
		() => computeSeriesStats(displayData, seriesDefinitions.map((d) => d.chartKey)),
		[displayData, seriesDefinitions],
	)

	const legendSeries = React.useMemo<LegendSeries[]>(
		() =>
			seriesDefinitions.map((definition) => ({
				key: definition.chartKey,
				label: definition.rawKey,
				color: chartConfig[definition.chartKey]?.color ?? "var(--chart-1)",
			})),
		[seriesDefinitions, chartConfig],
	)

	const legendHeight = 30 + Math.min(seriesDefinitions.length, 4) * 22

	return (
		<ChartContainer config={chartConfig} className={className}>
			<BarChart data={displayData} accessibilityLayer syncId={syncId} syncMethod="value">
				<CartesianGrid vertical={false} />
				<XAxis
					dataKey="bucket"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					tickFormatter={(value) => formatBucketLabel(value, axisContext, "tick")}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					width={80}
					scale={logScale ? "log" : "auto"}
					domain={[softMin ?? (logScale ? 1 : "auto"), softMax ?? "auto"]}
					allowDataOverflow={logScale || softMin != null || softMax != null}
					tickFormatter={(value) => formatValueByUnit(asFiniteNumber(value), unit)}
				/>

				{tooltip !== "hidden" && (
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => {
									if (!payload?.[0]?.payload?.bucket) return ""
									return formatBucketLabel(
										payload[0].payload.bucket,
										axisContext,
										"tooltip",
									)
								}}
								formatter={(value, name, item) => {
									const label = labelByChartKey.get(String(name)) ?? String(name)
									return (
										<span className="flex items-center gap-2">
											<span
												className="shrink-0 size-2.5 rounded-[2px]"
												style={{ backgroundColor: item.color }}
											/>
											<span className="text-muted-foreground">{label}</span>
											<span className="font-mono font-medium">
												{formatValueByUnit(asFiniteNumber(value), unit)}
											</span>
										</span>
									)
								}}
							/>
						}
					/>
				)}

				{legend === "visible" && (
					<ChartLegend
						verticalAlign="bottom"
						height={legendHeight}
						content={
							<QueryBuilderLegend
								series={legendSeries}
								stats={seriesStats}
								hidden={hiddenSeries}
								onToggle={toggleSeries}
								unit={unit}
								layout="bottom"
							/>
						}
					/>
				)}
				{legend === "right" && (
					<ChartLegend
						layout="vertical"
						verticalAlign="middle"
						align="right"
						width={224}
						content={
							<QueryBuilderLegend
								series={legendSeries}
								stats={seriesStats}
								hidden={hiddenSeries}
								onToggle={toggleSeries}
								unit={unit}
								layout="right"
							/>
						}
					/>
				)}

				{thresholdReferenceLines(thresholds)}

				{seriesDefinitions.map((definition, index) => (
					<Bar
						key={definition.chartKey}
						dataKey={definition.chartKey}
						fill={`var(--color-${definition.chartKey})`}
						radius={stacked && index < seriesDefinitions.length - 1 ? [0, 0, 0, 0] : [4, 4, 0, 0]}
						hide={hiddenSeries.has(definition.chartKey)}
						isAnimationActive={false}
						{...(stacked ? { stackId: "a" } : {})}
					/>
				))}
			</BarChart>
		</ChartContainer>
	)
}
