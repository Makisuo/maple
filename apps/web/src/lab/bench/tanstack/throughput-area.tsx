import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { tooltip } from "@tanstack/charts/tooltip"
import { formatBucketLabel, formatThroughput, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
import { memo, useMemo } from "react"

import { overviewBenchRows, type OverviewBenchRow } from "./bench-data"

import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"

import {
	createTooltipFocusProbe,
	focusCrosshair,
	focusDot,
	TooltipBody,
	usePlotChromeColors,
	verticalGradient,
	type TooltipSeriesSpec,
} from "./chart-shared"
import { TanstackChartFrame, type TanstackRenderer } from "./tanstack-chart"

/** The overview row plus the two per-second series this chart derives. */
interface ThroughputBenchRow extends OverviewBenchRow {
	errorThroughput: number
}

const GRADIENT_ID = "benchThroughputGradient"

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
				errorThroughput: (throughput * row.errorRate) / 100,
			}
		})
	}, [bucketSeconds])

	const colors = usePlotColors(THROUGHPUT_TOKENS)
	const chromeColors = usePlotChromeColors()

	const tooltipSeries = useMemo<TooltipSeriesSpec<ThroughputBenchRow>[]>(
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

	const { probe, anchor: tooltipAnchor } = useMemo(() => createTooltipFocusProbe<ThroughputBenchRow>(), [])

	const definition = useMemo(
		() =>
			defineChart({
				gradients: [verticalGradient(GRADIENT_ID, colors.throughput)],
				marks: [
					areaY(rows, {
						id: "throughputArea",
						x: (d: ThroughputBenchRow) => d.bucket,
						y: (d: ThroughputBenchRow) => d.throughput,
						fill: `url(#${GRADIENT_ID})`,
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
					scale: scaleLinear,
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
				tooltip: {
					use: tooltip,
					className: "maple-bench-tooltip",
					// Anchor to the CURSOR, not the datum. The default "point" anchor
					// snaps the card to each bucket's plotted position, and with
					// placement "auto" it re-picks a side as it goes — a 60px pointer
					// move shifted the card 97px. `ChartFloatingTooltip` anchors at the
					// cursor with a fixed side for exactly this reason. The callback form
					// returns the pointer AND captures the scales the row highlight needs.
					anchor: tooltipAnchor,
					placement: "right",
					offset: 12,
				},
			}),
		[rows, colors, axisContext, tooltipAnchor, chromeColors],
	)

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Request volume"
			definition={definition}
			renderTooltipBody={({ points }) => (
				<TooltipBody
					points={points}
					series={tooltipSeries}
					probe={probe}
					heading={(row: ThroughputBenchRow) =>
						formatBucketLabel(row.bucket, axisContext, "tooltip")
					}
				/>
			)}
		/>
	)
})
