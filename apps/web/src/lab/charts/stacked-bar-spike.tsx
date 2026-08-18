import {
	MUTED_COLOR_AMOUNT,
	PlotFrame,
	PlotSeriesLegend,
	cursorTooltip,
	muteColor,
	usePlotChromeColors,
	usePlotColors,
	usePlotLegendHighlight,
	type PlotColorToken,
	type PlotLegendSeries,
} from "@maple/ui/components/plot"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import { barY, defineChart, stack } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { controlledSignal } from "@tanstack/charts/interaction/signal"
import { interactiveColorLegend } from "@tanstack/charts/legend"
import { memo, useMemo, useState, type ReactNode } from "react"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
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

/**
 * The partial bucket's outline. Open enough to read as dashes at a bar's width —
 * `"3 3"` around a ~20px rect reads as a shimmer rather than a dash.
 *
 * No round-cap correction needed here, unlike `lineY`: `barY` emits rect nodes,
 * which take the renderer's default butt cap.
 */
const PARTIAL_DASHARRAY = "4 4"

/** The outline colour. Module scope — `usePlotColors` memoizes on identity. */
const BAR_CHROME_TOKENS = {
	foreground: ["--foreground", "#fafafa"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

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
	const colorFor = useServiceColor()
	return (
		<StackedBarFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			colorFor={colorFor}
		/>
	)
})

/** Service → themed colour. Shared by all three variants in this file. */
function useServiceColor(): (service: string) => string {
	const colors = usePlotColors(STACK_TOKENS)
	return useMemo(
		() =>
			(service: string): string =>
				colors[service as keyof typeof colors] ?? colors.api,
		[colors],
	)
}

/**
 * The figure itself, over whatever rows it is handed.
 *
 * Note it takes no notion of emphasis. It does not need one: every service is
 * painted through `colorFor`, so the legend variant below highlights by handing
 * down a `colorFor` that already returns muted colours — no extra prop, no extra
 * branch here. That works because `barY.fill` is a `VisualChannel` while
 * `fillOpacity` is a flat `number`, which is the same reason the muting has to be
 * a colour in the first place.
 */
function StackedBarFigure({
	rows,
	renderer,
	incomplete,
	className,
	colorFor,
	legend,
}: {
	rows: readonly StackedBarSpikeRow[]
	renderer: TanstackRenderer
	incomplete: boolean
	className?: string
	colorFor: (service: string) => string
	legend?: ReactNode
}) {
	const chrome = usePlotColors(BAR_CHROME_TOKENS)
	const axisContext = useMemo(() => stackedBarAxisContext(rows), [rows])

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
						incomplete && d.partial ? chrome.foreground : "transparent",
					strokeDasharray: (d: StackedBarSpikeRow) =>
						incomplete && d.partial ? PARTIAL_DASHARRAY : SOLID_DASHARRAY,
					strokeWidth: 1.5,
					// Fully opaque, always. Fading the partial bars to 0.9 made them
					// quieter than the complete ones, which is backwards: a bucket that is
					// still filling is the most recent data on the chart and the part the
					// reader is most likely to be looking for. The dashed outline is what
					// says "provisional" — and it can only do that in a colour the fill is
					// not, which is why it is `--foreground` rather than the series colour
					// it used to be (same-on-same read as no outline at all).
					fillOpacity: 1,
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
			tooltip: cursorTooltip("pointer"),
		})
	}, [rows, byBucket, colorFor, incomplete, axisContext, chrome])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Spans by service"
			definition={definition}
			legend={legend}
			// `PlotTooltipBody` reads every series off `points[0].datum`, which works when
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
}

/**
 * The same chart with a DOM series key beneath it — the sibling-variant shape
 * `line-spike.tsx` explains.
 *
 * Compare `StackedBarSceneLegendSpike` below: this is the only chart in the lab
 * where both legends are reachable, so it is the only place the DOM legend's cost
 * can be priced against the package's own.
 */
