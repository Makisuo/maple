import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatBucketLabel, formatLatency } from "@maple/ui/lib/format"
import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo } from "react"

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
 * The trailing incomplete segment. Production draws a visible 4-on / 4-off
 * (`latency-line-chart.tsx:135-173`); this is deliberately longer because the
 * stroke is thicker, and it goes through `roundCapDasharray` because `lineY`
 * forces round caps — see that function for why `"4 4"` does not port.
 */
const INCOMPLETE_DASHARRAY = roundCapDasharray(6, 5, STROKE_WIDTH)

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
	const colors = usePlotColors(LATENCY_TOKENS)
	const chromeColors = usePlotChromeColors()

	const axisContext = useMemo(() => timeseriesAxisContext(rows), [rows])

	const series = useMemo(
		() => [
			{ id: "p99", key: "p99LatencyMs" as const, label: "P99", color: colors.p99 },
			{ id: "p95", key: "p95LatencyMs" as const, label: "P95", color: colors.p95 },
			{ id: "p50", key: "p50LatencyMs" as const, label: "P50", color: colors.p50 },
		],
		[colors],
	)

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
		const dataMax = rows.reduce((max, row) => Math.max(max, row.p99LatencyMs), 0)

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
})
