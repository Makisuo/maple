import * as React from "react"
import { Line, LineChart } from "recharts"

import { cn } from "../../../lib/utils"
import { useContainerSize } from "../../../hooks/use-container-size"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import type { BaseChartProps } from "../_shared/chart-types"
import { QueryBuilderLegend, responsiveLegendHeight } from "../_shared/query-builder-legend"
import { useTimeseriesSeriesPresentation } from "../_shared/use-series-presentation"
import { thresholdReferenceLines } from "../_shared/threshold-lines"
import { findNearestSeriesKey } from "../_shared/nearest-series"
import { useIncompleteSegments, extendConfigWithIncomplete } from "../_shared/use-incomplete-segments"
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartTooltip,
	ChartTooltipContent,
	ChartGrid,
	ChartXAxis,
	ChartYAxis,
} from "../../ui/chart"
import { formatValueByUnit, inferBucketSeconds, inferRangeMs, formatBucketLabel } from "../../../lib/format"

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart (a share page handing over an envelope where an
// array belongs, an empty result) draw plausible-looking curves labelled "A" and
// "B" instead of an empty plot. Gallery thumbnails pass their sample rows in
// explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

// Defense-in-depth render cap: never attempt to draw more than this many series,
// even if a query returns a high-cardinality group-by without a `seriesLimit`.
// The primary guardrail is the query-level top-N cap; this just keeps a runaway
// result set from locking up the browser.
const HARD_SERIES_LIMIT = 60

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(parsed)) {
		return 0
	}

	return parsed
}

function formatBucketTime(value: unknown): string {
	return typeof value === "string" ? value : ""
}

export function QueryBuilderLineChart({
	data,
	className,
	legend,
	seriesStats: showStats,
	tooltip,
	curveType,
	unit,
	logScale,
	softMin,
	softMax,
	fitYAxisToData,
	showPoints,
	syncId,
	thresholds,
}: BaseChartProps) {
	const { chartData, seriesDefinitions } = React.useMemo(() => {
		const source = Array.isArray(data) ? data : EMPTY_ROWS
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
			const next: Record<string, unknown> = {
				bucket: row.bucket,
			} satisfies Record<string, unknown>

			for (const definition of seriesDefinitions) {
				next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
			}

			return next
		})

		return {
			chartData,
			seriesDefinitions,
		}
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
			const next: Record<string, unknown> = { bucket: row.bucket } satisfies Record<string, unknown>
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
		const colors = resolveSeriesColors(seriesDefinitions.map((d) => d.rawKey))
		const base = seriesDefinitions.reduce((config, definition) => {
			config[definition.chartKey] = {
				label: definition.rawKey,
				color: colors.get(definition.rawKey),
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

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width: containerWidth, height: containerHeight } = useContainerSize(containerRef)

	const { seriesStats, legendSeries, pointsMode, shouldDot, integerOnlyData } =
		useTimeseriesSeriesPresentation({
			data: processedData,
			valueKeys,
			seriesDefinitions,
			chartConfig,
			showPoints,
			plotWidthPx: containerWidth,
		})

	const variant = showStats ? "stats" : "compact"
	const showLegendBlock = legend === "visible" || legend === "right"
	const legendPosition = legend === "right" ? "right" : "bottom"
	const legendHeight = responsiveLegendHeight(variant, seriesDefinitions.length, containerHeight)

	// Per-series active-point pixel Y, captured by each Line's active dot during
	// render (Recharts draws graphical items before the tooltip in the same
	// commit). Hidden series get no active dot, so they're filtered out below.
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
				<LineChart data={processedData} accessibilityLayer syncId={syncId} syncMethod="value">
					<ChartGrid />
					<ChartXAxis
						dataKey="bucket"
						tickFormatter={(value) => formatBucketLabel(value, axisContext, "tick")}
					/>
					<ChartYAxis
						allowDecimals={!integerOnlyData}
						scale={logScale ? "log" : "auto"}
						domain={[yDomainMin, yDomainMax]}
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
										const bucket = payload[0].payload.bucket
										return formatBucketLabel(bucket, axisContext, "tooltip")
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
						<Line
							key={definition.chartKey}
							type={curveType ?? "linear"}
							dataKey={definition.chartKey}
							stroke={`var(--color-${definition.chartKey})`}
							strokeWidth={2}
							dot={
								// `false` skips the per-point pass entirely; the render function
								// draws only the points `shouldDot` picks (all, or the isolated ones).
								pointsMode === "none"
									? false
									: (props) =>
											shouldDot(definition.chartKey, props.index) ? (
												<circle
													className="recharts-dot"
													cx={props.cx}
													cy={props.cy}
													r={2.5}
													fill={`var(--color-${definition.chartKey})`}
												/>
											) : null
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
						/>
					))}
					{hasIncomplete &&
						seriesDefinitions.map((definition) => (
							<Line
								key={`${definition.chartKey}_incomplete`}
								type={curveType ?? "linear"}
								dataKey={`${definition.chartKey}_incomplete`}
								stroke={`var(--color-${definition.chartKey})`}
								strokeWidth={2}
								strokeDasharray="4 4"
								dot={false}
								connectNulls
								legendType="none"
								hide={hiddenSeries.has(definition.chartKey)}
								isAnimationActive={false}
							/>
						))}
				</LineChart>
			</ChartContainer>
		</div>
	)
}