export const StackedBarLegendSpike = memo(function StackedBarLegendSpike({
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
	const colorFor = useServiceColor()

	const legendSeries = useMemo<PlotLegendSeries[]>(
		() =>
			STACKED_BAR_SERVICES.map((service) => ({
				key: service,
				label: service,
				color: colorFor(service),
			})),
		[colorFor],
	)
	const { highlighted, highlight } = usePlotLegendHighlight()
	const chromeColors = usePlotChromeColors()

	// The whole highlight, expressed as a colour lookup: every row still draws and
	// the stack keeps its geometry, so the axis never moves.
	const emphasisedColorFor = useMemo(() => {
		if (highlighted === null) return colorFor
		return (service: string) =>
			service === highlighted
				? colorFor(service)
				: muteColor(colorFor(service), chromeColors.background, MUTED_COLOR_AMOUNT)
	}, [colorFor, highlighted, chromeColors])

	return (
		<StackedBarFigure
			rows={rows}
			renderer={renderer}
			incomplete={incomplete}
			className={className}
			colorFor={emphasisedColorFor}
			legend={
				<PlotSeriesLegend
					series={legendSeries}
					highlighted={highlighted}
					onHighlight={highlight}
					label="Spans by service"
				/>
			}
		/>
	)
})

/**
 * The same chart drawn with the PACKAGE's legend rather than a DOM one, for
 * comparison.
 *
 * This is the only spike in the lab where that comparison is available, and the
 * reason is structural. `interactiveColorLegend` hangs off `ChartColorOptions.legend`,
 * which only exists once the chart declares a `color:` scale — so a mark has to
 * take its fill FROM that scale rather than from a literal. `barY` has a `color`
 * channel and this chart already groups by service, so the change is
 * `fill: (d) => colorFor(d.service)` → `color: (d) => d.service` plus a
 * chart-level domain/range. Line and area have no such channel to move to: they
 * are one mark per series with a literal `stroke`, which is Recharts' idiom and
 * the shape most of these spikes deliberately preserve. Pie cannot get there at
 * all (`radialArc` reads no scale). See FINDINGS.md.
 *
 * What it costs relative to `StackedBarLegendSpike`: no Tailwind, no `right`
 * layout (`ChartLegendPlacement` is `'top' | 'bottom'`), no stats columns, and no
 * shared styling with the tooltip — it is a `SceneNode` the renderer paints.
 * What it buys: zero DOM and no React commit on toggle beyond the state itself.
 *
 * **And on a STACK it punches a hole rather than restacking**, which is the
 * finding this arm exists to show. `filterMark` runs on the resolved scene, after
 * `stackValues` has already assigned every segment its y1/y2 — so hiding the
 * bottom band deletes its rects and leaves the survivors floating at their
 * original offsets, with a gap along the baseline. There is no hook between the
 * layout and the filter to re-run the stack. `StackedBarLegendSpike` filters
 * ROWS, before the layout, which is why it restacks correctly and this cannot.
 * The y domain below is deliberately pinned to the FULL total for the same
 * reason: the picture still occupies its original height, so a domain derived
 * from the visible services would clip the top off it.
 */
export const StackedBarSceneLegendSpike = memo(function StackedBarSceneLegendSpike({
	rows,
	renderer,
	className,
}: {
	rows: readonly StackedBarSpikeRow[]
	renderer: TanstackRenderer
	className?: string
}) {
	const colorFor = useServiceColor()
	const axisContext = useMemo(() => stackedBarAxisContext(rows), [rows])

	// `controlledSignal` is explicitly "application-owned state described to the
	// chart" — it creates no store of its own, so the visible set is plain React
	// state here exactly as the DOM legend's hidden set is.
	const [visibleServices, setVisibleServices] = useState<readonly string[]>(() => [...STACKED_BAR_SERVICES])

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
		// Over EVERY service, hidden ones included — see the note on the component.
		// The scene filter removes rects but not the offsets they were stacked at, so
		// the drawing keeps its full height no matter what is hidden, and a domain
		// over the visible subset would crop it.
		const stackMax =
			buckets.reduce((max, bucket) => {
				const total = (byBucket.get(bucket) ?? []).reduce((sum, row) => sum + row.spans, 0)
				return Math.max(max, total)
			}, 0) || 1

		return defineChart({
			marks: [
				barY(rows, {
					x: (d: StackedBarSpikeRow) => d.bucket,
					y: (d: StackedBarSpikeRow) => d.spans,
					// `color`, and NO `z` — this is the whole difference from
					// `StackedBarFigure`, and getting it wrong is silent.
					//
					// `barY` derives its series from `color` only when `z` is absent
					// (`dist/bar.js:27`), and sets `seriesFromColor` only when `z` is
					// absent AND the layout is grouped or the x positions repeat
					// (`dist/bar.js:50`). `interactiveColorLegend`'s `filterMark` is a
					// no-op unless `seriesFromColor` is true. Declaring both `z` and
					// `color` — the obvious reading, since `z` is what the sibling
					// variant uses — therefore produces a legend that renders, toggles,
					// and removes nothing: the hidden segments keep painting while the
					// y domain drops out from under them.
					color: (d: StackedBarSpikeRow) => d.service,
					// Still correct with no `z`: the stack groups by whatever
					// `seriesValues` resolved to, which is now the colour channel.
					layout: stack({ order: STACKED_BAR_SERVICES }),
					inset: 0.5,
					radius: 0,
					states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
				}),
			],
			color: {
				domain: STACKED_BAR_SERVICES,
				range: STACKED_BAR_SERVICES.map(colorFor),
				legend: interactiveColorLegend({
					visible: controlledSignal(visibleServices, (next) => setVisibleServices(next)),
					placement: "bottom",
					ariaLabel: "Spans by service",
				}),
			},
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
			focus: "nearest",
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		})
	}, [rows, byBucket, colorFor, axisContext, visibleServices])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Spans by service"
			definition={definition}
			renderTooltipBody={({ points }) => {
				const datum = points[0]?.datum
				if (!datum) return null
				return (
					<div className="flex items-center gap-2">
						<span
							className="size-2.5 shrink-0 rounded-[2px]"
							style={{ backgroundColor: colorFor(datum.service) }}
						/>
						<span className="text-muted-foreground">{datum.service}</span>
						<span className="font-mono font-semibold text-foreground tabular-nums">
							{formatNumber(datum.spans)}
						</span>
					</div>
				)
			}}
		/>
	)
})
