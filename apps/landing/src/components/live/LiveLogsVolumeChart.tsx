import { useMemo } from "react"
import { barY, defineChart, stack } from "@tanstack/charts"
import { scaleLinear, scaleTime } from "d3-scale"
import { PlotFrame, dashedGridY, usePlotColors } from "@maple/ui/components/plot"

import {
	formatBucketTick,
	formatNumber,
	stubBuckets,
	totalCount,
	type LogBucket,
} from "./live-logs-volume-data"

/**
 * Module scope, not an inline literal: `usePlotColors` memoises on this object's
 * identity, and it reads computed style, so a fresh literal per render would
 * re-resolve every token on every frame.
 *
 * Fallbacks matter more here than in the app — the landing page renders before
 * its stylesheet has necessarily applied on a cold visit, and canvas holds
 * whatever literal it was handed.
 */
const SEVERITY_TOKENS = {
	DEBUG: ["--severity-debug", "#94a3b8"],
	INFO: ["--severity-info", "#38bdf8"],
	WARN: ["--severity-warn", "#f59e0b"],
	ERROR: ["--severity-error", "#ef4444"],
} as const satisfies Record<string, readonly [string, string]>

type Severity = keyof typeof SEVERITY_TOKENS

/** Bottom to top, matching the old `STACK_ORDER`. */
const STACK_ORDER: readonly Severity[] = ["DEBUG", "INFO", "WARN", "ERROR"]

const HEIGHT = 140

/** One bar segment: a bucket, a severity, and its count. */
interface SeverityCell {
	date: Date
	severity: Severity
	value: number
}

export default function LiveLogsVolumeChart() {
	const total = totalCount(stubBuckets)
	const colors = usePlotColors(SEVERITY_TOKENS)

	/**
	 * The stack is built from CELLS rather than from one mark per severity.
	 *
	 * Recharts took four `<Bar dataKey stackId>` children and stacked them by
	 * matching `stackId`; here a single `barY` carries every segment and `z` names
	 * which severity a cell belongs to, which is what `stack()` groups on.
	 */
	const cells = useMemo(
		() =>
			stubBuckets.flatMap((bucket: LogBucket) => {
				const date = new Date(bucket.bucket)
				return STACK_ORDER.map((severity) => ({ date, severity, value: bucket[severity] }))
			}),
		[],
	)

	/**
	 * The stacked ceiling, pinned rather than inferred.
	 *
	 * The interactive renderer infers a y domain from the data, but the PRERENDER
	 * path does not: `createChartScene` resolves scales through a resolver that
	 * throws `Chart scale "y" requires a configured scale` when `options.scale` is
	 * absent (`dist/scene.js:33-38`). The app never server-renders a chart, so
	 * only this one — inside Astro's static build — ever takes that path, and the
	 * chart is correct in a browser right up until the site is built.
	 *
	 * Summed per bucket, not a max over cells: the bars are stacked, so the tallest
	 * column is a bucket's TOTAL, and a max over individual segments would clip the
	 * stack.
	 */
	const yMax = useMemo(() => {
		const totals = new Map<number, number>()
		for (const cell of cells) {
			totals.set(cell.date.getTime(), (totals.get(cell.date.getTime()) ?? 0) + cell.value)
		}
		const peak = Math.max(0, ...totals.values())
		// An empty or all-zero series still needs a non-degenerate domain — a
		// `[0, 0]` scale maps every value to NaN.
		return peak > 0 ? peak : 1
	}, [cells])

	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					dashedGridY(),
					barY(cells, {
						x: (cell: SeverityCell) => cell.date,
						y: (cell: SeverityCell) => cell.value,
						z: (cell: SeverityCell) => cell.severity,
						fill: (cell: SeverityCell) => colors[cell.severity],
						radius: 0,
						// `order` pins the stack bottom-to-top. Without it the layout
						// orders by input, which is the same list today and would drift
						// the moment the cells are built differently.
						layout: stack({ order: [...STACK_ORDER] }),
					}),
				],
				scales: {
					x: {
						// A continuous time scale, as the app's bar chart uses — a band scale
						// over bucket strings puts ticks on arbitrary buckets rather than on
						// clock boundaries.
						scale: scaleTime,
						axis: {
							line: false,
							ticks: {
								size: 0,
								padding: 6,
								spacing: 50,
								format: (value: Date) => formatBucketTick(value.toISOString()),
							},
						},
					},
					y: {
						scale: scaleLinear().domain([0, yMax]),
						nice: true,
						axis: {
							line: false,
							ticks: { size: 0, padding: 4, format: (value: number) => formatNumber(value) },
						},
					},
				},
				// The landing chart is a still life: no hover, no tooltip, no focus ring.
				tooltip: false,
				focus: false,
			}),
		[cells, colors, yMax],
	)

	return (
		<div className="live-frame">
			<div className="live-frame__head">
				<span>logs · volume · last 5h</span>
				<span className="live-frame__live">
					<span className="live-frame__live-dot" />
					LIVE
				</span>
			</div>
			<div className="px-4 pt-3 pb-4">
				<div className="mb-2 flex items-baseline gap-2">
					<span className="text-fg text-sm font-medium tabular-nums">
						{formatNumber(total)} logs
					</span>
					<span className="text-fg-muted text-xs">in selected range</span>
				</div>
				{/*
				 * No width gate any more. The old chart could not render until
				 * `useContainerSize` reported a width, so it painted an empty box for at
				 * least one frame; `PlotFrame` omits `width` and lets the host follow its
				 * container, measuring itself before first paint.
				 */}
				<div className="w-full" style={{ height: HEIGHT }}>
					<PlotFrame
						definition={definition}
						ariaLabel="Log volume by severity"
						className="h-full"
					/>
				</div>
			</div>
			<div className="border-border bg-bg-elevated text-fg-muted flex justify-between border-t px-3.5 py-2.5 text-[10px] uppercase tracking-wider">
				<span>4 severities · 60 buckets · 5m each</span>
				<span>warn cluster 11:10–11:40 · error blip 11:50</span>
			</div>
		</div>
	)
}
