import { areaY, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleTime } from "d3-scale"
import * as React from "react"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	focusCrosshair,
	focusDot,
	usePlotChromeColors,
	usePlotColors,
	useChartId,
	verticalGradient,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"
import { formatBucketLabel } from "@maple/ui/lib/format"

interface TimeseriesPoint {
	bucket: string
	count: number
}

interface IssueOccurrenceSparklineProps {
	data: ReadonlyArray<TimeseriesPoint>
	className?: string
}

/** Module scope — `usePlotColors` memoises on identity and reads computed style. */
const COLOR_TOKENS = { primary: ["--primary", "#6366f1"] } as const

/** One point with its bucket parsed, so the time scale has a Date to place. */
interface OccurrencePoint extends TimeseriesPoint {
	date: Date
}

const STROKE_WIDTH = 1.5

export function IssueOccurrenceSparkline({ data, className }: IssueOccurrenceSparklineProps) {
	const colors = usePlotColors(COLOR_TOKENS)
	const chromeColors = usePlotChromeColors()
	const gradientId = useChartId("occurrences")
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])

	const sorted = React.useMemo<OccurrencePoint[]>(() => {
		return (
			data
				.map((point) => ({ bucket: point.bucket, count: point.count, date: new Date(point.bucket) }))
				// A point with an unparseable bucket has no position on a time axis.
				.filter((point) => Number.isFinite(point.date.getTime()))
				.sort((a, b) => a.date.getTime() - b.date.getTime())
		)
	}, [data])

	const axisContext = React.useMemo(() => {
		if (sorted.length < 2) {
			return { rangeMs: 0, bucketSeconds: undefined }
		}
		const firstMs = sorted[0]!.date.getTime()
		const secondMs = sorted[1]!.date.getTime()
		const lastMs = sorted[sorted.length - 1]!.date.getTime()
		const diffMs = secondMs - firstMs
		return {
			rangeMs: lastMs - firstMs,
			bucketSeconds: diffMs > 0 ? diffMs / 1000 : undefined,
		}
	}, [sorted])

	const tooltipSeries = React.useMemo<PlotTooltipSeries<OccurrencePoint>[]>(
		() => [
			{
				label: "Occurrences",
				color: colors.primary,
				value: (point: OccurrencePoint) => point.count,
				format: (value: number) => value.toLocaleString(),
			},
		],
		[colors.primary],
	)

	const definition = React.useMemo(() => {
		const at = (point: OccurrencePoint) => point.date
		const value = (point: OccurrencePoint) => point.count

		return defineChart({
			gradients: [verticalGradient(gradientId, colors.primary, 0.35, 0.03)],
			marks: [
				areaY(sorted, {
					x: at,
					y: value,
					// The Recharts original pinned `domain={[0, "dataMax"]}`; an explicit
					// floor is what carries that over — the band fills from zero rather
					// than from the smallest count in the window.
					y1: () => 0,
					fill: `url(#${gradientId})`,
					stroke: "none",
				}),
				lineY(sorted, { x: at, y: value, stroke: colors.primary, strokeWidth: STROKE_WIDTH }),
				focusDot(sorted, at, value, colors.primary, chromeColors),
				focusCrosshair(chromeColors),
			],
			// Both axes hidden, as `hide` did — the sparkline is read against the
			// numbers printed beside it, not off a scale.
			x: { scale: scaleTime, axis: false },
			y: { scale: scaleLinear, axis: false },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
			margin: { top: 4, right: 0, bottom: 0, left: 0 },
		})
	}, [sorted, colors.primary, chromeColors, gradientId, focusStore])

	if (sorted.length === 0) {
		return (
			<div
				className={cn(
					"flex h-20 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground",
					className,
				)}
			>
				No activity in window
			</div>
		)
	}

	return (
		<PlotFrame
			definition={definition}
			ariaLabel="Occurrences over time"
			className={cn("h-20 w-full", className)}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={focusStore}
					heading={(point: OccurrencePoint) =>
						formatBucketLabel(point.bucket, axisContext, "tooltip")
					}
				/>
			)}
		/>
	)
}
