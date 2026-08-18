import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatBucketLabel, formatLatency } from "@maple/ui/lib/format"
import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleTime } from "d3-scale"
import { memo, useMemo, type ReactNode } from "react"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
import { muteColor } from "@maple/ui/components/plot/color-scale"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { PlotFrame } from "@maple/ui/components/plot/plot-frame"
import {
	MUTED_COLOR_AMOUNT,
	MUTED_OPACITY,
	type PlotLegendSeries,
	PlotSeriesLegend,
	usePlotLegendHighlight,
} from "@maple/ui/components/plot/plot-legend"
import { roundCapDasharray } from "@maple/ui/components/plot/plot-paint"
import {
	PlotTooltipBody,
	type PlotTooltipSeries,
	createTooltipFocusStore,
	cursorTooltip,
} from "@maple/ui/components/plot/plot-tooltip"
import { usePlotChromeColors } from "@maple/ui/components/plot/theme"

import {
	splitAtFirstPartial,
	timeseriesAxisContext,
	type TimeseriesSpikeRow,
} from "@/lab/charts/timeseries-data"

const LATENCY_TOKENS = {
	p99: ["--chart-p99", "#f97316"],
	p95: ["--chart-p95", "#eab308"],
	p50: ["--chart-p50", "#22c55e"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * Recharts and TanStack both nominally draw at 2px
 * (`query-builder-line-chart.tsx:330`), but the TanStack stroke reads visibly
 * thinner beside it. Matched by eye rather than by number.
 */
const STROKE_WIDTH = 2.5

/**
 * The trailing incomplete segment: a visible 4.5px on, 7px off.
 *
 * Production's 4-on / 4-off (`latency-line-chart.tsx:135-173`) is a 50% duty
 * cycle, and measured side by side an equivalent port here still read as a
 * textured solid line rather than a dashed one. The reason is not the dash — it
 * is that Recharts beads the SOLID twin with a dot at every point and sets
 * `dot={false}` on the incomplete one, so half the "this part is different"
 * signal there comes from the dots disappearing. This chart draws no dots at
 * rest, so the dash carries all of it and has to be more open: a ~39% duty cycle
 * with the gap noticeably longer than the ink.
 *
 * Routed through `roundCapDasharray` because `lineY` forces round caps — see
 * that function for why a literal `"4 4"` does not port at all.
 */
const INCOMPLETE_DASHARRAY = roundCapDasharray(4.5, 7, STROKE_WIDTH)

interface LatencySeries {
	id: string
	key: "p99LatencyMs" | "p95LatencyMs" | "p50LatencyMs"
	label: string
	color: string
}

/** The three percentiles, themed. Shared by both variants below. */
function useLatencySeries(): readonly LatencySeries[] {
	const colors = usePlotColors(LATENCY_TOKENS)
	return useMemo(
		() => [
			{ id: "p99", key: "p99LatencyMs", label: "P99", color: colors.p99 },
			{ id: "p95", key: "p95LatencyMs", label: "P95", color: colors.p95 },
			{ id: "p50", key: "p50LatencyMs", label: "P50", color: colors.p50 },
		],
		[colors],
	)
}

/**
 * The figure itself.
 *
 * `mutedIds` names the series the legend is pushing back — every series is still
 * drawn, and the y domain is still derived from all of them, so emphasis never
 * moves the axis.
 */
function LineFigure({
	rows,
	renderer,
	incomplete,
	className,
	series,
	mutedIds,
	legend,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete: boolean
	className?: string
	series: readonly LatencySeries[]
	mutedIds?: ReadonlySet<string>
	legend?: ReactNode
}) {
	const chromeColors = usePlotChromeColors()

	const axisContext = useMemo(() => timeseriesAxisContext(rows), [rows])

	const tooltipSeries = useMemo<PlotTooltipSeries<TimeseriesSpikeRow>[]>(
		() =>
			series.map((s) => ({
				label: s.label,
				color: s.color,
				value: (row: TimeseriesSpikeRow) => row[s.key],
				format: formatLatency,
			})),
		[series],
	)

	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const definition = useMemo(() => {
		const { solid, dashed } = incomplete
			? splitAtFirstPartial(rows)
			: { solid: rows, dashed: [] as readonly TimeseriesSpikeRow[] }

		// Recharts' YAxis anchors a numeric domain at 0; TanStack's inferred linear
		// domain starts at the data minimum, which clips the p50 line to the axis.
		// Configuring the scale instance is the only way to pin the floor.
		//
		// Over every series, muted ones included — that is the point of highlighting
		// rather than hiding. A domain that tracked the emphasised series would
		// rescale the axis on every click, which is exactly the jump this interaction
		// avoids.
		const dataMax = rows.reduce(
			(max, row) => series.reduce((seriesMax, s) => Math.max(seriesMax, row[s.key]), max),
			0,
		)

		// One mark per series, so a FLAT `strokeOpacity` is already per-series here —
		// no colour arithmetic needed. The single-mark charts (stacked bar, pie,
		// treemap) have no such luxury; see `muteColor`.
		const opacityFor = (id: string) => (mutedIds?.has(id) ? MUTED_OPACITY : 1)

		return defineChart({
			marks: [
				...series.map((s) =>
					lineY(solid, {
						id: s.id,
						x: (d: TimeseriesSpikeRow) => d.date,
						y: (d: TimeseriesSpikeRow) => d[s.key],
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
						strokeOpacity: opacityFor(s.id),
					}),
				),
				...series.map((s) =>
					lineY(dashed, {
						id: `${s.id}Incomplete`,
						x: (d: TimeseriesSpikeRow) => d.date,
						y: (d: TimeseriesSpikeRow) => d[s.key],
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
						strokeOpacity: opacityFor(s.id),
						// A plain string here, unlike `barY`, where the same option is a
						// per-datum channel.
						strokeDasharray: INCOMPLETE_DASHARRAY,
					}),
				),
				// Over `rows`, not the slices: the focus dot has to appear on the dashed
				// tail too, and one mark per series covers the whole domain.
				...series.map((s) =>
					focusDot(
						rows,
						(d: TimeseriesSpikeRow) => d.date,
						(d: TimeseriesSpikeRow) => d[s.key],
						// The dot has to fade with its line. `dot`'s `fill` is a channel but
						// its opacity is not, so a muted dot is a muted COLOUR — the same
						// constraint `muteColor` exists for.
						mutedIds?.has(s.id)
							? muteColor(s.color, chromeColors.background, MUTED_COLOR_AMOUNT)
							: s.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: {
				// A d3 TIME scale over the precomputed `row.date`, per the Scales and D3
				// guide — the compact scales stop at linear/band/point/ordinal, and a
				// point scale over ISO strings put axis ticks on arbitrary buckets
				// ("08:25 PM") instead of clock boundaries.
				//
				// The bare FACTORY, as the docs example passes it: `isScaleFactory` is
				// `typeof source === "function" && !("copy" in source)`
				// (`dist/scale-input.js`), and `"copy" in scaleTime` is false — `copy`
				// lives on the instance, so the factory infers its domain from the data.
				// Inference is safe here even though the solid and dashed marks each
				// cover only a slice: a continuous domain is min/max over the union
				// (`inferScaleDomain`), which is order-independent, and the slices
				// overlap at the bridge row — so the inferred domain IS the old pinned
				// one, [first bucket, last bucket]. The point-scale pinning existed
				// because a CATEGORICAL union had no such guarantee.
				//
				// No `nice`: snapping the domain outward would detach the first/last
				// point from the plot edges, which the Recharts arm this lab diffs
				// against does not do.
				//
				// `scaleTime`, not the docs' `scaleUtc`: labels below render in LOCAL
				// time (`formatBucketLabel` uses `toLocaleTimeString`), and only
				// local-time ticks land on locally round boundaries — UTC ticks read as
				// ":15"/":45" in a fractional-offset timezone.
				scale: scaleTime,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						spacing: 72,
						// Ticks are now Dates the SCALE chose, not row buckets, so this
						// cannot pass `value.bucket` — and `formatBucketLabel` returns ""
						// for anything but a string. Round-tripping through ISO keeps the
						// labels byte-identical to the production arm's; ~7 ticks per
						// render, so the allocation is noise.
						format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
					},
				},
			},
			y: {
				scale: scaleLinear().domain([0, dataMax]),
				nice: true,
				grid: true,
				axis: {
					line: false,
					ticks: { size: 0, padding: 6, format: (value: number) => formatLatency(value) },
				},
			},
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, series, mutedIds, incomplete, axisContext, focusStore, chromeColors])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Latency percentiles"
			definition={definition}
			legend={legend}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={focusStore}
					heading={(row: TimeseriesSpikeRow) =>
						`${formatBucketLabel(row.bucket, axisContext, "tooltip")}${row.partial ? " · partial" : ""}`
					}
				/>
			)}
		/>
	)
}

/**
 * Latency percentiles, replacing
 * `packages/ui/src/components/charts/line/query-builder-line-chart.tsx`.
 *
 * With `incomplete`, the trailing buckets that are still filling are drawn
 * dashed. Recharts can only do that by splitting each series into two columns
 * (`p99LatencyMs` and `p99LatencyMs_incomplete`, bridged by duplicating one
 * value into both) because a `dataKey` is a string and one string means one dash
 * style. TanStack channels are accessors, so the same picture is a second mark
 * over a SLICE of the same rows — see `splitAtFirstPartial`. No row is rewritten
 * and no column is invented; the shared bridge row makes the join seamless.
 */
export const LineSpike = memo(function LineSpike({
	rows,
	renderer,
	incomplete = false,
	className,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete?: boolean
	className?: string
}) {
	const series = useLatencySeries()
	return (
		<LineFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			series={series}
		/>
	)
})

/**
 * The same chart with a series key beneath it.
 *
 * A sibling component rather than a `legend` flag on `LineSpike`: the two differ
 * in what state they own, not in what they display, and the legend-less variant
 * stays byte-identical so the FINDINGS.md baseline numbers remain comparable.
 */
export const LineLegendSpike = memo(function LineLegendSpike({
	rows,
	renderer,
	incomplete = false,
	className,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete?: boolean
	className?: string
}) {
	const series = useLatencySeries()

	const legendSeries = useMemo<PlotLegendSeries[]>(
		() => series.map((s) => ({ key: s.id, label: s.label, color: s.color })),
		[series],
	)
	const { highlighted, highlight } = usePlotLegendHighlight()

	const mutedIds = useMemo(
		() =>
			new Set(highlighted === null ? [] : series.filter((s) => s.id !== highlighted).map((s) => s.id)),
		[series, highlighted],
	)

	return (
		<LineFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			series={series}
			mutedIds={mutedIds}
			legend={
				<PlotSeriesLegend
					series={legendSeries}
					highlighted={highlighted}
					onHighlight={highlight}
					label="Latency percentiles"
				/>
			}
		/>
	)
})
