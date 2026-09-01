import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { formatBucketLabel, formatErrorRate, inferBucketSeconds, inferRangeMs } from "@maple/ui/lib/format"
import { memo, useMemo } from "react"

import { overviewBenchRows, type OverviewBenchRow } from "./bench-data"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	focusCrosshair,
	focusDot,
	useChartId,
	usePlotChromeColors,
	usePlotColors,
	verticalGradient,
	type PlotColorToken,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
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

	const tooltipSeries = useMemo<PlotTooltipSeries<OverviewBenchRow>[]>(
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

	const gradientId = useChartId("benchErrorRate")

	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const definition = useMemo(() => {
		const dataMax = overviewBenchRows.reduce((max, row) => Math.max(max, row.errorRate), 0)
		const yMax = Math.min(1, Math.max(dataMax * 1.2, 0.01))

		return defineChart({
			gradients: [verticalGradient(gradientId, color)],
			marks: [
				areaY(overviewBenchRows, {
					id: "errorRateArea",
					x: (d: OverviewBenchRow) => d.bucket,
					y: (d: OverviewBenchRow) => d.errorRate,
					fill: `url(#${gradientId})`,
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
			scales: {
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
			},
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [color, gradientId, axisContext, focusStore, chromeColors])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Error rate"
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
