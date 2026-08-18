import { barY, defineChart, group } from "@tanstack/charts"
import * as React from "react"

import { formatBucketLabel, formatValueByUnit } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import { findFirstPartialIndex, trimEmptyTrailingBuckets } from "../../plot/partial-buckets"
import { PlotFrame } from "../../plot/plot-frame"
import { PlotTooltipBody, cursorTooltip, type PlotTooltipSeries } from "../../plot/plot-tooltip"
import { usePlotColors, type PlotColorToken } from "../../plot/theme"
import { thresholdRules } from "../../plot/threshold-rules"
import {
	asFiniteNumber,
	timeseriesLegend,
	timeseriesXAxis,
	timeseriesYAxis,
	useTimeseriesModel,
	type TimeseriesRow,
	type TimeseriesSeries,
} from "../../plot/timeseries"
import { MAX_BAR_SERIES, OTHER_LABEL, bucketTimeseries } from "../_shared/bucket-series"
import type { QueryBuilderBarChartProps } from "../_shared/chart-types"

/** Matches the Recharts `maxBarSize={48}`. */
const MAX_BAR_THICKNESS = 48

/**
 * Recharts rounded the TOP two corners only, and only on the topmost segment of
 * a stack (`radius={stacked && index < last ? [0,0,0,0] : [2,2,0,0]}`).
 * `barY`'s `radius` is one scalar applied to all four corners of every rect it
 * emits, so per-corner and per-segment rounding are both unavailable. At 2px the
 * bottom corners sit on the axis line and read the same; a stack cannot fake it,
 * because rounding each segment carves visible notches out of the column — so
 * stacked columns stay square, which is what Recharts drew for every segment but
 * the last.
 */
const BAR_RADIUS = 2

/** The in-flight tail's fill, and both fills once another column has focus. */
const PARTIAL_FILL_OPACITY = 0.45
const DIMMED_FILL_OPACITY = 0.3
const DIMMED_PARTIAL_FILL_OPACITY = 0.15

/**
 * "Other" is a bucket, not an identity, so it takes the neutral colour rather
 * than an identity hue — the same rule the Recharts chart applied by keeping
 * `OTHER_LABEL` out of `resolveSeriesColors`. It arrives here as a resolved
 * literal because `OTHER_COLOR` is a `var()` and canvas cannot read one.
 */
