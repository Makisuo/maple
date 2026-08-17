import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatNumber } from "@maple/ui/lib/format"
import { cell, defineChart } from "@tanstack/charts"
import { colorGradientLegend } from "@tanstack/charts/legend"
import { tooltip } from "@tanstack/charts/tooltip"
import { scaleBand } from "@tanstack/charts-scales/band"
import { memo, useMemo } from "react"

import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
import {
	createSequentialColorScale,
	HEATMAP_RAMP_TOKENS,
	rampStops,
	type SequentialScaleType,
} from "@/lab/charts/color-scale"

/**
 * No index signature — same trap as `PieSpikeRow`. `cell`'s channel type is
 * `Channel<TDatum, …> = ChannelField<TDatum, …> | ChannelAccessor<…>`, and
 * `ChannelField` maps over `keyof TDatum` testing `TDatum[TKey] extends TValue`;
 * an index signature widens `keyof` to `string | number` and every named field
 * resolves to `unknown`, so no string channel typechecks. Accessors are used
 * throughout below for the same reason.
 */
export interface HeatmapSpikeRow {
	x: string
	y: string
	value: number
}

/**
 * The hover ring's colour. Module scope, as everywhere else in this lab:
 * `usePlotColors` memoizes on the token object's identity, so a fresh literal
 * per render would re-read computed style on every frame.
 */
