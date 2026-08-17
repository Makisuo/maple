import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatBucketLabel, formatLatency } from "@maple/ui/lib/format"
import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, type ReactNode } from "react"

import {
	ChartSeriesLegend,
	useChartLegendState,
	type LegendSeriesSpec,
} from "@/lab/bench/tanstack/chart-legend"
import {
	createTooltipFocusProbe,
	focusCrosshair,
	focusDot,
	roundCapDasharray,
	TooltipBody,
	usePlotChromeColors,
	type TooltipSeriesSpec,
} from "@/lab/bench/tanstack/chart-shared"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
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
 * The figure itself, over whatever series it is handed.
 *
 * `series` is the VISIBLE set, not the full one: hiding a percentile removes its
 * marks and re-derives the y domain, which is why the legend's state lives in the
 * variant below rather than inside the legend component.
 */
function LineFigure({
	rows,
	renderer,
	incomplete,
	className,
	series,
	legend,
}: {
	rows: readonly TimeseriesSpikeRow[]
	renderer: TanstackRenderer
	incomplete: boolean
	className?: string
	series: readonly LatencySeries[]
	legend?: ReactNode
}) {
	const chromeColors = usePlotChromeColors()

	const axisContext = useMemo(() => timeseriesAxisContext(rows), [rows])

	const tooltipSeries = useMemo<TooltipSeriesSpec<TimeseriesSpikeRow>[]>(
		() =>
			series.map((s) => ({
				label: s.label,
				color: s.color,
				value: (row: TimeseriesSpikeRow) => row[s.key],
				format: formatLatency,
			})),
		[series],
	)

	const { probe, anchor: tooltipAnchor } = useMemo(() => createTooltipFocusProbe<TimeseriesSpikeRow>(), [])

	const definition = useMemo(() => {
		const { solid, dashed } = incomplete
			? splitAtFirstPartial(rows)
			: { solid: rows, dashed: [] as readonly TimeseriesSpikeRow[] }

		// Recharts' YAxis anchors a numeric domain at 0; TanStack's inferred linear
		// domain starts at the data minimum, which clips the p50 line to the axis.
		// Configuring the scale instance is the only way to pin the floor.
		//
		// Derived from the VISIBLE series rather than from `p99LatencyMs`: with the
		// legend, hiding p99 has to drop the ceiling to p95, or the remaining lines
		// stay squashed into the bottom third and the toggle looks like it did
		// nothing. `|| 1` covers every series hidden — a `[0, 0]` domain has no
		// extent for `nice` to round.
		const dataMax =
			rows.reduce(
				(max, row) => series.reduce((seriesMax, s) => Math.max(seriesMax, row[s.key]), max),
				0,
			) || 1

		return defineChart({
			marks: [
				...series.map((s) =>
					lineY(solid, {
						id: s.id,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: (d: TimeseriesSpikeRow) => d[s.key],
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
					}),
				),
				...series.map((s) =>
					lineY(dashed, {
						id: `${s.id}Incomplete`,
						x: (d: TimeseriesSpikeRow) => d.bucket,
						y: (d: TimeseriesSpikeRow) => d[s.key],
						stroke: s.color,
						strokeWidth: STROKE_WIDTH,
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
						(d: TimeseriesSpikeRow) => d.bucket,
						(d: TimeseriesSpikeRow) => d[s.key],
						s.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: {
				// Pinned to every bucket, not inferred. Two marks over two slices would
				// otherwise each contribute part of the domain, and a point scale built
				// from a union has no guarantee of staying in bucket order.
				scale: scalePoint(
					rows.map((row) => row.bucket),
					[0, 1],
				),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						spacing: 72,
						format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
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
			tooltip: {
				use: tooltip,
				className: "maple-bench-tooltip",
				// Anchor to the CURSOR, not the datum: the default "point" anchor snaps
				// the card to each bucket's plotted position and shifts it as the pointer
				// moves. The callback form also captures the scales the row highlight
				// needs.
				anchor: tooltipAnchor,
				placement: "right",
				offset: 12,
			},
		})
	}, [rows, series, incomplete, axisContext, tooltipAnchor, chromeColors])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Latency percentiles"
			definition={definition}
			legend={legend}
			renderTooltipBody={({ points }) => (
				<TooltipBody
					points={points}
					series={tooltipSeries}
					probe={probe}
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
 * The same chart with a series key beneath it, matching what the Recharts arm
 * renders via `QueryBuilderLegend`.
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

	const legendSeries = useMemo<LegendSeriesSpec[]>(
		() => series.map((s) => ({ key: s.id, label: s.label, color: s.color })),
		[series],
	)
	const { hidden, toggle } = useChartLegendState(legendSeries)

	const visibleSeries = useMemo(() => series.filter((s) => !hidden.has(s.id)), [series, hidden])

	return (
		<LineFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			series={visibleSeries}
			legend={
				<ChartSeriesLegend
					series={legendSeries}
					hidden={hidden}
					onToggle={toggle}
					label="Latency percentiles"
				/>
			}
		/>
	)
})
