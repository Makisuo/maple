import { d3Curve, defineChart, dot, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { scaleTime } from "d3-scale"
import * as React from "react"

import { useContainerSize } from "../../../hooks/use-container-size"
import {
	formatBucketLabel,
	formatValueByUnit,
	inferBucketSeconds,
	inferRangeMs,
	parseBucketMs,
} from "../../../lib/format"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { cn } from "../../../lib/utils"
import { splitAtFirstPartial } from "../../plot/partial-buckets"
import { focusCrosshair, focusDot } from "../../plot/plot-focus"
import { PlotFrame } from "../../plot/plot-frame"
import { roundCapDasharray } from "../../plot/plot-paint"
import { integerTickValues, linearYDomain, logYScale } from "../../plot/plot-scales"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	type PlotTooltipSeries,
} from "../../plot/plot-tooltip"
import { usePlotChromeColors, useResolvedSeriesColors } from "../../plot/theme"
import { thresholdRules } from "../../plot/threshold-rules"
import { useSeriesVisibility } from "../../plot/series-visibility"
import { computeSeriesStats } from "../../plot/series-stats"
import type { BaseChartProps } from "../_shared/chart-types"
import { QueryBuilderLegend } from "../_shared/query-builder-legend"
import { hasOnlyIntegerValues, isolatedPointIndexes, pointsFit } from "../_shared/sparse-series"

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

/** Used when a series colour token resolves to nothing. */
const SERIES_FALLBACK_COLOR = "#6366f1"

const STROKE_WIDTH = 2

