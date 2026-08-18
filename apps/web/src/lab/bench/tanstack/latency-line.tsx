import { defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { formatBucketLabel, formatLatency, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
import { memo, useMemo } from "react"

import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"

import { overviewBenchRows, type OverviewBenchRow } from "./bench-data"
import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { PlotFrame } from "@maple/ui/components/plot/plot-frame"
import {
	PlotTooltipBody,
	type PlotTooltipSeries,
	createTooltipFocusStore,
	cursorTooltip,
} from "@maple/ui/components/plot/plot-tooltip"
import { usePlotChromeColors } from "@maple/ui/components/plot/theme"

const LATENCY_TOKENS = {
	p99: ["--chart-p99", "#f97316"],
	p95: ["--chart-p95", "#eab308"],
	p50: ["--chart-p50", "#22c55e"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * TanStack port of `packages/ui/src/components/charts/line/latency-line-chart.tsx`.
 *
 * The simplest of the three: stroke-only, no gradients, three linear series.
 */
export const TanstackLatencyLineChart = memo(function TanstackLatencyLineChart({
	renderer,
	className,
}: {
	renderer: TanstackRenderer
	className?: string
}) {
	const axisContext = useMemo(
		() => ({
			rangeMs: inferRangeMs(overviewBenchRows),
			bucketSeconds: inferBucketSeconds(overviewBenchRows),
		}),
		[],
	)

	const colors = usePlotColors(LATENCY_TOKENS)
	const chromeColors = usePlotChromeColors()

	const series = useMemo(
		() => [
			{ id: "p99", key: "p99LatencyMs" as const, label: "P99", color: colors.p99 },
			{ id: "p95", key: "p95LatencyMs" as const, label: "P95", color: colors.p95 },
			{ id: "p50", key: "p50LatencyMs" as const, label: "P50", color: colors.p50 },
		],
		[colors],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<OverviewBenchRow>[]>(
		() =>
			series.map((s) => ({
				label: s.label,
				color: s.color,
				value: (row: OverviewBenchRow) => row[s.key],
				format: formatLatency,
			})),
		[series],
	)

	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const definition = useMemo(() => {
		// Recharts' YAxis anchors a numeric domain at 0; TanStack's inferred linear
		// domain starts at the data minimum, which clips the p50 line to the axis.
		// Configuring the scale instance is the only way to pin the floor.
		const dataMax = overviewBenchRows.reduce((max, row) => Math.max(max, row.p99LatencyMs), 0)

		return defineChart({
			marks: [
				...series.map((s) =>
					lineY(overviewBenchRows, {
						id: s.id,
						x: (d: OverviewBenchRow) => d.bucket,
						y: (d: OverviewBenchRow) => d[s.key],
						stroke: s.color,
						strokeWidth: 2,
					}),
				),
				...series.map((s) =>
					focusDot(
						overviewBenchRows,
						(d: OverviewBenchRow) => d.bucket,
						(d: OverviewBenchRow) => d[s.key],
						s.color,
						chromeColors,
					),
				),
				focusCrosshair(chromeColors),
			],
			x: {
				scale: scalePoint,
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
			// Recharts draws no dots on these lines; `whenFocused(dot(...))` renders
			// one circle per datum and hides the unfocused ones, so the focus ring is
			// left off and the tooltip carries the readout.
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [series, axisContext, focusStore, chromeColors])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Latency percentiles"
			definition={definition}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={focusStore}
					heading={(row: OverviewBenchRow) => formatBucketLabel(row.bucket, axisContext, "tooltip")}
				/>
			)}
		/>
	)
})