const HEATMAP_CHROME_TOKENS = {
	foreground: ["--foreground", "#fafafa"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** Preserve first-appearance order — a `Set` over the rows, not a sort. */
function uniqueInOrder(values: readonly string[]): string[] {
	return [...new Set(values)]
}

/**
 * Phase 0 spike: can `cell` over two band scales plus a sequential colour scale
 * replace `query-builder-heatmap-chart.tsx` (925 lines of hand-rolled CSS grid,
 * two-pass layout solver, own colour interpolation, own log normalize/invert, own
 * tick selection, and arithmetic hit-testing)?
 *
 * Answer: the *rendering* half, yes, and at a fraction of the code. Four things
 * are worth knowing before anyone ports the production chart.
 *
 * 1. **`cell` has no `fill` channel.** `RectOptions.fill` is `fill?: string` — a
 *    single flat colour, not a `VisualChannel`. Per-cell colour has exactly one
 *    route: the `color` channel plus a chart-level colour scale. That makes the
 *    colour-scale question (see `color-scale.ts`) load-bearing rather than
 *    optional, which is not true of `hexagon`, whose `fill` *is* a channel.
 * 2. **Holes come free, and only because both band domains are pinned.** A `{x,y}`
 *    pair with no row emits no cell, so the chart background shows through — which
 *    is the required distinction from a minimum-value cell. But band domains are
 *    otherwise inferred from the observed channel values, so an entirely empty
 *    column or row would silently vanish from the axis instead of rendering as a
 *    gap. The pinned `scaleBand(domain, range)` instances below are what makes a
 *    hole a hole.
 * 3. **`colorGradientLegend` works** — it needs `colors.domain` to be numeric
 *    `[min, max]` and calls `colors.map(value)` per step, both of which d3's
 *    `scaleSequential` satisfies (and `colorScaleKind` classifies it
 *    `"continuous"` — see `color-scale.ts`). One honest caveat: it walks the domain
 *    *linearly* and samples the ramp at each value, so under `scaleType="log"` the
 *    bar shows the log-warped ramp against a linear value axis. That is correct
 *    (each swatch really is that value's colour) but it is not the production
 *    legend, which instead labels evenly-spaced *swatches* with their inverted
 *    values via `valueAtT`. There is no hook to supply tick positions.
 * 4. **Scale factory vs instance.** `scaleBand` (the factory) infers; `scaleBand()`
 *    (an instance) keeps its empty configured domain and renders nothing at all.
 *    Instances are passed here *because* the domain is being pinned deliberately.
 */
export const HeatmapSpike = memo(function HeatmapSpike({
	rows,
	renderer,
	scaleType = "linear",
	className,
}: {
	rows: readonly HeatmapSpikeRow[]
	renderer: TanstackRenderer
	scaleType?: SequentialScaleType
	className?: string
}) {
	const colors = usePlotColors(HEATMAP_RAMP_TOKENS)
	const chrome = usePlotColors(HEATMAP_CHROME_TOKENS)

	const model = useMemo(() => {
		const xDomain = uniqueInOrder(rows.map((row) => row.x))
		// Band y maps `domain[0]` to the top of the plot (`configured-scale.js`
		// normalizes the y range to ascending for categorical scales), so
		// first-appearance order reads top-to-bottom, matching the original grid.
		const yDomain = uniqueInOrder(rows.map((row) => row.y))

		let min = Number.POSITIVE_INFINITY
		let max = Number.NEGATIVE_INFINITY
		for (const row of rows) {
			if (!Number.isFinite(row.value)) continue
			min = Math.min(min, row.value)
			max = Math.max(max, row.value)
		}
		if (!Number.isFinite(min) || !Number.isFinite(max)) {
			min = 0
			max = 1
		}
		if (min === max) max = min + 1

		return { xDomain, yDomain, domain: [min, max] as const }
	}, [rows])

	const colorScale = useMemo(
		() =>
			createSequentialColorScale({
				stops: rampStops(colors),
				domain: model.domain,
				scaleType,
			}),
		[colors, model.domain, scaleType],
	)

	const definition = useMemo(() => {
		return defineChart({
			marks: [
				cell(rows, {
					x: (row: HeatmapSpikeRow) => row.x,
					y: (row: HeatmapSpikeRow) => row.y,
					// The ONLY per-datum colour route on a rect mark; `fill` is a
					// flat string. `ChartKey` is `string | number`, so a raw count
					// passes straight through to the colour scale.
					color: (row: HeatmapSpikeRow) => row.value,
					inset: 1,
					radius: 3,
					// `when` is a SELECTOR OBJECT, not a state name — `when: "focused"`
					// is the obvious guess and does not typecheck. `rect`/`cell` do
					// carry `states` (unlike every polar mark and `hexagon`), so a
					// heatmap can have a real hover affordance.
					//
					// Two things this deliberately does NOT do, both of which it used to:
					//
					// - `stroke: "currentColor"`. It resolves on SVG by inheritance and
					//   resolves to nothing on canvas, so the affordance silently differed
					//   between renderers. Every colour in these specs has to be a
					//   literal; that is the whole reason `usePlotColors` exists.
					// - `inset: 0`. The base inset is 1, so dropping it on hover grew the
					//   cell by a pixel on every side — the ring arrived with a visible
					//   size jump, which reads as the grid twitching rather than as
					//   feedback. Ring only, geometry fixed.
					states: [
						{
							when: { focus: "primary" },
							style: {
								stroke: chrome.foreground,
								strokeWidth: 1.5,
								// Production draws `0 0 0 1.5px var(--foreground)` OUTSIDE the
								// cell (heatmap chart:737). A stroke is centred on the edge, so
								// half of it lands on the data; pulling the opacity back keeps
								// the same read without whiting out the cell it is marking.
								strokeOpacity: 0.55,
							},
						},
					],
				}),
			],
			x: {
				// Pinned instance: an inferred domain would drop a fully-empty
				// column, turning a hole into a missing axis slot.
				scale: scaleBand<string>(model.xDomain, [0, 1]).paddingInner(0.06),
				grid: false,
			},
			y: {
				scale: scaleBand<string>(model.yDomain, [0, 1]).paddingInner(0.06),
				grid: false,
			},
			color: {
				scale: colorScale,
				legend: colorGradientLegend({
					label: "Count",
					placement: "bottom",
					format: (value) => formatNumber(Math.round(value)),
				}),
			},
			focus: "nearest",
			focusRing: false,
			tooltip: { use: tooltip, className: "maple-bench-tooltip" },
		})
	}, [rows, model, colorScale, chrome])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Request count by hour and latency bucket"
			definition={definition}
			// The default body prints the raw x/y channels — here the two band
			// labels and nothing else, so the actual count would never appear.
			renderTooltipBody={({ points }) => {
				const point = points[0]?.datum
				if (!point) return null
				return (
					<div className="flex items-center gap-2">
						<span
							className="size-2.5 shrink-0 rounded-[2px]"
							style={{ backgroundColor: colorScale(point.value) }}
						/>
						<span className="text-muted-foreground">
							{point.x} · {point.y}
						</span>
						<span className="font-mono font-semibold tabular-nums">
							{formatNumber(point.value)}
						</span>
					</div>
				)
			}}
		/>
	)
})
