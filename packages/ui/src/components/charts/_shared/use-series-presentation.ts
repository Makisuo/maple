import * as React from "react"

import type { ChartConfig } from "../../ui/chart"
import {
	type LegendSeries,
	type SeriesStats,
	computeSeriesStats,
	sortZeroSeriesLast,
} from "./query-builder-legend"
import { hasOnlyIntegerValues, isolatedPointIndexes, type PointsMode, pointsFit } from "./sparse-series"

export interface TimeseriesSeriesDefinition {
	/** Original series key from the query result (used as the display label). */
	rawKey: string
	/** Stable chart key (`s1`, `s2`, …) the data rows are keyed by. */
	chartKey: string
}

export interface TimeseriesSeriesPresentationOptions {
	/** Display-ready rows (after unit conversion / incomplete-segment split). */
	data: ReadonlyArray<Record<string, unknown>>
	/** Chart keys to read values from — must be memoized alongside `seriesDefinitions`. */
	valueKeys: ReadonlyArray<string>
	seriesDefinitions: ReadonlyArray<TimeseriesSeriesDefinition>
	chartConfig: ChartConfig
	/**
	 * User preference for point dots: `true` every point, `false` none,
	 * `undefined` Auto — dots on isolated points always, on every point only when
	 * they fit the width. Chart types without dots (bar) omit this and ignore
	 * the resulting `points`.
	 */
	showPoints?: boolean
	/**
	 * Rendered plot width for the Auto density rule. Omit (or pass 0 while the
	 * container is unmeasured) and Auto only dots isolated points.
	 */
	plotWidthPx?: number
}

export interface TimeseriesSeriesPresentation {
	/** Per-series min/max/avg/last stats for the legend. */
	seriesStats: Record<string, SeriesStats>
	/** Legend entries in render order — all-zero series sorted last. */
	legendSeries: LegendSeries[]
	/**
	 * Which points carry a dot: every one, only the isolated ones a line cannot
	 * show, or none. Line/area feed this to `shouldDot`.
	 */
	pointsMode: PointsMode
	/**
	 * `(chartKey, rowIndex) => draw a dot?` — the per-point rule behind
	 * `pointsMode`, ready to hand to a Recharts `dot` render function.
	 */
	shouldDot: (chartKey: string, index: number) => boolean
	/**
	 * True when the data is integer-only (counts) so the y-axis can suppress
	 * fractional ticks (0.5/1.5); a unit or any fractional value keeps decimal
	 * ticks (rates, ratios).
	 */
	integerOnlyData: boolean
}

/**
 * Derived presentation state shared by the timeseries query-builder charts
 * (line/area/bar): legend series ordering, per-series stats, sparse-data dot
 * rendering, and integer-only y-tick detection.
 */
export function useTimeseriesSeriesPresentation({
	data,
	valueKeys,
	seriesDefinitions,
	chartConfig,
	showPoints,
	plotWidthPx = 0,
}: TimeseriesSeriesPresentationOptions): TimeseriesSeriesPresentation {
	const seriesStats = React.useMemo(() => computeSeriesStats(data, valueKeys), [data, valueKeys])

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

	// An explicit preference wins in both directions; Auto only decides when the
	// caller has no opinion. (An earlier `||` meant a caller that had deliberately
	// turned dots off still got them back on sparse data.)
	const pointsMode: PointsMode =
		showPoints === true
			? "all"
			: showPoints === false
				? "none"
				: pointsFit(plotWidthPx, data.length)
					? "all"
					: "isolated"

	const isolated = React.useMemo(
		() => (pointsMode === "isolated" ? isolatedPointIndexes(data, valueKeys) : undefined),
		[pointsMode, data, valueKeys],
	)
	const shouldDot = React.useCallback(
		(chartKey: string, index: number): boolean =>
			pointsMode === "all" || (isolated?.get(chartKey)?.has(index) ?? false),
		[pointsMode, isolated],
	)

	const integerOnlyData = React.useMemo(() => hasOnlyIntegerValues(data, valueKeys), [data, valueKeys])

	return { seriesStats, legendSeries, pointsMode, shouldDot, integerOnlyData }
}
