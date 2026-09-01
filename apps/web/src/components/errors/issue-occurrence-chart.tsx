import { barY, defineChart } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import * as React from "react"

import type { IssueSeverity } from "@maple/domain/http"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	integerTickValues,
	linearYDomain,
	minBarLength,
	niceLinearDomain,
	usePlotColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"

// A type alias, not an interface: only an alias gets TypeScript's implicit index
// signature, which is what lets a row be read by key name — `linearYDomain` takes
// `Record<string, unknown>` rows.
type TimeseriesPoint = {
	bucket: string
	count: number
}

interface IssueOccurrenceChartProps {
	data: ReadonlyArray<TimeseriesPoint>
	/** Tints the plot to match the issue's severity chip and the list row's
	 *  `SignalSpark`. `null` keeps the neutral primary. */
	severity?: IssueSeverity | null
	className?: string
}

/**
 * Occurrences per bucket, as bars.
 *
 * Bars, not the gradient area this used to draw: the series is a count per
 * discrete bucket, and an area implies a continuous quantity sampled at those
 * points. The difference is not academic — the filled band interpolated straight
 * across a bucket with no errors, so silence read as steady traffic, which is
 * exactly the mistake `densifySpark` exists to stop the list row making. It also
 * puts the detail chart in the same visual language as `SignalSpark`, so a shape
 * you recognised in the queue is the same shape when you open it.
 *
 * Both axes are drawn now. Hidden axes were defensible while this was an 80px
 * sparkline read against numbers printed beside it; at panel size a chart with no
 * scale is decoration.
 */
const SEVERITY_COLOR_TOKENS = {
	critical: { bar: ["--destructive", "#ef4444"] },
	high: { bar: ["--color-orange-500", "#f97316"] },
	medium: { bar: ["--color-amber-500", "#f59e0b"] },
	low: { bar: ["--color-sky-500", "#0ea5e9"] },
	unset: { bar: ["--primary", "#6366f1"] },
} as const satisfies Record<IssueSeverity | "unset", { bar: readonly [string, string] }>

export function IssueOccurrenceChart({ data, severity = null, className }: IssueOccurrenceChartProps) {
	// Module-scope maps, indexed — `usePlotColors` memoises on the object's
	// identity and reads computed style, so a literal built from the prop would
	// re-read it every frame.
	const colors = usePlotColors(SEVERITY_COLOR_TOKENS[severity ?? "unset"])
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])

	const sorted = React.useMemo<TimeseriesPoint[]>(
		() =>
			[...data]
				// A point with an unparseable bucket has no position on the axis.
				.filter((point) => Number.isFinite(Date.parse(point.bucket)))
				.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket)),
		[data],
	)

	const axisContext = React.useMemo(() => {
		if (sorted.length < 2) return { rangeMs: 0, bucketSeconds: undefined }
		const firstMs = Date.parse(sorted[0]!.bucket)
		const secondMs = Date.parse(sorted[1]!.bucket)
		const lastMs = Date.parse(sorted[sorted.length - 1]!.bucket)
		const diffMs = secondMs - firstMs
		return {
			rangeMs: lastMs - firstMs,
			bucketSeconds: diffMs > 0 ? diffMs / 1000 : undefined,
		}
	}, [sorted])

	const tooltipSeries = React.useMemo<PlotTooltipSeries<TimeseriesPoint>[]>(
		() => [
			{
				label: "Occurrences",
				color: colors.bar,
				value: (point: TimeseriesPoint) => point.count,
				format: (value: number) => value.toLocaleString(),
			},
		],
		[colors.bar],
	)

	/**
	 * An EXPLICIT count domain, anchored at zero and rounded to the ticks drawn.
	 *
	 * The bare `scaleLinear` factory infers from the data extent, which is the one
	 * inference `plot-scales` exists to prevent — and an inferred domain has no
	 * span to take a minimum bar length from. Counts, so the ticks are whole.
	 */
	const yDomain = React.useMemo(
		() => niceLinearDomain(linearYDomain({ rows: sorted, keys: ["count"] })),
		[sorted],
	)
	// A single occurrence in an hour of quiet is the reading this chart exists to
	// show, and against a domain topping out in the thousands it paints as
	// nothing. See `minBarLength`.
	const liftCount = React.useMemo(() => minBarLength(yDomain), [yDomain])

	const definition = React.useMemo(
		() =>
			defineChart({
				marks: [
					dashedGridY(),
					barY(sorted, {
						x: (point: TimeseriesPoint) => point.bucket,
						y: (point: TimeseriesPoint) => liftCount(point.count),
						fill: colors.bar,
						radius: 2,
					}),
				],
				scales: {
					x: {
						scale: scalePoint,
						axis: {
							line: false,
							ticks: {
								size: 0,
								padding: 4,
								format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
							},
							tickLabels: { thin: { minGap: 12 } },
						},
					},
					y: {
						scale: scaleLinear().domain(yDomain),
						axis: {
							line: false,
							ticks: {
								size: 0,
								padding: 4,
								values: integerTickValues(yDomain),
								format: (value: number) => formatNumber(value),
							},
						},
					},
				},
				// Room for the axes to actually draw in. `bottom: 0` clipped the x tick
				// labels out of existence and cut the y axis's own "0" in half — the
				// plot area is the frame minus these, so an axis with no margin has
				// nowhere to put its labels.
				margin: { top: 8, right: 4, bottom: 22, left: 44 },
				focus: "group-x",
				focusRing: false,
				tooltip: cursorTooltip(focusStore.anchor),
			}),
		[sorted, colors.bar, axisContext, focusStore, yDomain, liftCount],
	)

	if (sorted.length === 0) {
		return (
			<div
				className={cn(
					"flex h-44 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground",
					className,
				)}
			>
				No activity in this window
			</div>
		)
	}

	return (
		<PlotFrame
			definition={definition}
			ariaLabel="Occurrences over time"
			className={cn("h-44 w-full", className)}
			renderTooltipBody={({ points }) => (
				<PlotTooltipBody
					points={points}
					series={tooltipSeries}
					focusStore={focusStore}
					heading={(point: TimeseriesPoint) =>
						formatBucketLabel(point.bucket, axisContext, "tooltip")
					}
				/>
			)}
		/>
	)
}
