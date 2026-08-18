import { areaY, defineChart, lineY } from "@tanstack/charts"
import { memo, useMemo } from "react"

import { bucketIntervalLabel, formatThroughput } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import {
	FixedMetricLegend,
	fixedMetricTooltipBody,
	useFixedMetricModel,
	type FixedMetricSeries,
} from "../../plot/fixed-metrics"
import { dashedGridY } from "../../plot/plot-grid"
import { splitAtFirstPartial } from "../../plot/partial-buckets"
import { focusCrosshair, focusDot } from "../../plot/plot-focus"
import { PlotFrame, usePlotLegendSlot } from "../../plot/plot-frame"
import { roundCapDasharray, useChartId, verticalGradient } from "../../plot/plot-paint"
import { maybeTooltip, type PlotTooltipSeries } from "../../plot/plot-tooltip"
import { usePlotColors, type PlotColorToken } from "../../plot/theme"
import {
	hoistsLegend,
	asFiniteNumber,
	timeseriesXAxis,
	timeseriesYAxis,
	type TimeseriesRow,
} from "../../plot/timeseries"
import type { ThroughputAreaChartProps } from "../_shared/chart-types"
import { throughputTimeSeriesData } from "../_shared/sample-data"

const THROUGHPUT_KEY = "throughput"
const ERROR_KEY = "errorThroughput"
const TRACED_KEY = "tracedThroughput"

/** The in-flight split is decided by the primary series alone. */
const PARTIAL_KEYS = [THROUGHPUT_KEY]

const STROKE_WIDTH = 2
const ERROR_STROKE_WIDTH = 1.5
const TRACED_STROKE_WIDTH = 1
/** See `apdex-area-chart` — `areaY` defaults to 0.2, Recharts' `<Area>` to 0.6. */
const FILL_OPACITY = 0.6
/** The traced line is a reference, not a series to read off — it stays quiet. */
const TRACED_OPACITY = 0.5
/** ...and so does the in-flight half of the error line. */
const PARTIAL_ERROR_OPACITY = 0.5

