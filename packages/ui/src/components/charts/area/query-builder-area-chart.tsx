import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { cn } from "../../../lib/utils"
import { useContainerSize } from "../../../hooks/use-container-size"
import { resolveSeriesColor } from "../../../lib/semantic-series-colors"
import type { BaseChartProps } from "../_shared/chart-types"
import {
	type LegendSeries,
	QueryBuilderLegend,
	computeSeriesStats,
	sortZeroSeriesLast,
	responsiveLegendHeight,
} from "../_shared/query-builder-legend"
import { thresholdReferenceLines } from "../_shared/threshold-lines"
import { findNearestSeriesKey } from "../_shared/nearest-series"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartTooltip,
	ChartTooltipContent,
} from "../../ui/chart"
import { formatValueByUnit, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"
import { isSparseSeries, hasOnlyIntegerValues } from "../_shared/sparse-series"

const fallbackData: Record<string, unknown>[] = [
	{ bucket: "2026-01-01T00:00:00Z", A: 12, B: 8 },
	{ bucket: "2026-01-01T01:00:00Z", A: 15, B: 9 },
	{ bucket: "2026-01-01T02:00:00Z", A: 11, B: 10 },
	{ bucket: "2026-01-01T03:00:00Z", A: 18, B: 12 },
	{ bucket: "2026-01-01T04:00:00Z", A: 16, B: 11 },
]

// Defense-in-depth render cap: never attempt to draw more than this many series,
// even if a query returns a high-cardinality group-by without a `seriesLimit`.
// The primary guardrail is the query-level top-N cap; this just keeps a runaway
// result set from locking up the browser.
const HARD_SERIES_LIMIT = 60

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function formatBucketTime(value: unknown): string {
	return typeof value === "string" ? value : ""
}

export function QueryBuilderAreaChart({
	data,
	className,
	legend,
	seriesStats: showStats,
	tooltip,
	stacked,
	curveType,
	unit,
	logScale,
	softMin,
	softMax,
	fitYAxisToData,
	syncId,
	thresholds,
	showPoints,
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

		const seriesDefinitions = rawSeriesKeys.slice(0, HARD_SERIES_LIMIT).map((rawKey, index) => ({
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

	const valueKeys = React.useMemo(() => seriesDefinitions.map((d) => d.chartKey), [seriesDefinitions])

	const {
		data: incompleteData,
		hasIncomplete,
		incompleteKeys,
	} = useIncompleteSegments(chartData, valueKeys)

	const bucketSeconds = React.useMemo(
		() =>
			inferBucketSeconds(
				chartData
					.map((row) => ({ bucket: formatBucketTime(row.bucket) }))
					.filter((row) => row.bucket.length > 0),
			),
		[chartData],
	)

	const processedData = React.useMemo(() => {
		if (unit !== "requests_per_sec" || !bucketSeconds) return incompleteData
		return incompleteData.map((row) => {
			const next: Record<string, unknown> = { bucket: row.bucket }
			for (const key of Object.keys(row)) {
				if (key === "bucket") continue
				const val = row[key]
				next[key] = typeof val === "number" ? val / bucketSeconds : val
			}
			return next
		})
	}, [incompleteData, unit, bucketSeconds])

	const axisContext = React.useMemo(
		() => ({
			rangeMs: inferRangeMs(chartData),
			bucketSeconds,
		}),
		[chartData, bucketSeconds],
	)

	const chartConfig = React.useMemo(() => {
		const base = seriesDefinitions.reduce((config, definition, index) => {
			config[definition.chartKey] = {
				label: definition.rawKey,
				color: resolveSeriesColor(definition.rawKey, index),
			}
			return config
		}, {} as ChartConfig)
		return extendConfigWithIncomplete(base, incompleteKeys)
	}, [seriesDefinitions, incompleteKeys])

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
		() => computeSeriesStats(processedData, valueKeys),
		[processedData, valueKeys],
	)

	// Sparse data (isolated non-zero buckets between zeros) renders as barely
	// visible spikes — auto-enable dots so single-bucket values stay readable.
	const sparse = React.useMemo(() => isSparseSeries(processedData, valueKeys), [processedData, valueKeys])
	const renderDots = showPoints || sparse

	// Integer-only data (counts) shouldn't get fractional ticks (0.5/1.5); a
	// unit or any fractional value keeps decimal ticks (rates, ratios).
	const integerOnlyData = React.useMemo(
		() => hasOnlyIntegerValues(processedData, valueKeys),
		[processedData, valueKeys],
	)

	const legendSeries = React.useMemo<LegendSeries[]>(
		() =>
			sortZeroSeriesLast(
				seriesDefinitions.map((definition) => ({
					key: definition.chartKey,
					label: definition.rawKey,
					color: chartConfig[definition.chartKey]?.color ?? "var(--chart-1)",
				})),
				seriesStats,
			),
		[seriesDefinitions, chartConfig, seriesStats],
	)

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { height: containerHeight } = useContainerSize(containerRef)

	const variant = showStats ? "stats" : "compact"
	const showLegendBlock = legend === "visible" || legend === "right"
	const legendPosition = legend === "right" ? "right" : "bottom"
	const legendHeight = responsiveLegendHeight(variant, seriesDefinitions.length, containerHeight)

	// Per-series active-point pixel Y, captured by each Area's active dot during
	// render. Recharts renders graphical items (and their active dots) before the
	// tooltip in the same commit, so the tooltip reads current positions. Only
	// visible series get an active dot on hover, so stale hidden keys are filtered
	// out below via `hiddenSeries`.
	const seriesYByKeyRef = React.useRef<Record<string, number>>({})
	const resolveHighlightKey = React.useCallback(
		(coordinate: { x?: number; y?: number } | undefined) => {
			if (seriesDefinitions.length <= 1) return undefined
			const visibleKeys = seriesDefinitions
				.map((d) => d.chartKey)
				.filter((key) => !hiddenSeries.has(key))
			return findNearestSeriesKey(seriesYByKeyRef.current, visibleKeys, coordinate?.y, 24)
		},
		[seriesDefinitions, hiddenSeries],
	)

	// "Fit Y-axis to data": lower bound follows the data minimum (with padding)
	// instead of being pinned at 0/auto. Ignored when softMin or logScale set.
	const fitDomainMin = React.useMemo(() => {
		if (!fitYAxisToData || softMin != null || logScale) return undefined
		let min = Number.POSITIVE_INFINITY
		let max = Number.NEGATIVE_INFINITY
		for (const row of processedData) {
			for (const key of valueKeys) {
				const value = row[key]
				if (typeof value !== "number" || !Number.isFinite(value)) continue
				if (value < min) min = value
				if (value > max) max = value
			}
		}
		if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined
		const padding = max > min ? (max - min) * 0.1 : Math.abs(min) * 0.1 || 1
		return min - padding
	}, [fitYAxisToData, softMin, logScale, processedData, valueKeys])

	const yDomainMin = softMin ?? fitDomainMin ?? (logScale ? 1 : "auto")
	const yDomainMax = softMax ?? "auto"

	return (
		<div ref={containerRef} className={cn("h-full w-full", className)}>
			<ChartContainer
				config={chartConfig}
				className="h-full w-full aspect-auto"
				hoistLegend={!showLegendBlock}
			>
				<AreaChart data={processedData} accessibilityLayer syncId={syncId} syncMethod="value">
					<defs>
						{seriesDefinitions.map((definition) => (
							<linearGradient
								key={definition.chartKey}
								id={`fill-${definition.chartKey}`}
								x1="0"
								y1="0"
								x2="0"
								y2="1"
							>
								<stop
									offset="5%"
									stopColor={`var(--color-${definition.chartKey})`}
									stopOpacity={0.8}
								/>
								<stop
									offset="95%"
									stopColor={`var(--color-${definition.chartKey})`}
									stopOpacity={0.1}
								/>
							</linearGradient>
						))}
						{hasIncomplete &&
							seriesDefinitions.map((definition) => (
								<linearGradient
									key={`${definition.chartKey}_incomplete`}
									id={`fill-${definition.chartKey}_incomplete`}
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop
										offset="5%"
										stopColor={`var(--color-${definition.chartKey})`}
										stopOpacity={0.15}
									/>
									<stop
										offset="95%"
										stopColor={`var(--color-${definition.chartKey})`}
										stopOpacity={0}
									/>
								</linearGradient>
							))}
					</defs>
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
						tickMargin={6}
						width={56}
						scale={logScale ? "log" : "auto"}
						domain={[yDomainMin, yDomainMax]}
						allowDecimals={!integerOnlyData}
						allowDataOverflow={
							logScale || softMin != null || softMax != null || fitDomainMin != null
						}
						tickFormatter={(value) => formatValueByUnit(asFiniteNumber(value), unit)}
					/>

					{tooltip !== "hidden" && (
						<ChartTooltip
							content={
								<ChartTooltipContent
									resolveHighlightKey={resolveHighlightKey}
									labelFormatter={(_, payload) => {
										if (!payload?.[0]?.payload?.bucket) return ""
										return formatBucketLabel(
											payload[0].payload.bucket,
											axisContext,
											"tooltip",
										)
									}}
									formatter={(value, name, item) => {
										const nameStr = String(name)
										const isIncomplete = nameStr.endsWith("_incomplete")
										const baseKey = isIncomplete
											? nameStr.replace(/_incomplete$/, "")
											: nameStr
										if (isIncomplete && item.payload?.[baseKey] != null) return null
										if (!isIncomplete && value == null) return null
										const label = labelByChartKey.get(baseKey) ?? baseKey
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

					{showLegendBlock && legendPosition === "bottom" && (
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
									variant={variant}
								/>
							}
						/>
					)}
					{showLegendBlock && legendPosition === "right" && (
						<ChartLegend
							layout="vertical"
							verticalAlign="middle"
							align="right"
							width={showStats ? 224 : 160}
							content={
								<QueryBuilderLegend
									series={legendSeries}
									stats={seriesStats}
									hidden={hiddenSeries}
									onToggle={toggleSeries}
									unit={unit}
									layout="right"
									variant={variant}
									maxHeight={containerHeight}
								/>
							}
						/>
					)}

					{thresholdReferenceLines(thresholds)}

					{seriesDefinitions.map((definition) => (
						<Area
							key={definition.chartKey}
							type={curveType ?? "linear"}
							dataKey={definition.chartKey}
							stroke={`var(--color-${definition.chartKey})`}
							fill={`url(#fill-${definition.chartKey})`}
							strokeWidth={2}
							dot={
								renderDots
									? {
											r: 2.5,
											strokeWidth: 0,
											fill: `var(--color-${definition.chartKey})`,
										}
									: false
							}
							hide={hiddenSeries.has(definition.chartKey)}
							isAnimationActive={false}
							activeDot={(props: { cx?: number; cy?: number }) => {
								if (typeof props.cy === "number") {
									seriesYByKeyRef.current[definition.chartKey] = props.cy
								}
								return (
									<circle
										className="recharts-dot"
										cx={props.cx}
										cy={props.cy}
										r={4}
										fill={`var(--color-${definition.chartKey})`}
										stroke="#fff"
										strokeWidth={2}
									/>
								)
							}}
							{...(stacked ? { stackId: "a" } : {})}
						/>
					))}
					{hasIncomplete &&
						seriesDefinitions.map((definition) => (
							<Area
								key={`${definition.chartKey}_incomplete`}
								type={curveType ?? "linear"}
								dataKey={`${definition.chartKey}_incomplete`}
								stroke={`var(--color-${definition.chartKey})`}
								fill={`url(#fill-${definition.chartKey}_incomplete)`}
								strokeWidth={2}
								strokeDasharray="4 4"
								dot={false}
								connectNulls
								legendType="none"
								hide={hiddenSeries.has(definition.chartKey)}
								isAnimationActive={false}
							/>
						))}
				</AreaChart>
			</ChartContainer>
		</div>
	)
}
