import { areaY, defineChart, lineY } from "@tanstack/charts"
import { memo, useMemo } from "react"

import { cn } from "../../../lib/utils"
import {
	FixedMetricLegend,
	PlotFrame,
	asFiniteNumber,
	dashedGridY,
	fixedMetricTooltipBody,
	focusCrosshair,
	focusDot,
	hoistsLegend,
	maybeTooltip,
	roundCapDasharray,
	splitAtFirstPartial,
	timeseriesXAxis,
	timeseriesYAxis,
	useChartId,
	useFixedMetricModel,
	usePlotColors,
	usePlotLegendSlot,
	verticalGradient,
	type FixedMetricSeries,
	type PlotColorToken,
	type PlotTooltipSeries,
	type TimeseriesRow,
} from "../../plot"
import type { ServiceChartProps } from "../_shared/chart-types"
import { apdexTimeSeriesData } from "../_shared/sample-data"

const VALUE_KEY = "apdexScore"
const VALUE_KEYS = [VALUE_KEY]
const STROKE_WIDTH = 2

/**
 * `areaY` defaults `fillOpacity` to 0.2, far fainter than the Recharts `<Area>`
 * default of 0.6 this chart was tuned against. Stated rather than inherited.
 */
const FILL_OPACITY = 0.6

/** Module scope — see `usePlotColors` on why a fresh literal defeats the memo. */
const APDEX_TOKENS = {
	apdexScore: ["--chart-apdex", "#3fb27f"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

// Memoized: these charts sit in synced grids whose parent rerenders on every
// atom/query settle; with stable props the whole chart subtree is skipped.
export const ApdexAreaChart = memo(function ApdexAreaChart({
	data,
	className,
	legend,
	tooltip,
	overlay,
	yAxisWidth,
}: ServiceChartProps) {
	const model = useFixedMetricModel(data ?? apdexTimeSeriesData)
	const { plotRows, trimOptions, axisContext, chromeColors, focusStore, suppressed } = model

	const colors = usePlotColors(APDEX_TOKENS)
	const gradientPrefix = useChartId("apdex")

	const series = useMemo<FixedMetricSeries[]>(
		() => [{ key: VALUE_KEY, label: "Apdex", color: colors.apdexScore }],
		[colors],
	)

	// The card header's series chips, top-right of the tile. A no-op outside a
	// `WidgetShell` — the service pages draw their own always-on legend.
	//
	// `hoistsLegend` is the gate, not an unconditional publish: a chart already
	// drawing the strip under its plot would otherwise print its series twice,
	// once bottom-left and once in the header. See `hoistsLegend`.
	usePlotLegendSlot(hoistsLegend(legend) ? series : null)

	const tooltipSeries = useMemo<PlotTooltipSeries<TimeseriesRow>[]>(
		() => [
			{
				label: "Apdex",
				color: colors.apdexScore,
				value: (row: TimeseriesRow) => {
					const value = row[VALUE_KEY]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => value.toFixed(2),
			},
		],
		[colors],
	)

	const definition = useMemo(() => {
		// The in-flight tail is a SECOND pair of marks over an overlapping slice —
		// `areaY` has no `strokeDasharray` at all and `lineY`'s is a scalar, so no
		// single mark can change style mid-series.
		// `plotRows`, not `rows`: everything inside this definition becomes a mark,
		// and a mark's channels feed scale inference whether or not it paints.
		const { solid, dashed } = splitAtFirstPartial(plotRows, VALUE_KEYS, trimOptions)
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)
		const gradientId = `${gradientPrefix}-fill`
		const fadedGradientId = `${gradientPrefix}-fill-partial`
		const color = colors.apdexScore

		const value = (row: TimeseriesRow) => asFiniteNumber(row[VALUE_KEY])

		/**
		 * Fill only. `areaY` strokes the CLOSED polygon (top edge, baseline and both
		 * verticals) at 0.14.0, so a top-edge-only stroke has to be a `lineY` over
		 * the same slice — the composition the package's own examples use.
		 *
		 * The floor is 0 rather than the axis minimum because the domain below is
		 * pinned to `[0, 1]`: apdex is a score on a fixed scale, and letting the
		 * band start anywhere else would misreport it.
		 */
		const band = (rowSlice: readonly TimeseriesRow[], fill: string, opacity: number) =>
			areaY(rowSlice, {
				id: fill === gradientId ? "apdex-area" : "apdex-area-partial",
				x: (row: TimeseriesRow) => row.date,
				y: value,
				y1: () => 0,
				fill: `url(#${fill})`,
				fillOpacity: opacity,
				stroke: "none",
			})

		const edge = (rowSlice: readonly TimeseriesRow[], partial: boolean) =>
			lineY(rowSlice, {
				id: partial ? "apdex-partial" : "apdex",
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
				dashedGridY(),
				band(solid, gradientId, FILL_OPACITY),
				...(hasDashed ? [band(dashed, fadedGradientId, FILL_OPACITY)] : []),
				edge(solid, false),
				...(hasDashed ? [edge(dashed, true)] : []),
				// `plotRows`: a focus dot over a bucket no band draws is what kept the
				// dropped in-flight slot on the axis and hoverable.
				focusDot(plotRows, (row: TimeseriesRow) => row.date, value, color, chromeColors),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: timeseriesXAxis(axisContext),
				// Apdex is a 0–1 score: the axis is the SCALE, not the data extent, so
				// both bounds are pinned and a good hour does not silently rescale into
				// looking like a bad one.
				y: timeseriesYAxis({ rows: plotRows, visibleKeys: VALUE_KEYS, softMin: 0, softMax: 1 }).y,
			},
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : maybeTooltip(suppressed, focusStore.anchor),
		})
	}, [
		plotRows,
		trimOptions,
		colors,
		gradientPrefix,
		chromeColors,
		axisContext,
		focusStore,
		tooltip,
		suppressed,
		yAxisWidth,
	])

	return (
		<PlotFrame
			className={cn("h-full w-full", className)}
			ariaLabel="Apdex score"
			definition={definition}
			legend={legend === "visible" ? <FixedMetricLegend series={series} /> : undefined}
			overlay={overlay}
			renderTooltipBody={({ points }) => fixedMetricTooltipBody(model, points, tooltipSeries)}
		/>
	)
})
