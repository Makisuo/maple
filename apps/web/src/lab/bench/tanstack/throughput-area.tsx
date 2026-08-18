import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { formatBucketLabel, formatThroughput, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
import { memo, useMemo } from "react"

import { overviewBenchRows, type OverviewBenchRow } from "./bench-data"

import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { PlotFrame } from "@maple/ui/components/plot/plot-frame"
import { useChartId, verticalGradient } from "@maple/ui/components/plot/plot-paint"
import {
	PlotTooltipBody,
	type PlotTooltipSeries,
	createTooltipFocusStore,
	cursorTooltip,
} from "@maple/ui/components/plot/plot-tooltip"
import { usePlotChromeColors } from "@maple/ui/components/plot/theme"

/** The overview row plus the two per-second series this chart derives. */
interface ThroughputBenchRow extends OverviewBenchRow {
	errorThroughput: number
}

const THROUGHPUT_TOKENS = {
	throughput: ["--chart-throughput", "#3b82f6"],
	error: ["--chart-error", "#ef4444"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * TanStack port of `packages/ui/src/components/charts/area/throughput-area-chart.tsx`,
 * in its `rateMode: "per_second"` configuration with the error-throughput overlay —
 * the shape the `/` overview actually renders. The per-second normalization and the
 * derived `errorThroughput` series are plain data work, identical in both arms.
 */
export const TanstackThroughputAreaChart = memo(function TanstackThroughputAreaChart({
	renderer,
	className,
}: {
	renderer: TanstackRenderer
	className?: string
}) {
	const bucketSeconds = useMemo(() => inferBucketSeconds(overviewBenchRows), [])
	const rateLabel = "/s"

	const axisContext = useMemo(
		() => ({ rangeMs: inferRangeMs(overviewBenchRows), bucketSeconds }),
		[bucketSeconds],
	)

	const rows = useMemo(() => {
		const divisor = bucketSeconds || 1
		return overviewBenchRows.map((row) => {
			const throughput = row.throughput / divisor
			return {
				...row,
				throughput,
				// `errorRate` is a FRACTION (errors / requests), not a percentage —
				// `formatErrorRate` multiplies by 100 on the way out, and production
				// says so at `throughput-area-chart.tsx:96`. An earlier `/ 100` here
				// drew the error series at 1/100 of its value, flat against the axis,
				// so the two arms of the bench were not painting the same chart.
				errorThroughput: throughput * row.errorRate,
			}
		})
	}, [bucketSeconds])

	const colors = usePlotColors(THROUGHPUT_TOKENS)
	const chromeColors = usePlotChromeColors()

	const tooltipSeries = useMemo<PlotTooltipSeries<ThroughputBenchRow>[]>(
		() => [
			{
				label: "Throughput",
				color: colors.throughput,
				value: (row: ThroughputBenchRow) => row.throughput,
				format: (value) => `${Number(value).toLocaleString()}${rateLabel}`,
			},
			{
				label: "Errors",
				color: colors.error,
				dashed: true,
				value: (row: ThroughputBenchRow) => row.errorThroughput,
				format: (value) => `${Number(value).toLocaleString()}${rateLabel}`,
			},
		],
		[colors],
	)

	const gradientId = useChartId("benchThroughput")

	const focusStore = useMemo(() => createTooltipFocusStore<ThroughputBenchRow>(), [])

	const definition = useMemo(() => {
		const dataMax = rows.reduce((max, row) => Math.max(max, row.throughput), 0)

		return defineChart({
			gradients: [verticalGradient(gradientId, colors.throughput)],
			marks: [
				areaY(rows, {
					id: "throughputArea",
					x: (d: ThroughputBenchRow) => d.bucket,
					y: (d: ThroughputBenchRow) => d.throughput,
					fill: `url(#${gradientId})`,
					stroke: "none",
				}),
				lineY(rows, {
					id: "throughputLine",
					x: (d: ThroughputBenchRow) => d.bucket,
					y: (d: ThroughputBenchRow) => d.throughput,
					stroke: colors.throughput,
					strokeWidth: 2,
				}),
				lineY(rows, {
					id: "errorThroughput",
					x: (d: ThroughputBenchRow) => d.bucket,
					y: (d: ThroughputBenchRow) => d.errorThroughput,
					stroke: colors.error,
					strokeWidth: 1.5,
					strokeDasharray: "3 3",
				}),
				focusDot(
					rows,
					(d: ThroughputBenchRow) => d.bucket,
					(d: ThroughputBenchRow) => d.throughput,
					colors.throughput,
					chromeColors,
				),
				focusDot(
					rows,
					(d: ThroughputBenchRow) => d.bucket,
					(d: ThroughputBenchRow) => d.errorThroughput,
					colors.error,
					chromeColors,
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
				// Recharts anchors a numeric YAxis at 0 by default (production passes
				// no `domain`, `throughput-area-chart.tsx:152`); TanStack's inferred
				// linear domain starts at the data minimum, which floats the area off
				// the axis. Same pin as `latency-line.tsx`.
				scale: scaleLinear().domain([0, dataMax]),
				nice: true,
				grid: true,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 6,
						format: (value: number) => formatThroughput(value, rateLabel),
					},
				},
			},
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, colors, gradientId, axisContext, focusStore, chromeColors])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Request volume"
			definition={definition}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={focusStore}
					heading={(row: ThroughputBenchRow) =>
						formatBucketLabel(row.bucket, axisContext, "tooltip")
					}
				/>
			)}
		/>
	)
})
