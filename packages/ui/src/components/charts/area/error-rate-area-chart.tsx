import { areaY, defineChart, lineY } from "@tanstack/charts"
import { memo, useMemo } from "react"

import { formatErrorRate } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import {
	FixedMetricLegend,
	fixedMetricTooltipBody,
	useFixedMetricModel,
	type FixedMetricSeries,
} from "../../plot/fixed-metrics"
import { splitAtFirstPartial } from "../../plot/partial-buckets"
import { focusCrosshair, focusDot } from "../../plot/plot-focus"
import { PlotFrame, usePlotLegendSlot } from "../../plot/plot-frame"
import { roundCapDasharray, useChartId, verticalGradient } from "../../plot/plot-paint"
import { maybeTooltip, type PlotTooltipSeries } from "../../plot/plot-tooltip"
import { usePlotColors, type PlotColorToken } from "../../plot/theme"
import { asFiniteNumber, timeseriesXAxis, timeseriesYAxis, type TimeseriesRow } from "../../plot/timeseries"
import type { ServiceChartProps } from "../_shared/chart-types"
import { errorRateTimeSeriesData } from "../_shared/sample-data"

const VALUE_KEY = "errorRate"
const VALUE_KEYS = [VALUE_KEY]
const STROKE_WIDTH = 2

/** See `apdex-area-chart` — `areaY` defaults to 0.2, Recharts' `<Area>` to 0.6. */
const FILL_OPACITY = 0.6

/** How much headroom the axis leaves above the worst bucket. */
const HEADROOM = 1.2
/** The floor the axis never drops below, so a near-perfect hour still has a scale. */
const MIN_CEILING = 0.01

/** Module scope — see `usePlotColors` on why a fresh literal defeats the memo. */
const ERROR_RATE_TOKENS = {
	errorRate: ["--chart-error", "#e5484d"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * The top of the axis: the worst bucket plus headroom, never below 1% and never
 * above 100%.
 *
 * Recharts took this as a `domain` callback receiving `dataMax`. TanStack has no
 * such hook — a domain is a resolved pair — so the ceiling is computed here and
 * handed to `timeseriesYAxis` as `softMax`. It only ever WIDENS the data extent
 * (the headroom multiplier guarantees `ceiling >= dataMax` for any rate at or
 * below 100%), which is exactly what `softMax` means.
 */
export function errorRateCeiling(rows: ReadonlyArray<Record<string, unknown>>): number {
	let dataMax = 0
	for (const row of rows) {
		const value = row[VALUE_KEY]
		if (typeof value === "number" && Number.isFinite(value) && value > dataMax) dataMax = value
	}
	return Math.min(1, Math.max(dataMax * HEADROOM, MIN_CEILING))
}

// Memoized: these charts sit in synced grids whose parent rerenders on every
// atom/query settle; with stable props the whole chart subtree is skipped.
export const ErrorRateAreaChart = memo(function ErrorRateAreaChart({
	data,
	className,
	legend,
	tooltip,
	overlay,
	yAxisWidth,
}: ServiceChartProps) {
	const model = useFixedMetricModel(data ?? errorRateTimeSeriesData)
	const { rows, axisContext, chromeColors, focusStore, suppressed } = model

	const colors = usePlotColors(ERROR_RATE_TOKENS)
	const gradientPrefix = useChartId("errorRate")

	const series = useMemo<FixedMetricSeries[]>(
		() => [{ key: VALUE_KEY, label: "Error Rate", color: colors.errorRate }],
		[colors],
	)

	// The card header's series chips. A no-op outside a `WidgetShell` — the
	// service pages draw their own always-on legend, so nothing duplicates.
	usePlotLegendSlot(series)

	const tooltipSeries = useMemo<PlotTooltipSeries<TimeseriesRow>[]>(
		() => [
			{
				label: "Error Rate",
				color: colors.errorRate,
				value: (row: TimeseriesRow) => {
					const value = row[VALUE_KEY]
					return typeof value === "number" ? value : null
				},
				format: formatErrorRate,
			},
		],
		[colors],
	)

	const definition = useMemo(() => {
		const { solid, dashed } = splitAtFirstPartial(rows, VALUE_KEYS)
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
		const gradientId = `${gradientPrefix}-fill`
		const fadedGradientId = `${gradientPrefix}-fill-partial`
		const color = colors.errorRate

		const value = (row: TimeseriesRow) => asFiniteNumber(row[VALUE_KEY])

		// Fill only, with the top edge as its own `lineY` — see `apdex-area-chart`
		// for why `areaY` cannot stroke one edge on its own. The floor is 0 because
		// the domain below is anchored there: an error rate is measured against
		// zero errors, not against the quietest bucket in the window.
		const band = (rowSlice: readonly TimeseriesRow[], fill: string) =>
			areaY(rowSlice, {
				id: fill === gradientId ? "error-rate-area" : "error-rate-area-partial",
				x: (row: TimeseriesRow) => row.date,
				y: value,
				y1: () => 0,
				fill: `url(#${fill})`,
				fillOpacity: FILL_OPACITY,
				stroke: "none",
			})

		const edge = (rowSlice: readonly TimeseriesRow[], partial: boolean) =>
			lineY(rowSlice, {
				id: partial ? "error-rate-partial" : "error-rate",
				x: (row: TimeseriesRow) => row.date,
				y: value,
				stroke: color,
				strokeWidth: STROKE_WIDTH,
				strokeDasharray: partial ? partialDash : undefined,
			})

		const hasDashed = dashed.length > 0

		return defineChart({
			// A left-margin LOCK, not an axis width: `resolveMarginLocks` pins the
			// side named here and leaves the rest to the automatic solver, which is
			// what keeps plot rects aligned across a grid. See `PlotOverlayProps`.
			margin: yAxisWidth == null ? undefined : { left: yAxisWidth },
			gradients: [
				verticalGradient(gradientId, color),
				...(hasDashed ? [verticalGradient(fadedGradientId, color, 0.15, 0)] : []),
			],
			marks: [
				band(solid, gradientId),
				...(hasDashed ? [band(dashed, fadedGradientId)] : []),
				edge(solid, false),
				...(hasDashed ? [edge(dashed, true)] : []),
				focusDot(rows, (row: TimeseriesRow) => row.date, value, color, chromeColors),
				focusCrosshair(chromeColors),
			],
			x: timeseriesXAxis(axisContext),
			y: timeseriesYAxis({
				rows,
				visibleKeys: VALUE_KEYS,
				softMin: 0,
				softMax: errorRateCeiling(rows),
				format: formatErrorRate,
			}).y,
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : maybeTooltip(suppressed, focusStore.anchor),
		})
	}, [rows, colors, gradientPrefix, chromeColors, axisContext, focusStore, tooltip, suppressed, yAxisWidth])

	return (
		<PlotFrame
			className={cn("h-full w-full", className)}
			ariaLabel="Error rate"
			definition={definition}
			legend={legend === "visible" ? <FixedMetricLegend series={series} /> : undefined}
			overlay={overlay}
			renderTooltipBody={({ points }) => fixedMetricTooltipBody(model, points, tooltipSeries)}
		/>
	)
})