/** One normalised row: the bucket, its parsed date, and every series value. */
interface TimeseriesRow extends Record<string, unknown> {
	bucket: string
	/**
	 * Precomputed, because `scaleTime` takes Dates and building one per accessor
	 * call would allocate on every scale pass.
	 */
	date: Date
	partial?: boolean
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
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
	thresholds,
}: BaseChartProps) {
	const { rows, seriesDefinitions } = React.useMemo(() => {
		const source = Array.isArray(data) ? data : EMPTY_ROWS
		const rawSeriesKeys: string[] = []
		const seen = new Set<string>()

		for (const row of source) {
			for (const key of Object.keys(row)) {
				if (key === "bucket" || key === "partial" || seen.has(key)) continue
				seen.add(key)
				rawSeriesKeys.push(key)
			}
		}

		const definitions = rawSeriesKeys.slice(0, HARD_SERIES_LIMIT).map((rawKey, index) => ({
			rawKey,
			chartKey: `s${index + 1}`,
		}))

		const normalised = source.flatMap((row): TimeseriesRow[] => {
			const bucket = typeof row.bucket === "string" ? row.bucket : ""
			const epochMs = parseBucketMs(bucket)
			// A row with no parseable bucket has no position on a time axis. Dropping
			// it is the only honest option: Recharts placed it on a categorical slot,
			// which silently invented an x position for it.
			if (epochMs == null) return []
			const next: TimeseriesRow = { bucket, date: new Date(epochMs) }
			if (row.partial === true) next.partial = true
			for (const definition of definitions) {
				next[definition.chartKey] = asFiniteNumber(row[definition.rawKey])
			}
			return [next]
		})

		return { rows: normalised, seriesDefinitions: definitions }
	}, [data])

	const allKeys = React.useMemo(
		() => seriesDefinitions.map((definition) => definition.chartKey),
		[seriesDefinitions],
	)

	const bucketSeconds = React.useMemo(() => inferBucketSeconds(rows), [rows])

	/** Rates are stored per bucket and displayed per second. */
	const scaledRows = React.useMemo(() => {
		if (unit !== "requests_per_sec" || !bucketSeconds) return rows
		return rows.map((row) => {
			const next: TimeseriesRow = { bucket: row.bucket, date: row.date }
			if (row.partial) next.partial = true
			for (const key of allKeys) next[key] = asFiniteNumber(row[key]) / bucketSeconds
			return next
		})
	}, [rows, unit, bucketSeconds, allKeys])

	const colorTokens = React.useMemo(() => {
		const byRawKey = resolveSeriesColors(seriesDefinitions.map((d) => d.rawKey))
		return new Map(
			seriesDefinitions.map((d) => [d.chartKey, byRawKey.get(d.rawKey) ?? SERIES_FALLBACK_COLOR]),
		)
	}, [seriesDefinitions])

	// Tokens, resolved to literals. `resolveSeriesColors` hands back
	// `var(--chart-3)` and friends, which paint on SVG and resolve to NOTHING on
	// canvas — PlotFrame's dev assertion throws on one that slips through.
	const colors = useResolvedSeriesColors(colorTokens, SERIES_FALLBACK_COLOR)

	const chromeColors = usePlotChromeColors()

	/**
	 * Stats over ALL series, including hidden ones.
	 *
	 * Computed BEFORE the visibility filter, deliberately: a hidden series keeps
	 * its legend row and its numbers so it can be brought back. See
	 * `useSeriesVisibility` for the rest of that ordering.
	 */
	const stats = React.useMemo(() => computeSeriesStats(scaledRows, allKeys), [scaledRows, allKeys])

	const series = React.useMemo(
		() =>
			seriesDefinitions.map((definition) => ({
				key: definition.chartKey,
				label: definition.rawKey,
				color: colors.get(definition.chartKey) ?? SERIES_FALLBACK_COLOR,
			})),
		[seriesDefinitions, colors],
	)

	const { hidden, toggle, visible } = useSeriesVisibility(series)
	const visibleKeys = React.useMemo(() => visible.map((entry) => entry.key), [visible])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width: containerWidth, height: containerHeight } = useContainerSize(containerRef)

	const axisContext = React.useMemo(
		() => ({ rangeMs: inferRangeMs(scaledRows), bucketSeconds }),
		[scaledRows, bucketSeconds],
	)

	/** Which points carry a dot — every one, only the isolated ones, or none. */
	const dotIndexes = React.useMemo<ReadonlyMap<string, ReadonlySet<number>>>(() => {
		if (showPoints === false) return new Map()
		// Auto: dots on every point only when they fit the width, otherwise only on
		// the isolated points a line cannot show at all.
		if (showPoints === true || pointsFit(containerWidth, scaledRows.length)) {
			const every = new Set(scaledRows.map((_, index) => index))
			return new Map(visibleKeys.map((key) => [key, every]))
		}
		return isolatedPointIndexes(scaledRows, visibleKeys)
	}, [showPoints, scaledRows, containerWidth, visibleKeys])

	const focusStore = React.useMemo(() => createTooltipFocusStore<TimeseriesRow>(), [])

	const tooltipSeries = React.useMemo<PlotTooltipSeries<TimeseriesRow>[]>(
		() =>
			visible.map((entry) => ({
				label: entry.label,
				color: entry.color,
				value: (row: TimeseriesRow) => {
					const value = row[entry.key]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatValueByUnit(value, unit),
			})),
		[visible, unit],
	)

	const definition = React.useMemo(() => {
		// The dashed tail is a SECOND mark over an overlapping slice, not a dash
		// pattern on the first: `strokeDasharray` on `lineY` is a scalar, not a
		// per-datum channel, so one mark cannot change style mid-line.
		const { solid, dashed } = splitAtFirstPartial(scaledRows, visibleKeys)

		const domain = linearYDomain({
			rows: scaledRows,
			keys: visibleKeys,
			fitYAxisToData: fitYAxisToData && softMin == null && !logScale,
			softMin,
			softMax,
			thresholds,
		})
		const integerOnly = hasOnlyIntegerValues(scaledRows, visibleKeys) && unit == null

		// `curve` takes a ChartCurve, not a string. Linear is the default shape, so
		// only monotone needs one built.
		const curve = curveType === "monotone" ? d3Curve(curveMonotoneX) : undefined
		// `lineY` hard-codes a round cap, which eats the gap — see `roundCapDasharray`.
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
		const line = (rowSlice: readonly TimeseriesRow[], entry: (typeof visible)[number], dash: boolean) =>
			lineY(rowSlice, {
				id: dash ? `${entry.key}-partial` : entry.key,
				x: (row: TimeseriesRow) => row.date,
				y: (row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
				stroke: entry.color,
				strokeWidth: STROKE_WIDTH,
				curve,
				strokeDasharray: dash ? partialDash : undefined,
			})

		return defineChart({
			marks: [
				...thresholdRules(thresholds ?? []),
				...visible.map((entry) => line(solid, entry, false)),
				...(dashed.length > 0 ? visible.map((entry) => line(dashed, entry, true)) : []),
				...visible.flatMap((entry) => {
					const indexes = dotIndexes.get(entry.key)
					if (!indexes || indexes.size === 0) return []
					const points = scaledRows.filter((_, index) => indexes.has(index))
					return [
						dot(points, {
							x: (row: TimeseriesRow) => row.date,
							y: (row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
							r: 2.5,
							fill: entry.color,
						}),
					]
				}),
				...visible.map((entry) =>
					focusDot(
						scaledRows,
						(row: TimeseriesRow) => row.date,
						(row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
						entry.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: {
				// A d3 TIME scale over the precomputed `row.date`. A point scale over
				// bucket strings — which is what the categorical Recharts axis was —
				// puts ticks on arbitrary buckets ("08:25 PM") instead of clock
				// boundaries. `scaleTime`, not `scaleUtc`: the labels below render in
				// local time, and only local ticks land on locally round boundaries.
				//
				// The bare FACTORY, so the domain is inferred. That is safe even though
				// the solid and dashed marks each cover a slice: a continuous domain is
				// min/max over the union, and the slices overlap at the bridge row.
				scale: scaleTime,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						spacing: 72,
						format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
					},
				},
			},
			y: {
				// The domain lives on the SCALE — `ChartAxisOptions` has no `domain`
				// field, and an instance is what pins it (a bare factory infers, which
				// is how the zero anchor gets lost).
				scale: logScale ? logYScale(domain[1]) : scaleLinear().domain(domain),
				nice: !logScale,
				grid: true,
				axis: {
					line: false,
					// There is no `allowDecimals`; integer-only data supplies its tick
					// values outright so counts never render as "1.5". `undefined` leaves
					// the library to choose.
					ticks: {
						size: 0,
						padding: 6,
						values: integerOnly && !logScale ? integerTickValues(domain) : undefined,
						format: (value: number) => formatValueByUnit(value, unit),
					},
				},
			},
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : cursorTooltip(focusStore.anchor),
		})
	}, [
		scaledRows,
		visible,
		visibleKeys,
		dotIndexes,
		chromeColors,
		axisContext,
		focusStore,
		curveType,
		unit,
		logScale,
		softMin,
		softMax,
		fitYAxisToData,
		thresholds,
		tooltip,
	])

	const showLegendBlock = legend === "visible" || legend === "right"
	const legendNode = showLegendBlock ? (
		<QueryBuilderLegend
			series={series}
			stats={stats}
			hidden={hidden}
			onToggle={toggle}
			unit={unit}
			layout={legend === "right" ? "right" : "bottom"}
			variant={showStats ? "stats" : "compact"}
			maxHeight={legend === "right" ? containerHeight : undefined}
		/>
	) : undefined

	return (
		<div ref={containerRef} className={cn("h-full w-full", className)}>
			<PlotFrame
				className="h-full w-full"
				ariaLabel="Time series"
				definition={definition}
				legend={legendNode}
				renderTooltipBody={({ points }) => (
					<PlotTooltipBody
						points={points}
						series={tooltipSeries}
						focusStore={focusStore}
						heading={(row: TimeseriesRow) =>
							formatBucketLabel(row.bucket, axisContext, "tooltip")
						}
					/>
				)}
			/>
		</div>
	)
}
