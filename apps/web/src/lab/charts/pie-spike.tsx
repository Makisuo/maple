import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { defineChart } from "@tanstack/charts"
import { focusGroupAngle, pie, polar, radialArc } from "@tanstack/charts/polar"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, useState, type ReactNode } from "react"

import {
	ChartStatsLegend,
	MUTED_COLOR_AMOUNT,
	useChartLegendHighlight,
	type LegendSeriesSpec,
} from "@/lab/bench/tanstack/chart-legend"
import { usePlotChromeColors } from "@/lab/bench/tanstack/chart-shared"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
import { muteColor } from "@/lab/charts/color-scale"

/**
 * No index signature. `pie()` returns `Omit<TDatum, PieDerivedField> & …`, and
 * `Omit` over a type with an index signature resolves `keyof` to `string | number`
 * and drops every named field — so `slice.name` would come back `unknown`.
 * Normalize rows into this shape at the boundary instead.
 */
export interface PieSpikeRow {
	name: string
	value: number
}

const SLICE_TOKENS = {
	c1: ["--chart-1", "#6366f1"],
	c2: ["--chart-2", "#ec4899"],
	c3: ["--chart-3", "#f59e0b"],
	c4: ["--chart-4", "#10b981"],
	c5: ["--chart-5", "#3b82f6"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * How much the hovered slice grows, and how far the rest fade — both lifted from
 * `packages/ui/src/components/charts/pie/query-builder-pie-chart.tsx` so the two
 * donuts feel identical side by side.
 */
const HOVER_GROWTH = 1.035
const REST_OPACITY = 0.55

/**
 * Phase 0 spike: does `polar` + `pie` + `radialArc` actually draw a donut under
 * both renderers, and what is lost to `radialArc` having no `states`?
 *
 * **Correction to an earlier note in this file.** It said the production pie's
 * hover affordance — dim the others to 0.55, scale the hovered slice to 1.035 —
 * "has no expression at 0.14.0 by any route". That was wrong, and wrong in an
 * instructive way: it took "no `states` on the mark" to mean "no hover", and only
 * looked for the answer inside the chart definition.
 *
 * What is true: `radialArc`'s `fill` is a `VisualChannel` with no focus context,
 * `outerRadius` is a per-MARK `PolarLength` and `fillOpacity` a flat `number`, so
 * nothing about one datum can differ from another's on hover WITHIN a mark. And
 * `whenFocused` really does not typecheck here — it takes a `ChartMark` while
 * `polar({ marks })` requires a `PolarMark`.
 *
 * The route out is above the definition, not inside it: `onFocusChange` on the
 * Chart component reports the focused datum to React, and a second `radialArc`
 * over just that slice gives it its own radius and opacity. Per-mark options stop
 * being a limitation once the mark list is a function of hover state. It costs a
 * rebuilt definition per slice crossing, which is affordable precisely because
 * `onFocusChange` is edge-triggered rather than per-pointer-move. See
 * `PieLegendSpike`, which is where the wiring lives.
 *
 * In-slice labels are still out of scope: `radialText`'s `radius` is a channel in
 * radius-scale units, and this chart defines no radius scale, so how a label
 * position maps is a separate question from whether arcs paint.
 */
export const PieSpike = memo(function PieSpike({
	rows,
	renderer,
	donut = true,
	className,
}: {
	rows: readonly PieSpikeRow[]
	renderer: TanstackRenderer
	donut?: boolean
	className?: string
}) {
	const colorFor = useSliceColor(rows)
	return (
		<PieFigure rows={rows} renderer={renderer} donut={donut} className={className} colorFor={colorFor} />
	)
})

/**
 * Slice name → themed colour, keyed by the row's position in the FULL list.
 *
 * Not `palette[slice.index % palette.length]`, which is what this spike used to
 * do: `slice.index` is an index into whatever rows `pie()` was handed, so hiding
 * one slice would renumber every slice after it and recolour the chart. A legend
 * that repaints the series it did not touch is worse than no legend.
 */
function useSliceColor(rows: readonly PieSpikeRow[]): (name: string) => string {
	const colors = usePlotColors(SLICE_TOKENS)

	return useMemo(() => {
		const palette = [colors.c1, colors.c2, colors.c3, colors.c4, colors.c5]
		const order = new Map<string, number>()
		for (const row of rows) {
			if (!order.has(row.name)) order.set(row.name, order.size)
		}
		return (name: string) => palette[(order.get(name) ?? 0) % palette.length] ?? palette[0]
	}, [rows, colors])
}

function PieFigure({
	rows,
	renderer,
	donut,
	className,
	colorFor,
	activeName,
	onActiveNameChange,
	legend,
}: {
	rows: readonly PieSpikeRow[]
	renderer: TanstackRenderer
	donut: boolean
	className?: string
	colorFor: (name: string) => string
	/** The hovered slice, grown and left at full strength while the rest dim. */
	activeName?: string | null
	onActiveNameChange?: (name: string | null) => void
	legend?: ReactNode
}) {
	const definition = useMemo(() => {
		// `pie()` is an EAGER transform, not a mark: it returns rows carrying
		// startAngle/endAngle/angle/fraction, which radialArc then reads as plain
		// channels. Gaps are materialized into the interval, so radialArc must not
		// pad again (padAngle is forced to 0 on the output).
		const slices = pie(rows, { value: (row: PieSpikeRow) => row.value, gapAngle: 0.012 })

		// Split AFTER `pie()`, never before: the transform is what assigns the
		// angles, so slicing its OUTPUT keeps every wedge exactly where it was.
		// Splitting the rows first would renormalise the whole donut.
		const active = activeName === null ? [] : slices.filter((slice) => slice.name === activeName)
		const rest = activeName === null ? slices : slices.filter((slice) => slice.name !== activeName)

		const arcOptions = {
			startAngle: (slice: (typeof slices)[number]) => slice.startAngle,
			endAngle: (slice: (typeof slices)[number]) => slice.endAngle,
			innerRadius: (context: { radius: number }) => (donut ? Math.max(8, context.radius * 0.58) : 0),
			cornerRadius: 2,
		}

		return defineChart({
			marks: [
				polar({
					radiusRatio: 1,
					// Room for the hovered slice to grow into. `HOVER_GROWTH` of a ~110px
					// radius is ~4px, so 8px of inset covers it with margin — the arc is
					// clipped at the plot edge otherwise, and a clipped "grown" slice reads
					// as a rendering bug rather than an affordance.
					inset: 8,
					marks: [
						// Accessors, not `"startAngle"` field-name strings: `ChannelField`
						// resolves `TDatum[TKey] extends TValue`, and `PieSpikeRow`'s
						// index signature is `unknown`, so every string channel fails to
						// typecheck. Any row type with an index signature has to use
						// accessors — worth knowing before writing five more charts.
						//
						// TWO marks, not one, and that is the whole hover affordance:
						// `outerRadius` and `fillOpacity` are per-MARK (`PolarLength` and a
						// flat `number`), never per-datum, so the only way to give one slice
						// a different radius is to give it its own mark over a one-element
						// slice of the same transformed data.
						radialArc(rest, {
							...arcOptions,
							outerRadius: (context) => context.radius,
							fill: (slice) => colorFor(slice.name),
							// Production dims the un-hovered slices to 0.55
							// (`query-builder-pie-chart.tsx`); matched here.
							fillOpacity: activeName === null ? 1 : REST_OPACITY,
						}),
						radialArc(active, {
							...arcOptions,
							outerRadius: (context) => context.radius * HOVER_GROWTH,
							fill: (slice) => colorFor(slice.name),
						}),
					],
				}),
			],
			// No x/y axes exist in a polar chart; passing null keeps the cartesian
			// guides off rather than letting them infer an empty domain.
			x: null,
			y: null,
			// Cartesian `focus: "nearest"` does not engage on polar marks — no tooltip, no
			// focus state. `focusGroupAngle` is the polar-specific strategy.
			focus: focusGroupAngle,
			focusRing: false,
			tooltip: { use: tooltip, className: "maple-bench-tooltip" },
		})
	}, [rows, colorFor, donut, activeName])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Share by category"
			definition={definition}
			legend={legend}
			// EDGE-triggered, which is the only reason rebuilding the definition on
			// hover is affordable: it fires when the focused datum changes, not on
			// every pointer move, so crossing five slices costs five commits rather
			// than one per pixel.
			onFocusChange={
				onActiveNameChange ? (point) => onActiveNameChange(point?.datum.name ?? null) : undefined
			}
			// Mandatory, not cosmetic: the default body prints the mark's x/y
			// channels, which for a polar mark are the angle in radians and the
			// radius in pixels ("x 1.336 / y 113.76"). Every polar chart needs its
			// own body.
			renderTooltipBody={({ points }) => {
				const slice = points[0]?.datum
				if (!slice) return null
				return (
					<div className="flex items-center gap-2">
						<span
							className="size-2.5 shrink-0 rounded-[2px]"
							style={{ backgroundColor: colorFor(slice.name) }}
						/>
						<span className="text-muted-foreground">{slice.name}</span>
						<span className="font-mono font-semibold tabular-nums">
							{Math.round(slice.fraction * 1000) / 10}%
						</span>
					</div>
				)
			}}
		/>
	)
}

/**
 * The donut with a stats key BESIDE it and the production hover affordance, which
 * together make this the closest arm to `QueryBuilderPieChart` in the lab.
 *
 * Two interactions, deliberately different in kind:
 *
 * - **Hover** grows the slice under the cursor and fades the rest to 0.55, the
 *   same numbers production uses. Transient, driven by `onFocusChange`.
 * - **Clicking a legend row** pins an emphasis, muting the other slices' colours
 *   until it is clicked again. Persistent, and it survives moving the mouse away.
 *
 * Neither one removes a slice, and on this chart that matters more than anywhere
 * else in the lab: `pie()` divides by the total of the rows it is handed, so
 * dropping one would renormalise every remaining angle and rearrange the whole
 * donut around the slice the reader just picked.
 *
 * The legend is a `Column`, not the `Row` every other spike uses — production
 * renders `legend="right"` here, and a five-row stats table is taller than a
 * 320px card can spare from the plot.
 */
export const PieLegendSpike = memo(function PieLegendSpike({
	rows,
	renderer,
	donut = true,
	className,
}: {
	rows: readonly PieSpikeRow[]
	renderer: TanstackRenderer
	donut?: boolean
	className?: string
}) {
	const colorFor = useSliceColor(rows)

	const { highlighted, highlight } = useChartLegendHighlight()
	const [activeName, setActiveName] = useState<string | null>(null)
	const chromeColors = usePlotChromeColors()

	const legendSeries = useMemo<LegendSeriesSpec[]>(() => {
		const total = rows.reduce((sum, row) => sum + row.value, 0)
		return rows.map((row) => ({
			key: row.name,
			label: row.name,
			color: colorFor(row.name),
			// Formatted HERE, not in the legend: the legend has no idea this column
			// is a span count rather than a latency.
			value: formatNumber(row.value),
			secondary: total === 0 ? "—" : `${Math.round((row.value / total) * 1000) / 10}%`,
		}))
	}, [rows, colorFor])

	const emphasisedColorFor = useMemo(() => {
		if (highlighted === null) return colorFor
		return (name: string) =>
			name === highlighted
				? colorFor(name)
				: muteColor(colorFor(name), chromeColors.background, MUTED_COLOR_AMOUNT)
	}, [colorFor, highlighted, chromeColors])

	return (
		// The frame's own `legend` slot stacks BELOW the plot, which is the wrong
		// axis here — so this composes the side layout itself rather than teaching
		// the frame a placement option it would need for exactly one chart.
		<div className={cn("flex min-h-0 items-center gap-3", className)}>
			<PieFigure
				rows={rows}
				renderer={renderer}
				donut={donut}
				className="h-full min-w-0 flex-1"
				colorFor={emphasisedColorFor}
				activeName={activeName}
				onActiveNameChange={setActiveName}
			/>
			<div className="w-56 shrink-0 overflow-auto">
				<ChartStatsLegend
					series={legendSeries}
					highlighted={highlighted}
					onHighlight={highlight}
					label="Share by category"
				/>
			</div>
		</div>
	)
})
