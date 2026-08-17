import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { tooltip } from "@tanstack/charts/tooltip"
import { formatBucketLabel, formatErrorRate, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
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

const GRADIENT_ID = "benchErrorRateGradient"

const ERROR_RATE_TOKENS = {
	error: ["--chart-error", "#ef4444"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * TanStack port of `packages/ui/src/components/charts/area/error-rate-area-chart.tsx`.
 *
 * Two structural differences from Recharts worth recording:
 *  - `areaY` strokes the whole outline (baseline and both verticals), so matching
 *    Recharts' top-edge-only stroke means a fill-only `areaY` plus a `lineY` on top.
 *  - Recharts takes a function-max y domain; TanStack takes a configured scale
 *    instance, so the clamp is computed up front instead of per render pass.
 */
export const TanstackErrorRateAreaChart = memo(function TanstackErrorRateAreaChart({
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

	const { error: color } = usePlotColors(ERROR_RATE_TOKENS)
	const chromeColors = usePlotChromeColors()

	const tooltipSeries = useMemo<TooltipSeriesSpec<OverviewBenchRow>[]>(
		() => [
			{
				label: "Error Rate",
				color,
				value: (row: OverviewBenchRow) => row.errorRate,
				format: formatErrorRate,
			},
		],
		[color],
	)

	const { probe, anchor: tooltipAnchor } = useMemo(() => createTooltipFocusProbe<OverviewBenchRow>(), [])

	const definition = useMemo(() => {
		const dataMax = overviewBenchRows.reduce((max, row) => Math.max(max, row.errorRate), 0)
		const yMax = Math.min(1, Math.max(dataMax * 1.2, 0.01))

		return defineChart({
			gradients: [verticalGradient(GRADIENT_ID, color)],
			marks: [
				areaY(overviewBenchRows, {
					id: "errorRateArea",
					x: (d: OverviewBenchRow) => d.bucket,
					y: (d: OverviewBenchRow) => d.errorRate,
					fill: `url(#${GRADIENT_ID})`,
					stroke: "none",
				}),
				lineY(overviewBenchRows, {
					id: "errorRateLine",
					x: (d: OverviewBenchRow) => d.bucket,
					y: (d: OverviewBenchRow) => d.errorRate,
					stroke: color,
					strokeWidth: 2,
				}),
				focusDot(
					overviewBenchRows,
					(d: OverviewBenchRow) => d.bucket,
					(d: OverviewBenchRow) => d.errorRate,
					color,
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
				scale: scaleLinear().domain([0, yMax]),
				grid: true,
				axis: {
					line: false,
					ticks: { size: 0, padding: 6, format: (value: number) => formatErrorRate(value) },
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
		})
	}, [color, axisContext, tooltipAnchor, chromeColors])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Error rate"
			definition={definition}
			renderTooltipBody={({ points }) => (
				<TooltipBody
					points={points}
					series={tooltipSeries}
					probe={probe}
					heading={(row: OverviewBenchRow) => formatBucketLabel(row.bucket, axisContext, "tooltip")}
				/>
			)}
		/>
	)
})
