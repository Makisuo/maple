import { defineChart, lineY } from "@tanstack/charts"
import { memo, useMemo } from "react"

import { formatLatency } from "../../../lib/format"
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
import { roundCapDasharray } from "../../plot/plot-paint"
import { maybeTooltip, type PlotTooltipSeries } from "../../plot/plot-tooltip"
import { usePlotColors, type PlotColorToken } from "../../plot/theme"
import {
	hoistsLegend,
	asFiniteNumber,
	timeseriesXAxis,
	timeseriesYAxis,
	type TimeseriesRow,
} from "../../plot/timeseries"
import type { ServiceChartProps } from "../_shared/chart-types"
import { latencyTimeSeriesData } from "../_shared/sample-data"

const STROKE_WIDTH = 2

/**
 * Paint order, and it is deliberate: p99 first so the tighter percentiles draw
 * over it. The colours are the product-wide latency identities, so they are
 * named tokens rather than palette slots — see `semantic-series-colors.ts`,
 * which assigns the same three to a query-builder series called "p95".
 *
 * Module scope: `usePlotColors` memoizes on this object's identity, and a fresh
 * literal per render would re-read computed style every frame.
 */
const LATENCY_TOKENS = {
	p99LatencyMs: ["--chart-p99", "#e0484a"],
	p95LatencyMs: ["--chart-p95", "#e0a23a"],
	p50LatencyMs: ["--chart-p50", "#4f8ef7"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

const LATENCY_LABELS = {
	p99LatencyMs: "P99",
	p95LatencyMs: "P95",
	p50LatencyMs: "P50",
} as const satisfies Record<keyof typeof LATENCY_TOKENS, string>

const VALUE_KEYS = Object.keys(LATENCY_TOKENS) as (keyof typeof LATENCY_TOKENS)[]

// Memoized: these charts sit in synced grids whose parent rerenders on every
// atom/query settle; with stable props the whole chart subtree is skipped.
export const LatencyLineChart = memo(function LatencyLineChart({
	data,
	className,
	legend,
	tooltip,
	overlay,
	yAxisWidth,
}: ServiceChartProps) {
	const model = useFixedMetricModel(data ?? latencyTimeSeriesData)
	const { rows, axisContext, chromeColors, focusStore, suppressed } = model

	const colors = usePlotColors(LATENCY_TOKENS)

	const series = useMemo<FixedMetricSeries[]>(
		() => VALUE_KEYS.map((key) => ({ key, label: LATENCY_LABELS[key], color: colors[key] })),
		[colors],
	)

	// The card header's series chips, top-right of the tile. A no-op outside a
	// `WidgetShell` — the service pages draw their own always-on legend.
	//
	// `hoistsLegend` is the gate, not an unconditional publish: a chart already
	// drawing the strip under its plot would otherwise print its series twice,
	// once bottom-left and once in the header. See `hoistsLegend`.
	const hoisted = usePlotLegendSlot(hoistsLegend(legend) ? series : null)

	const tooltipSeries = useMemo<PlotTooltipSeries<TimeseriesRow>[]>(
		() =>
			series.map((entry) => ({
				label: entry.label,
				color: entry.color,
				value: (row: TimeseriesRow) => {
					const value = row[entry.key]
					return typeof value === "number" ? value : null
				},
				format: formatLatency,
			})),
		[series],
	)

	const definition = useMemo(() => {
		// The dashed tail is a SECOND mark over an overlapping slice, not a dash
		// pattern on the first: `strokeDasharray` on `lineY` is a scalar, not a
		// per-datum channel, so one mark cannot change style mid-line. This is what
		// replaces the `key`/`key_incomplete` twin-column rewrite Recharts needed,
		// where a `<Line dataKey>` string could not change style mid-series.
		const { solid, dashed } = splitAtFirstPartial(rows, VALUE_KEYS)
		// `lineY` hard-codes a round cap, which eats the gap — see `roundCapDasharray`.
		const partialDash = roundCapDasharray(4, 4, STROKE_WIDTH)

		const line = (rowSlice: readonly TimeseriesRow[], entry: FixedMetricSeries, dash: boolean) =>
			lineY(rowSlice, {
				id: dash ? `${entry.key}-partial` : entry.key,
				x: (row: TimeseriesRow) => row.date,
				y: (row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
				stroke: entry.color,
				strokeWidth: STROKE_WIDTH,
				strokeDasharray: dash ? partialDash : undefined,
			})

		return defineChart({
			// A left-margin LOCK, not an axis width: `resolveMarginLocks` pins the
			// side named here and leaves the rest to the automatic solver, which is
			// what keeps plot rects aligned across a grid. See `PlotOverlayProps`.
			margin: yAxisWidth == null ? undefined : { left: yAxisWidth },
			marks: [
				dashedGridY(),
				...series.map((entry) => line(solid, entry, false)),
				...(dashed.length > 0 ? series.map((entry) => line(dashed, entry, true)) : []),
				...series.map((entry) =>
					focusDot(
						rows,
						(row: TimeseriesRow) => row.date,
						(row: TimeseriesRow) => asFiniteNumber(row[entry.key]),
						entry.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: timeseriesXAxis(axisContext),
			y: timeseriesYAxis({ rows, visibleKeys: VALUE_KEYS, format: formatLatency }).y,
			focus: "group-x",
			focusRing: false,
			tooltip: tooltip === "hidden" ? false : maybeTooltip(suppressed, focusStore.anchor),
		})
	}, [rows, series, chromeColors, axisContext, focusStore, tooltip, suppressed, yAxisWidth])

	return (
		<PlotFrame
			className={cn("h-full w-full", className)}
			ariaLabel="Latency percentiles"
			definition={definition}
			legend={!hoisted && legend === "visible" ? <FixedMetricLegend series={series} /> : undefined}
			overlay={overlay}
			renderTooltipBody={({ points }) => fixedMetricTooltipBody(model, points, tooltipSeries)}
		/>
	)
})
