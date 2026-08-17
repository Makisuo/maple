import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { defineChart } from "@tanstack/charts"
import { focusGroupAngle, pie, polar, radialArc } from "@tanstack/charts/polar"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, type ReactNode } from "react"

import {
	ChartSeriesLegend,
	useChartLegendState,
	type LegendSeriesSpec,
} from "@/lab/bench/tanstack/chart-legend"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"

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
 * Phase 0 spike: does `polar` + `pie` + `radialArc` actually draw a donut under
 * both renderers, and what is lost to `radialArc` having no `states`?
 *
 * `radialArc`'s `fill` is a `VisualChannel` — datum-only, with no focus context —
 * while `rect`/`line`/`area`/`dot` all take a `states` array carrying
 * `ChartMarkStateContext` (focus, pointer, matches). So the production pie's
 * hover affordance (dim the others to 0.55, scale the hovered slice to 1.035) has
 * no expression at 0.14.0 — and, verified here, no workaround either: `whenFocused`
 * takes a `ChartMark` and `polar` requires a `PolarMark`, so an overlay arc does
 * not typecheck. See the comment on the mark below.
 *
 * In-slice labels are also out of scope here: `radialText`'s `radius` is a
 * channel in radius-scale units, and this chart defines no radius scale, so how
 * a label position maps is a separate question from whether arcs paint.
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
	legend,
}: {
	rows: readonly PieSpikeRow[]
	renderer: TanstackRenderer
	donut: boolean
	className?: string
	colorFor: (name: string) => string
	legend?: ReactNode
}) {
	const definition = useMemo(() => {
		// `pie()` is an EAGER transform, not a mark: it returns rows carrying
		// startAngle/endAngle/angle/fraction, which radialArc then reads as plain
		// channels. Gaps are materialized into the interval, so radialArc must not
		// pad again (padAngle is forced to 0 on the output).
		const slices = pie(rows, { value: (row: PieSpikeRow) => row.value, gapAngle: 0.012 })

		return defineChart({
			marks: [
				polar({
					radiusRatio: 1,
					inset: 8,
					marks: [
						// Accessors, not `"startAngle"` field-name strings: `ChannelField`
						// resolves `TDatum[TKey] extends TValue`, and `PieSpikeRow`'s
						// index signature is `unknown`, so every string channel fails to
						// typecheck. Any row type with an index signature has to use
						// accessors — worth knowing before writing five more charts.
						radialArc(slices, {
							startAngle: (slice) => slice.startAngle,
							endAngle: (slice) => slice.endAngle,
							innerRadius: (context) => (donut ? Math.max(8, context.radius * 0.58) : 0),
							outerRadius: (context) => context.radius,
							cornerRadius: 2,
							fill: (slice) => colorFor(slice.name),
						}),
						// NO hover affordance is possible here, and there is no workaround.
						//
						// `radialArc` has no `states` (nor does any polar mark), so fill and
						// radius cannot react to focus. The obvious fallback — a
						// `whenFocused` overlay arc — does not typecheck either: it is
						// `whenFocused(mark: ChartMark)`, while `polar({ marks })` requires
						// `PolarMark`, and the two initialize contexts are incompatible
						// (`InitializedPolarMark` carries colorValues/angleValues/
						// radiusValues that `InitializedMark` lacks).
						//
						// So the production pie's hover fade + 1.035 scale has no expression
						// at 0.14.0 by any route. Hover feedback here is the tooltip, and
						// the only other affordance is the DOM legend on
						// `PieLegendSpike` — which cannot be the package's own legend
						// either, since `radialArc` reads no colour scale.
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
	}, [rows, colorFor, donut])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Share by category"
			definition={definition}
			legend={legend}
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
 * The same donut with a DOM slice key beneath it, matching what the production
 * pie renders as its `legend="right"`.
 *
 * Hiding a slice renormalises the remaining angles on its own — `pie()` divides
 * by the total of the rows it is handed — so unlike the cartesian spikes there is
 * no domain to re-derive. Colours are pinned by name (see `useSliceColor`) so the
 * survivors keep the hue they had.
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

	const legendSeries = useMemo<LegendSeriesSpec[]>(
		() => rows.map((row) => ({ key: row.name, label: row.name, color: colorFor(row.name) })),
		[rows, colorFor],
	)
	const { hidden, toggle } = useChartLegendState(legendSeries)

	const visibleRows = useMemo(() => rows.filter((row) => !hidden.has(row.name)), [rows, hidden])

	return (
		<PieFigure
			rows={visibleRows}
			renderer={renderer}
			donut={donut}
			className={className}
			colorFor={colorFor}
			legend={
				<ChartSeriesLegend
					series={legendSeries}
					hidden={hidden}
					onToggle={toggle}
					label="Share by category"
				/>
			}
		/>
	)
})
