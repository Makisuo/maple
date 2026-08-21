import type { ChartPoint, ChartValue } from "@tanstack/charts"
import * as React from "react"

import { formatBucketLabel, inferBucketSeconds, inferRangeMs, parseBucketMs } from "../../lib/format"
import { cn } from "../../lib/utils"
import { useChartTooltipSuppressed } from "./floating-tooltip"
import { findFirstPartialIndex, trimEmptyTrailingBuckets } from "./partial-buckets"
import {
	PlotTooltipBody,
	createTooltipFocusStore,
	type PlotTooltipSeries,
	type TooltipFocusStore,
} from "./plot-tooltip"
import { usePlotChromeColors, type PlotChromeColors } from "./theme"
import { rowsDomainMs, type TimeseriesAxisContext, type TimeseriesRow } from "./timeseries"

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

/**
 * "This bucket reported nothing", decided per ROW rather than per series.
 *
 * `totalCount` is the span count the bucket was built from, and the server's
 * gap-fill writes it as `0` on the buckets it synthesizes — so it says what no
 * plotted column can. Reading the columns instead is what let these four panels
 * disagree: they share one row array but each trimmed on its own keys, and
 * `mergeExactThroughput` overlays exact SpanMetrics throughput that materializes
 * ahead of the percentile path. A trailing bucket with `throughput > 0` and
 * `p95 === 0` was kept by throughput and dropped by latency, so the two cards
 * ended their series at different times on the same grid.
 *
 * It also stops a real `0` being mistaken for missing: an hour with no errors is
 * a reading of `errorRate: 0`, not an absent one.
 *
 * `undefined` when the rows do not carry the column — a dashboard tile fed from
 * the query builder — so the caller keeps the value-key default.
 */
function reportedNothingPredicate(
	rows: readonly TimeseriesRow[],
): ((row: TimeseriesRow) => boolean) | undefined {
	if (!rows.some((row) => typeof row.totalCount === "number")) return undefined
	return (row: TimeseriesRow) => {
		const count = row.totalCount
		return typeof count === "number" ? count === 0 : true
	}
}

/** See the `plotRows` memo — the row-level predicate is what decides emptiness. */
const EMPTY_VALUE_KEYS: ReadonlyArray<string> = []

export interface FixedMetricModel {
	/**
	 * Every bucket the query returned, in-flight tail included.
	 *
	 * The tooltip and the per-column probes (`hasSampling`, `hasTraced`) want the
	 * full set. Anything that becomes a MARK wants `plotRows` — see below.
	 */
	rows: TimeseriesRow[]
	/**
	 * The buckets this chart actually draws.
	 *
	 * A trailing in-flight bucket that reported nothing is dropped — see
	 * `trimEmptyTrailingBuckets`. Everything downstream has to agree on that, and
	 * that is the part the TanStack port missed here: the marks were built from
	 * the trimmed slices while the focus dots were still built over `rows`, and a
	 * mark's channels feed scale inference whether or not it paints. So the x axis
	 * kept running out to a bucket nothing drew, and the series read as cut off
	 * short of its own axis.
	 */
	plotRows: readonly TimeseriesRow[]
	/**
	 * Pass to `splitAtFirstPartial` so the solid/dashed split agrees with the trim
	 * that produced `plotRows` — otherwise it re-trims on the caller's value keys
	 * and the panels drift apart again.
	 */
	trimOptions: { isEmpty?: (row: TimeseriesRow) => boolean }
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

	const trimOptions = React.useMemo(() => ({ isEmpty: reportedNothingPredicate(rows) }), [rows])

	const plotRows = React.useMemo(() => {
		const first = findFirstPartialIndex(rows)
		if (first === -1) return rows
		// `EMPTY_VALUE_KEYS`: the row-level predicate decides this, and when the
		// rows carry no `totalCount` an empty key list makes `every` vacuously true
		// — which would trim the whole tail. Fall back to nothing rather than to
		// the wrong answer; a query-builder row array reaches its own charts, not
		// this hook.
		if (!trimOptions.isEmpty) return rows
		return trimEmptyTrailingBuckets(rows, EMPTY_VALUE_KEYS, first, trimOptions)
	}, [rows, trimOptions])

	// The bucket size and the label granularity describe the range actually
	// DRAWN. Inferring them from the untrimmed rows would format ticks for a
	// window whose tail nothing paints.
	const bucketSeconds = React.useMemo(() => inferBucketSeconds(plotRows), [plotRows])
	const axisContext = React.useMemo(
		() => ({
			rangeMs: inferRangeMs(plotRows),
			bucketSeconds,
			// The DRAWN span, so an edge tick label clamps inward instead of
			// overhanging the plot and pushing the margin solver — see `timeseriesXAxis`.
			domainMs: rowsDomainMs(plotRows),
		}),
		[plotRows, bucketSeconds],
	)
	const chromeColors = usePlotChromeColors()
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])
	const suppressed = useChartTooltipSuppressed()

	return React.useMemo(
		() => ({
			rows,
			plotRows,
			trimOptions,
			bucketSeconds,
			axisContext,
			chromeColors,
			focusStore,
			suppressed,
		}),
		[rows, plotRows, trimOptions, bucketSeconds, axisContext, chromeColors, focusStore, suppressed],
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
