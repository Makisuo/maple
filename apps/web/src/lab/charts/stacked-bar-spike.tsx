import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import { barY, defineChart, stack } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo } from "react"

import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
import {
	STACKED_BAR_SERVICES,
	stackedBarAxisContext,
	type StackedBarSpikeRow,
} from "@/lab/charts/timeseries-data"

/**
 * `--chart-1..5` are the five that exist; the service list is capped at five for
 * the same reason (`treemap-spike.tsx` has to wrap past the fifth).
 */
const STACK_TOKENS = {
	api: ["--chart-1", "#6366f1"],
	web: ["--chart-2", "#22c55e"],
	ingest: ["--chart-3", "#f59e0b"],
	worker: ["--chart-4", "#ec4899"],
	db: ["--chart-5", "#06b6d4"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** Secondary dash weight, as on every non-primary overlay in the production charts. */
const PARTIAL_DASHARRAY = "3 3"

/** SVG's "no dashes" — an empty string is not a valid `stroke-dasharray`. */
const SOLID_DASHARRAY = "0"

/**
 * Spans per service per bucket, replacing
 * `packages/ui/src/components/charts/bar/query-builder-bar-chart.tsx` in its
 * `stacked` configuration.
 *
 * Two things are structurally different from the Recharts arm:
 *
 * 1. **One mark, not one per series.** Recharts needs a `<Bar dataKey>` per
 *    service over wide rows; TanStack stacks through the `z` channel over long
 *    rows, so adding a service is a data change and not a JSX change.
 * 2. **`incomplete` costs one channel.** `barY.strokeDasharray` is a per-datum
 *    `VisualChannel`, so the buckets that are still filling get a dashed outline
 *    inline. Recharts has no equivalent: `query-builder-bar-chart.tsx` never
 *    calls `useIncompleteSegments` at all, and the area chart that does needs a
 *    second `stackId` (`query-builder-area-chart.tsx:421-443`) to reproduce the
 *    stack geometry for its dashed twin. This is the one place in the pilot where
 *    TanStack is strictly more capable rather than differently shaped.
 */
export const StackedBarSpike = memo(function StackedBarSpike({
	rows,
	renderer,
	incomplete = false,
	className,
}: {
	rows: readonly StackedBarSpikeRow[]
	renderer: TanstackRenderer
	incomplete?: boolean
	className?: string
}) {
	const colors = usePlotColors(STACK_TOKENS)

	const axisContext = useMemo(() => stackedBarAxisContext(rows), [rows])

	const colorFor = useMemo(
		() =>
			(service: string): string =>
				colors[service as keyof typeof colors] ?? colors.api,
		[colors],
	)

	/** Every service in one bucket, for the tooltip — a datum is a single cell. */
	const byBucket = useMemo(() => {
		const map = new Map<string, StackedBarSpikeRow[]>()
		for (const row of rows) {
			const existing = map.get(row.bucket)
			if (existing) existing.push(row)
			else map.set(row.bucket, [row])
		}
		return map
	}, [rows])

	const definition = useMemo(() => {
		const buckets = [...byBucket.keys()]
		// The stack layout computes y1/y2, but the axis domain still has to be
		// pinned: an inferred linear domain starts at the data minimum, and the data
		// here is per-cell, so it would end well below the tallest stack.
		const stackMax = buckets.reduce((max, bucket) => {
			const total = (byBucket.get(bucket) ?? []).reduce((sum, row) => sum + row.spans, 0)
			return Math.max(max, total)
		}, 0)

		return defineChart({
			marks: [
				barY(rows, {
					x: (d: StackedBarSpikeRow) => d.bucket,
					y: (d: StackedBarSpikeRow) => d.spans,
					// The series channel. Ordering the stack explicitly keeps the bands in
					// legend order instead of first-seen order.
					z: (d: StackedBarSpikeRow) => d.service,
					fill: (d: StackedBarSpikeRow) => colorFor(d.service),
					layout: stack({ order: STACKED_BAR_SERVICES }),
					inset: 0.5,
					// Square, and it has to be. A stack should round only the outer two
					// corners of the whole column and leave the interior seams flat, but
					// `radius` is a flat `number` handed straight to one rect node per
					// SEGMENT (`dist/bar.js:142`) and the renderer's `beginRoundedRect`
					// applies it to all four corners (`dist/canvas.js:637`). There is no
					// per-corner or per-stack-position form, so the only choices are
					// "every segment rounded" — which puts a rounded notch at each seam —
					// or none. None is correct.
					radius: 0,
					// Always channels, never a conditional spread: `barY`'s `const TOptions`
					// inference is what carries the x channel's type through to the chart,
					// and building the options object separately erases it.
					stroke: (d: StackedBarSpikeRow) =>
						incomplete && d.partial ? colorFor(d.service) : "transparent",
					strokeDasharray: (d: StackedBarSpikeRow) =>
						incomplete && d.partial ? PARTIAL_DASHARRAY : SOLID_DASHARRAY,
					fillOpacity: incomplete ? 0.9 : 1,
					states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
				}),
			],
			x: {
				scale: scaleBand<string>(buckets, [0, 1]).paddingInner(0.2),
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
				scale: scaleLinear().domain([0, stackMax]),
				nice: true,
				grid: true,
				axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
			},
			// One bar segment is one datum, so nearest is the right semantic; the
			// tooltip widens back out to the whole bucket itself.
			focus: "nearest",
			focusRing: false,
			tooltip: {
				use: tooltip,
				className: "maple-bench-tooltip",
				anchor: "pointer",
				placement: "right",
				offset: 12,
			},
		})
	}, [rows, byBucket, colorFor, incomplete, axisContext])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Spans by service"
			definition={definition}
			// `TooltipBody` reads every series off `points[0].datum`, which works when
			// a datum is a whole bucket. Here it is one cell, so the bucket's other
			// services have to be looked up rather than read.
			renderTooltipBody={({ points }) => {
				const datum = points[0]?.datum
				if (!datum) return null
				const bucketRows = byBucket.get(datum.bucket) ?? []
				const total = bucketRows.reduce((sum, row) => sum + row.spans, 0)
				return (
					<div className="grid min-w-[9rem] items-start gap-1.5">
						<div className="border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight">
							{formatBucketLabel(datum.bucket, axisContext, "tooltip")}
							{datum.partial ? " · partial" : ""}
						</div>
						<div className="grid gap-1.5">
							{bucketRows.map((row) => (
								<div
									key={row.service}
									className={
										row.service === datum.service
											? "flex w-full items-center gap-2 [&_*]:font-semibold"
											: "flex w-full items-center gap-2"
									}
								>
									<span
										className={
											row.partial
												? "size-2.5 shrink-0 rounded-[2px] border border-dashed"
												: "size-2.5 shrink-0 rounded-[2px]"
										}
										style={
											row.partial
												? { borderColor: colorFor(row.service) }
												: { backgroundColor: colorFor(row.service) }
										}
									/>
									<div className="flex flex-1 items-center justify-between gap-3 leading-none">
										<span className="text-muted-foreground">{row.service}</span>
										<span className="font-mono font-semibold text-foreground tabular-nums">
											{formatNumber(row.spans)}
										</span>
									</div>
								</div>
							))}
						</div>
						<div className="flex w-full items-center justify-between gap-3 border-border/50 border-t pt-1 leading-none">
							<span className="text-muted-foreground">Total</span>
							<span className="font-mono font-semibold text-foreground tabular-nums">
								{formatNumber(total)}
							</span>
						</div>
					</div>
				)
			}}
		/>
	)
})