const BAR_TOKENS = {
	other: ["--muted-foreground", "#a1a1aa"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * One bar: a bucket, a series, and the value where the two meet.
 *
 * Bars are LONG-FORM where line and area are wide, and that is forced rather
 * than chosen. `barY` resolves stacking and side-by-side grouping *within a
 * single mark*, off its `z` channel — `stackValues` runs over one mark's own
 * data (`dist/bar.js`), and `resolveGroupScale` throws without a `z`. The
 * one-mark-per-series idiom the line chart uses would therefore paint every
 * series on top of every other with no stack and no offset.
 *
 * `row` is carried along so the tooltip can still print the whole bucket from
 * whichever cell the pointer resolved to.
 */
interface BarCell {
	row: TimeseriesRow
	/** The series' chart key (s1, s2 …) — its stack and group identity. */
	key: string
	color: string
	value: number
	/** True when this bucket is still in flight. */
	partial: boolean
}

/**
 * Collapses the long tail of small series into one "Other" column.
 *
 * Bars, unlike lines, get illegible past a dozen stacked or grouped series, so
 * this cap is bar-specific and runs BEFORE `useTimeseriesModel` — the model
 * discovers series from the rows it is handed, so bucketing the rows first is
 * what makes "Other" a series like any other downstream.
 *
 * Returns the SAME array when nothing is collapsed, so the model's memos keep
 * their identity.
 */
function bucketBarSeries(data: Record<string, unknown>[] | undefined): Record<string, unknown>[] | undefined {
	if (!Array.isArray(data) || data.length === 0) return data

	const seriesKeys: string[] = []
	const seen = new Set<string>()
	for (const row of data) {
		for (const key of Object.keys(row)) {
			if (key === "bucket" || key === "partial" || seen.has(key)) continue
			seen.add(key)
			seriesKeys.push(key)
		}
	}
	if (seriesKeys.length <= MAX_BAR_SERIES) return data

	const { rows } = bucketTimeseries(data, seriesKeys, MAX_BAR_SERIES)
	// `bucketTimeseries` copies the bucket field and the series keys and nothing
	// else, so the in-flight flag has to be re-attached. Row order is preserved,
	// so the index is the join. (The Recharts chart lost the flag here too — it
	// also treated `partial` as a SERIES, which is why an in-flight dashboard bar
	// chart grew a spurious one-unit "partial" column.)
	return rows.map((row, index) => (data[index]?.partial === true ? { ...row, partial: true } : row))
}

export function QueryBuilderBarChart({
	data,
	className,
	legend,
	seriesStats: showStats,
	tooltip,
	stacked,
	unit,
	logScale,
	softMin,
	softMax,
	// Recharts' hover-sync bus. Accepted and ignored: TanStack has no equivalent,
	// and the replacement is the plot cursor provider, which is a later phase.
	// Dropping the prop would silently change every synced grid's call site, so
	// it stays declared and inert until there is something to wire it to.
	syncId: _syncId,
	thresholds,
}: QueryBuilderBarChartProps) {
	const bucketed = React.useMemo(() => bucketBarSeries(data), [data])
	const model = useTimeseriesModel({ data: bucketed, unit })
	const { rows, visibleKeys, axisContext, focusStore, containerRef } = model

	const { other: otherColor } = usePlotColors(BAR_TOKENS)

	/**
	 * The model's series, with "Other" recoloured.
	 *
	 * `resolveSeriesColors` hashes any unrecognised name into the identity
	 * palette, and an "Other" wearing a service's hue reads as a service.
	 */
	const recolor = React.useCallback(
		(entry: TimeseriesSeries): TimeseriesSeries =>
			entry.label === OTHER_LABEL ? { ...entry, color: otherColor } : entry,
		[otherColor],
	)
	const series = React.useMemo(() => model.series.map(recolor), [model.series, recolor])
	const visible = React.useMemo(() => model.visible.map(recolor), [model.visible, recolor])

	const { cells, plotRows } = React.useMemo(() => {
		const first = findFirstPartialIndex(rows)
		// Trailing in-flight buckets that reported nothing are dropped, exactly as
		// on the line chart: a bucket we have no reading for is not a reading of
		// zero. On a bar chart it costs more than an invisible zero-height bar —
		// the empty slot still widens the x extent, so every bar in the chart gets
		// narrower to make room for a column that paints nothing.
		const trimmed = first === -1 ? rows : trimEmptyTrailingBuckets(rows, visibleKeys, first)

		const built: BarCell[] = []
		trimmed.forEach((row, index) => {
			const partial = first !== -1 && index >= first
			for (const entry of visible) {
				built.push({
					row,
					key: entry.key,
					color: entry.color,
					value: asFiniteNumber(row[entry.key]),
					partial,
				})
			}
		})
		return { cells: built, plotRows: trimmed }
	}, [rows, visible, visibleKeys])

	/**
	 * Which legend row the card emphasises: the hovered cell's own series.
	 *
	 * No distance measuring, because there is nothing left to resolve. A cell IS a
	 * series at a bucket, and `axisFocus` (`dist/focus.js`) picks the column by
	 * horizontal distance and then hands over the cell within it nearest the
	 * pointer on y. The other charts measure only because their datum is a whole
	 * bucket row, so the series still has to be recovered from it.
	 */
	const labelByKey = React.useMemo(
		() => new Map(visible.map((entry) => [entry.key, entry.label])),
		[visible],
	)
	const highlight = React.useCallback((cell: BarCell) => labelByKey.get(cell.key), [labelByKey])

	const tooltipSeries = React.useMemo<PlotTooltipSeries<BarCell>[]>(
		() =>
			visible.map((entry) => ({
				label: entry.label,
				color: entry.color,
				value: (cell: BarCell) => {
					const value = cell.row[entry.key]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatValueByUnit(value, unit),
			})),
		[visible, unit],
	)

	const definition = React.useMemo(() => {
		/**
		 * One lane of bars — the closed buckets, or the in-flight tail.
		 *
		 * The two lanes share ONE cell array and differ only in which cells they
		 * give a value to; the other lane's cells come back `null` and `barY` skips
		 * them. Slicing the array per lane (what `splitAtFirstPartial` does for the
		 * line) would be wrong here: bar width is inferred from the *minimum gap
		 * between the x positions a mark can see*, so a one-bucket tail would see a
		 * single position, fall through to `min(48, width / (count + 1) * 0.8)` and
		 * paint at a completely different width from the bars beside it. Masking
		 * keeps both lanes' x channels identical, so both infer the same bandwidth.
		 *
		 * There is also no bridge row, unlike the line split: a shared row would be
		 * painted twice, once per lane, at two different opacities.
		 */
		const lane = (partialLane: boolean) =>
			barY(cells, {
				id: partialLane ? "bars-partial" : "bars",
				/**
				 * A CONTINUOUS time scale, and bars CENTRED on the bucket timestamp.
				 *
				 * A `scaleBand` over bucket strings is the obvious way to give a bar a
				 * natural width, and it is the thing the line chart's port deliberately
				 * moved away from: a band domain of bucket labels puts ticks on
				 * arbitrary buckets ("08:25 PM") instead of clock boundaries, and it
				 * would put this chart on a different x scale from the line and area
				 * charts it shares a dashboard row with.
				 *
				 * `barY` does not need a band scale. With a continuous scale it derives
				 * the bandwidth itself — `inferBandwidth` takes the minimum gap between
				 * distinct plotted x positions and keeps 80% of it (`dist/bar.js`),
				 * which is the equivalent of Recharts' `barCategoryGap="15%"` and is why
				 * no `inset` is passed here: the gap is already in the bandwidth, and
				 * insetting on top of it would subtract the gap twice.
				 *
				 * Centred, not spanning `[bucketStart, bucketStart + interval)`, for two
				 * reasons. It matches the baseline — Recharts' categorical axis centred
				 * each bar on its category slot — and it keeps a bar under the line
				 * chart's point for the same bucket, which is the thing that breaks
				 * visibly when a dashboard stacks the two. Spanning the interval would
				 * mean `rect` with explicit `x1`/`x2`, and `rect` has neither a stack
				 * nor a group layout, so it would cost stacking outright.
				 */
				x: (cell: BarCell) => cell.row.date,
				y: (cell: BarCell) => (cell.partial === partialLane ? cell.value : null),
				z: (cell: BarCell) => cell.key,
				fill: (cell: BarCell) => cell.color,
				fillOpacity: partialLane ? PARTIAL_FILL_OPACITY : undefined,
				maxThickness: MAX_BAR_THICKNESS,
				radius: stacked ? 0 : BAR_RADIUS,
				// Omitting the layout is what selects stacking: `barY` stacks by `z`
				// whenever there is no group layout and no explicit y1/y2.
				layout: stacked ? undefined : group(),
				/**
				 * The focus affordance: the hovered COLUMN keeps its fill and every
				 * other column dims.
				 *
				 * Recharts painted a muted rectangle across the hovered category band,
				 * and `crosshair({ x: { band: true } })` is the direct translation — but
				 * it sizes the band from `scale.bandwidth`, which a time scale does not
				 * have (`dist/crosshair.js` falls back to 0), so it would paint a
				 * zero-width rect. A crosshair rule plus per-series dots — the line
				 * chart's affordance — is wrong for bars twice over: the rule is
				 * invisible against a filled bar, and a dot at the raw value sits in the
				 * middle of a stacked column rather than at its segment.
				 *
				 * Dimming needs a NEGATIVE match, so `when` is a predicate rather than
				 * `{ focus: "unmatched" }` — that selector negates the focus *group*,
				 * which dedupes to one point per series and would leave the second lane
				 * of the same column undimmed.
				 */
				states: [
					{
						when: (context: { matches: (match: "x") => boolean }) => !context.matches("x"),
						style: {
							fillOpacity: partialLane ? DIMMED_PARTIAL_FILL_OPACITY : DIMMED_FILL_OPACITY,
						},
					},
				],
			})

		return defineChart({
			marks: [...thresholdRules(thresholds ?? []), lane(false), lane(true)],
			x: timeseriesXAxis(axisContext),
			// `.y` only: a bar has no band to fill from an axis floor — `barY` draws
			// each rect from the scale's own baseline — so the resolved domain the
			// area chart needs is not wanted here.
			y: timeseriesYAxis({
				rows: plotRows,
				visibleKeys,
				unit,
				logScale,
				softMin,
				softMax,
				thresholds,
				stacked,
				// `fitYAxisToData` is deliberately NOT forwarded, which is also what
				// the Recharts chart did (it never destructured the prop). A bar
				// encodes its value as the area between the baseline and its top, so
				// lifting the baseline off zero makes the ratio between two bars a
				// lie — the setting exists for line and area, where only the shape of
				// the curve carries meaning.
			}).y,
			// Resolves on horizontal distance alone (`dist/focus.js`), so the whole
			// column is live wherever the pointer sits inside it — which is what
			// Recharts' category cursor did.
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : cursorTooltip(focusStore.anchor),
		})
	}, [
		cells,
		plotRows,
		visibleKeys,
		axisContext,
		focusStore,
		stacked,
		unit,
		logScale,
		softMin,
		softMax,
		thresholds,
		tooltip,
	])

	return (
		<div ref={containerRef} className={cn("h-full w-full", className)}>
			<PlotFrame
				className="h-full w-full"
				ariaLabel="Time series"
				definition={definition}
				// `series`, not the model's: `model.series` still carries the hashed
				// identity colour for "Other".
				legend={timeseriesLegend(model, { legend, seriesStats: showStats, unit, series })}
				renderTooltipBody={({ points }) => (
					// The long-form body `PlotTooltipBody` documents: one datum is one
					// CELL, so the bucket's other series are read back off `cell.row`
					// rather than off `points`, which `focus: "group-x"` returns one of.
					<PlotTooltipBody
						points={points}
						series={tooltipSeries}
						focusStore={focusStore}
						highlight={highlight}
						heading={(cell: BarCell) =>
							formatBucketLabel(cell.row.bucket, axisContext, "tooltip")
						}
					/>
				)}
			/>
		</div>
	)
}
