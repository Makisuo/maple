import * as React from "react"

import type { ChartConfig } from "../../ui/chart"
import {
	type LegendSeries,
	type SeriesStats,
	computeSeriesStats,
	sortZeroSeriesLast,
} from "./query-builder-legend"
import { hasOnlyIntegerValues, isSparseSeries } from "./sparse-series"

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
	 * User preference for point dots. Sparse data force-enables them regardless.
	 * Chart types without dots (bar) omit this and ignore `renderDots`.
	 */
	showPoints?: boolean
}

export interface TimeseriesSeriesPresentation {
	/** Per-series min/max/avg/last stats for the legend. */
	seriesStats: Record<string, SeriesStats>
	/** Legend entries in render order — all-zero series sorted last. */
	legendSeries: LegendSeries[]
	/**
	 * Whether line/area series should render point dots. True when the user
	 * asked for points, or when the data is sparse (isolated non-zero buckets
	 * between zeros render as barely visible spikes — dots keep single-bucket
	 * values readable).
	 */
	renderDots: boolean
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

	const sparse = React.useMemo(() => isSparseSeries(data, valueKeys), [data, valueKeys])
	const renderDots = showPoints || sparse

	const integerOnlyData = React.useMemo(() => hasOnlyIntegerValues(data, valueKeys), [data, valueKeys])

	return { seriesStats, legendSeries, renderDots, integerOnlyData }
}
