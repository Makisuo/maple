import type { ChartPoint, ChartValue } from "@tanstack/charts"
import * as React from "react"

import { formatBucketLabel, inferBucketSeconds, inferRangeMs, parseBucketMs } from "../../lib/format"
import { cn } from "../../lib/utils"
import { useChartTooltipSuppressed } from "./floating-tooltip"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	type PlotTooltipSeries,
	type TooltipFocusStore,
} from "./plot-tooltip"
import { usePlotChromeColors, type PlotChromeColors } from "./theme"
import type { TimeseriesAxisContext, TimeseriesRow } from "./timeseries"

/**
 * The shared spine of a FIXED-METRIC time-series chart — latency percentiles,
 * throughput, apdex, error rate.
 *
 * **Why this is not `useTimeseriesModel`.** That hook is built around the one
 * thing these charts do not have: series discovered from the data. It reads
 * every column that is not `bucket`/`partial` as a series, remaps each to a
 * synthetic `s1..sN` key, hashes an identity colour out of the raw column name,
 * and hands the whole set to a hiding legend. Every one of those steps is wrong
 * here:
 *
 * - A service-detail row carries `hasSampling`, `errorRate`, `tracedThroughput`
 *   and three latency percentiles at once. Discovery would turn the booleans and
 *   the operands of derived series into plotted series of their own.
 * - `p50`/`p95`/`p99` have DESIGNATED tokens (`--chart-p50`, …) that carry
 *   meaning across the whole product. A hashed hue would break that.
 * - The chart's own keys are the ones the tooltip, the legend and the marks
 *   already share, so the `sN` remap — which exists to make arbitrary group-by
 *   text safe as an object key — buys nothing.
 *
 * What DOES generalise is everything downstream of the series list: parsing
 * buckets into `Date`s, the axis context, the chrome colours, the tooltip focus
 * store, and the suppression flag an overlay uses to quiet the tooltip. That is
 * what this is, and the axis builders in `timeseries.tsx` are shared verbatim on
 * top of it.
 */

/** One fixed series, as the marks, tooltip and legend all see it. */
export interface FixedMetricSeries {
	/** The column this series reads off a row. */
	key: string
	label: string
	/** A RESOLVED colour literal — canvas cannot read `var()`. */
	color: string
	/** Renders the legend swatch and the tooltip bullet as a dashed outline. */
	dashed?: boolean
}

/**
 * Rows with their bucket parsed, and every other column preserved.
 *
 * The preservation is the point: a fixed-metric chart derives series from
 * SIBLING columns (throughput × errorRate) and reads flags off the row
 * (`hasSampling`), so dropping the columns it did not name would break the
 * derivation. `normaliseTimeseriesRows` keeps only the discovered series, which
 * is right for a query-builder chart and wrong here.
 *
 * A row with no parseable bucket is dropped: it has no position on a time axis,
 * and the Recharts categorical axis' habit of inventing one for it is exactly
 * what the port is leaving behind.
 */
export function normaliseFixedRows(
	data: ReadonlyArray<Record<string, unknown>> | undefined,
): TimeseriesRow[] {
	if (!Array.isArray(data)) return []
	const rows: TimeseriesRow[] = []
	for (const row of data) {
		const bucket = typeof row.bucket === "string" ? row.bucket : ""
		const epochMs = parseBucketMs(bucket)
		if (epochMs == null) continue
		rows.push({ ...row, bucket, date: new Date(epochMs) })
	}
	return rows
}

export interface FixedMetricModel {
	rows: TimeseriesRow[]
	bucketSeconds: number | undefined
	axisContext: TimeseriesAxisContext
	chromeColors: PlotChromeColors
	focusStore: TooltipFocusStore
	/**
	 * True while an overlay (the commit deploy markers) has a card open.
	 *
	 * Only the chart owns its tooltip definition, so the overlay cannot remove
	 * it — it raises this flag and the chart omits `tooltip:` via `maybeTooltip`.
	 * Requires a `ChartTooltipSuppressionProvider` above the chart; `MetricsGrid`
	 * mounts one.
	 */
	suppressed: boolean
}

export function useFixedMetricModel(
	data: ReadonlyArray<Record<string, unknown>> | undefined,
): FixedMetricModel {
	const rows = React.useMemo(() => normaliseFixedRows(data), [data])
	const bucketSeconds = React.useMemo(() => inferBucketSeconds(rows), [rows])
	const axisContext = React.useMemo(
		() => ({ rangeMs: inferRangeMs(rows), bucketSeconds }),
		[rows, bucketSeconds],
	)
	const chromeColors = usePlotChromeColors()
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])
	const suppressed = useChartTooltipSuppressed()

	return React.useMemo(
		() => ({ rows, bucketSeconds, axisContext, chromeColors, focusStore, suppressed }),
		[rows, bucketSeconds, axisContext, chromeColors, focusStore, suppressed],
	)
}

/**
 * The tooltip card's contents for a fixed-metric chart.
 *
 * Rows come off `points[0].datum`, which holds every series — see
 * `PlotTooltipBody` for why that is the workaround rather than iterating
 * `points`.
 */
export function fixedMetricTooltipBody(
	model: FixedMetricModel,
	points: readonly ChartPoint<TimeseriesRow, ChartValue, number>[],
	series: readonly PlotTooltipSeries<TimeseriesRow>[],
) {
	return (
		<PlotTooltipBody
			points={points}
			series={series}
			focusStore={model.focusStore}
			heading={(row: TimeseriesRow) => formatBucketLabel(row.bucket, model.axisContext, "tooltip")}
		/>
	)
}

/**
 * The colour key beneath a fixed-metric plot.
 *
 * Non-interactive, unlike `QueryBuilderLegend`: these series are the chart's
 * subject rather than a query result, so there is nothing to hide — dropping
 * p95 from a latency chart would rescale the axis under the reader for no gain,
 * and the Recharts legend it replaces was a plain strip too. The styling is
 * `QueryBuilderLegend`'s compact variant, so a service grid and a dashboard tile
 * read as the same product.
 */
export function FixedMetricLegend({ series }: { series: readonly FixedMetricSeries[] }) {
	if (series.length === 0) return null
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-xs">
			{series.map((entry) => (
				<span key={entry.key} className="flex items-center gap-1.5 px-1 py-0.5">
					<span
						className={cn(
							"size-2 shrink-0 rounded-[2px]",
							entry.dashed && "border border-dashed",
						)}
						style={entry.dashed ? { borderColor: entry.color } : { backgroundColor: entry.color }}
					/>
					<span className="truncate">{entry.label}</span>
				</span>
			))}
		</div>
	)
}