/** Module scope — see `usePlotColors` on why a fresh literal defeats the memo. */
const THROUGHPUT_TOKENS = {
	throughput: ["--chart-throughput", "#8b7cf6"],
	error: ["--chart-error", "#e5484d"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * One row with the rate conversion applied and the derived series attached.
 *
 * `errorThroughput` is `throughput × errorRate`, and `errorRate` is a FRACTION
 * (errors / requests), not a percentage — an earlier revision divided by 100 and
 * drew the error line two orders of magnitude too low.
 */
function deriveRows(rows: readonly TimeseriesRow[], divisor: number): TimeseriesRow[] {
	return rows.map((row) => {
		const errorRate = typeof row.errorRate === "number" ? row.errorRate : 0
		const rawThroughput = row[THROUGHPUT_KEY]
		const rawTraced = row[TRACED_KEY]
		const throughput = typeof rawThroughput === "number" ? rawThroughput / divisor : null
		const traced = typeof rawTraced === "number" ? rawTraced / divisor : null
		return {
			...row,
			[THROUGHPUT_KEY]: throughput,
			[TRACED_KEY]: traced,
			[ERROR_KEY]: throughput == null ? null : throughput * errorRate,
		}
	})
}

// Memoized: these charts sit in synced grids whose parent rerenders on every
// atom/query settle; with stable props the whole chart subtree is skipped.
export const ThroughputAreaChart = memo(function ThroughputAreaChart({
	data,
	className,
	legend,
	tooltip,
	rateMode,
	overlay,
	yAxisWidth,
}: ThroughputAreaChartProps) {
	const model = useFixedMetricModel(data ?? throughputTimeSeriesData)
	const { rows: sourceRows, bucketSeconds, axisContext, chromeColors, focusStore, suppressed } = model

	const colors = usePlotColors(THROUGHPUT_TOKENS)
	const gradientPrefix = useChartId("throughput")

	const perSecond = rateMode === "per_second"
	const rateLabel = perSecond ? "/s" : bucketIntervalLabel(bucketSeconds)

	const rows = useMemo(
		() => deriveRows(sourceRows, perSecond && bucketSeconds ? bucketSeconds : 1),
		[sourceRows, perSecond, bucketSeconds],
	)

	/**
	 * Whether the numbers are extrapolated from a sample, decided over the WHOLE
	 * window rather than per bucket. That matches the axis label, which already
	 * carries one `~` for the chart, and keeps the tooltip from flipping between
	 * "Throughput" and "Estimated" as the cursor crosses a sampling boundary.
	 */
	const hasSampling = useMemo(() => rows.some((row) => row.hasSampling === true), [rows])
	const hasTraced = useMemo(() => rows.some((row) => typeof row[TRACED_KEY] === "number"), [rows])
	const hasErrors = useMemo(
		() =>
			rows.some((row) => {
				const value = row[ERROR_KEY]
				return typeof value === "number" && value > 0
			}),
		[rows],
	)

	/** The legend's series. The traced line is a reference line, not a key. */
	const legendSeries = useMemo<FixedMetricSeries[]>(() => {
		const throughputLabel = `${hasSampling ? "~" : ""}Throughput${rateLabel ? ` (${rateLabel})` : ""}`
		const entries: FixedMetricSeries[] = [
			{ key: THROUGHPUT_KEY, label: throughputLabel, color: colors.throughput },
		]
		if (hasErrors) {
			entries.push({
				key: ERROR_KEY,
				label: rateLabel ? `Errors (${rateLabel})` : "Errors",
				color: colors.error,
				dashed: true,
			})
		}
		return entries
	}, [colors, hasSampling, hasErrors, rateLabel])

	const tooltipSeries = useMemo<PlotTooltipSeries<TimeseriesRow>[]>(() => {
		const withSuffix = (value: number) => `${value.toLocaleString()}${rateLabel}`
		const read = (key: string) => (row: TimeseriesRow) => {
			const value = row[key]
			return typeof value === "number" ? value : null
		}
		const entries: PlotTooltipSeries<TimeseriesRow>[] = [
			{
				label: hasSampling ? "Estimated" : "Throughput",
				color: colors.throughput,
				value: read(THROUGHPUT_KEY),
				format: (value: number) => `${hasSampling ? "~" : ""}${withSuffix(value)}`,
			},
		]
		if (hasErrors) {
			entries.push({
				label: "Errors",
				color: colors.error,
				dashed: true,
				// A zero-error bucket prints no row at all: on a healthy service that
				// is most of them, and "Errors 0" in every card is noise.
				value: (row: TimeseriesRow) => {
					const value = row[ERROR_KEY]
					return typeof value === "number" && value > 0 ? value : null
				},
				format: withSuffix,
			})
		}
		if (hasTraced) {
			entries.push({
				label: "Traced",
				color: colors.throughput,
				dashed: true,
				value: read(TRACED_KEY),
				format: withSuffix,
			})
		}
		return entries
	}, [colors, hasSampling, hasErrors, hasTraced, rateLabel])

	// The card header's series chips, top-right of the tile. A no-op outside a
	// `WidgetShell` — the service pages draw their own always-on legend.
	//
	// Gated, not unconditional, and on the SAME condition the strip below the plot
	// uses: a chart drawing both would print its series twice, once bottom-left
	// and once in the header. `hasErrors` is part of it because the error series
	// forces the strip on whether or not the caller asked for a legend.
	usePlotLegendSlot(hoistsLegend(legend) && !hasErrors ? legendSeries : null)

	const definition = useMemo(() => {
		// The in-flight tail is a SECOND set of marks over an overlapping slice —
		// `areaY` has no `strokeDasharray` at all and `lineY`'s is a scalar, so no
		// single mark can change style mid-series.
		const { solid, dashed } = splitAtFirstPartial(rows, PARTIAL_KEYS)
		const hasDashed = dashed.length > 0
		const gradientId = `${gradientPrefix}-fill`
		const fadedGradientId = `${gradientPrefix}-fill-partial`

		// `lineY` hard-codes a round cap, which eats the gap — see `roundCapDasharray`.
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
		const errorDash = roundCapDasharray(3, 3, ERROR_STROKE_WIDTH)
		const tracedDash = roundCapDasharray(4, 4, TRACED_STROKE_WIDTH)

		const value = (key: string) => (row: TimeseriesRow) => asFiniteNumber(row[key])
		const at = (row: TimeseriesRow) => row.date

		// Fill only, top edge as its own `lineY` — see `apdex-area-chart` for why.
		// The floor is 0: throughput is a count against no traffic at all.
		const band = (rowSlice: readonly TimeseriesRow[], fill: string, partial: boolean) =>
			areaY(rowSlice, {
				id: partial ? "throughput-area-partial" : "throughput-area",
				x: at,
				y: value(THROUGHPUT_KEY),
				y1: () => 0,
				fill: `url(#${fill})`,
				fillOpacity: FILL_OPACITY,
				stroke: "none",
			})

		const throughputEdge = (rowSlice: readonly TimeseriesRow[], partial: boolean) =>
			lineY(rowSlice, {
				id: partial ? "throughput-partial" : "throughput",
				x: at,
				y: value(THROUGHPUT_KEY),
				stroke: colors.throughput,
				strokeWidth: STROKE_WIDTH,
				strokeDasharray: partial ? partialDash : undefined,
			})

		const errorLine = (rowSlice: readonly TimeseriesRow[], partial: boolean) =>
			lineY(rowSlice, {
				id: partial ? "error-throughput-partial" : "error-throughput",
				x: at,
				y: value(ERROR_KEY),
				stroke: colors.error,
				strokeWidth: ERROR_STROKE_WIDTH,
				strokeDasharray: errorDash,
				strokeOpacity: partial ? PARTIAL_ERROR_OPACITY : undefined,
			})

		/**
		 * The pre-sampling truth, drawn across the WHOLE range rather than split at
		 * the partial boundary. It is already a faint dashed reference, so a second
		 * dash style over its tail would say nothing the line does not.
		 */
		const tracedLine = lineY(rows, {
			id: "traced-throughput",
			x: at,
			y: value(TRACED_KEY),
			stroke: colors.throughput,
			strokeWidth: TRACED_STROKE_WIDTH,
			strokeDasharray: tracedDash,
			strokeOpacity: TRACED_OPACITY,
		})

		return defineChart({
			// A left-margin LOCK, not an axis width: `resolveMarginLocks` pins the
			// side named here and leaves the rest to the automatic solver, which is
			// what keeps plot rects aligned across a grid. See `PlotOverlayProps`.
			margin: yAxisWidth == null ? undefined : { left: yAxisWidth },
			gradients: [
				verticalGradient(gradientId, colors.throughput),
				...(hasDashed ? [verticalGradient(fadedGradientId, colors.throughput, 0.15, 0)] : []),
			],
			marks: [
				dashedGridY(),
				band(solid, gradientId, false),
				...(hasDashed ? [band(dashed, fadedGradientId, true)] : []),
				throughputEdge(solid, false),
				...(hasDashed ? [throughputEdge(dashed, true)] : []),
				...(hasErrors ? [errorLine(solid, false)] : []),
				...(hasErrors && hasDashed ? [errorLine(dashed, true)] : []),
				...(hasTraced ? [tracedLine] : []),
				focusDot(rows, at, value(THROUGHPUT_KEY), colors.throughput, chromeColors),
				...(hasErrors ? [focusDot(rows, at, value(ERROR_KEY), colors.error, chromeColors)] : []),
				focusCrosshair(chromeColors),
			],
			x: timeseriesXAxis(axisContext),
			y: timeseriesYAxis({
				rows,
				// Every plotted series widens the axis, including the derived ones —
				// a traced line above the sampled estimate must not run off the top.
				visibleKeys: [THROUGHPUT_KEY, ERROR_KEY, TRACED_KEY],
				format: (tick: number) => formatThroughput(tick, rateLabel),
			}).y,
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : maybeTooltip(suppressed, focusStore.anchor),
		})
	}, [
		rows,
		colors,
		gradientPrefix,
		chromeColors,
		axisContext,
		focusStore,
		tooltip,
		suppressed,
		hasErrors,
		hasTraced,
		rateLabel,
		yAxisWidth,
	])

	return (
		<PlotFrame
			className={cn("h-full w-full", className)}
			ariaLabel="Throughput"
			definition={definition}
			// The error series has no axis of its own, so its dashed line is
			// unreadable without a key — the legend appears for it whether or not the
			// caller asked for one.
			legend={
				legend === "visible" || hasErrors ? <FixedMetricLegend series={legendSeries} /> : undefined
			}
			overlay={overlay}
			renderTooltipBody={({ points }) => fixedMetricTooltipBody(model, points, tooltipSeries)}
		/>
	)
})
