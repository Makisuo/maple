import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatNumber } from "@maple/ui/lib/format"
import { cell, defineChart } from "@tanstack/charts"
import { colorGradientLegend } from "@tanstack/charts/legend"
import { tooltip } from "@tanstack/charts/tooltip"
import { scaleBand } from "@tanstack/charts-scales/band"
import { memo, useMemo } from "react"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
import {
	HEATMAP_RAMP_TOKENS,
	type SequentialScaleType,
	createSequentialColorScale,
	rampStops,
} from "@maple/ui/components/plot/color-scale"
import { PlotFrame } from "@maple/ui/components/plot/plot-frame"

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

/** A `{x,y}` slot with no row behind it. Carries no value, by construction. */
interface HeatmapHole {
	x: string
	y: string
}

/**
 * The hover ring and the recessed track. Module scope, as everywhere else in
 * this lab: `usePlotColors` memoizes on the token object's identity, so a fresh
 * literal per render would re-read computed style on every frame.
 */
const HEATMAP_CHROME_TOKENS = {
	foreground: ["--foreground", "#fafafa"],
	// Production's grout (`query-builder-heatmap-chart.tsx`), the recessed
	// surface a hole is a hole *in*. `tokens.css` defines it for both themes and
	// it inverts between them, hence the token rather than a literal.
	grout: ["--heatmap-grout", "oklch(0.175 0.008 62)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** Preserve first-appearance order — a `Set` over the rows, not a sort. */
function uniqueInOrder(values: readonly string[]): string[] {
	return [...new Set(values)]
}

/**
 * Composite key for an `{x,y}` slot. The separator is an explicit `\u0000`
 * rather than a space because band categories are arbitrary strings and a
 * space is a plausible one — `"06:00 UTC" + "x"` and `"06:00" + "UTC x"` must
 * not collide. Written as an escape, never as a literal control byte: an
 * earlier revision of this line carried a raw NUL and git classified the whole
 * file as binary, which silently disables diffs and most text tooling on it.
 */
const cellKey = (x: string, y: string) => `${x}\u0000${y}`

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/* ------------------------------------------------------- what motion cannot do */

/**
 * The reference's signature move — a column-wave entry, cells fading in per
 * column ~12ms apart — is NOT implemented here, because `@tanstack/charts`
 * 0.14.0 cannot express it. This is worth recording rather than silently
 * omitting, since the API reads as though it can.
 *
 * The pieces all appear to be there: `motion()` from `@tanstack/charts/motion`,
 * a chart-level `motion.delay` callback over `ChartMotionContext` (which
 * carries `datum`, so a column index is a `Map` lookup away), and
 * `addEnterMotionTrack` in `dist/motion.js` ending in a generic
 * `opacity: 0 → target` track that is not gated on mark role. It was wired up
 * exactly that way and measured. What actually happens:
 *
 * - The renderer mounts. `RendererChart` + `motion()` produce a
 *   `.ts-chart-surface` root, so the plumbing is live, not misconfigured.
 * - `initial: true` is additionally wrong under SSR: `animate = !reduced &&
 *   (initial ? motion.initial && (!adoptedRoot || motion.initial === "always")
 *   : …)`, and this app server-renders, so an adopted root skips the entry
 *   animation. `"always"` is the documented fix.
 * - With `"always"` set, reduced-motion off, and the sweep stretched to a
 *   NINE-SECOND window, no `cell` rect ever received an `opacity` attribute and
 *   `data-ts-motion-role` was never set on anything. No enter track is created
 *   for `cell` at all. The only role with bespoke entrance choreography is
 *   `"bar"` (`dist/motion.js`, gated on `timingContext.role === "bar"`).
 *
 * `states[].transition` is dropped for the same reason: state easing is applied
 * BY the motion renderer, so with no animating renderer mounted it is
 * configuration that cannot take effect. Hover feedback is therefore instant
 * here, where production eases it over 100ms in CSS — the one place this chart
 * still feels less finished than the thing it replaces.
 *
 * Re-test when the package leaves pre-alpha; if `cell` gains an enter track the
 * wave is a dozen lines (`delay: (ctx) => columnIndex.get(ctx.datum.x) * 12`).
 */

/* ------------------------------------------------------------------- model */

interface HeatmapModel {
	xDomain: string[]
	yDomain: string[]
	domain: readonly [number, number]
	/** Rows surviving the prune — what the data mark actually draws. */
	visibleRows: HeatmapSpikeRow[]
	/** Present slots with no row — the focusable holes. */
	holes: HeatmapHole[]
	prunedColumns: number
	prunedRows: number
	geometry: { radius: number; inset: number; padding: number }
}

/**
 * Production solves cell radius and gap from the RESOLVED pixel size of a cell
 * (radius 2 above 10px, gap 2px above 14px). The scene size is only known after
 * a render, and feeding it back into the definition would cost a
 * render→state→render loop — precisely the commits this arm exists to save. So
 * the density proxy is the grid shape itself: a wide grid gets thin cells, and
 * thin cells want a tighter radius and a thinner seam.
 */
function solveGeometry(columns: number, rows: number): HeatmapModel["geometry"] {
	if (columns > 40 || rows > 24) return { radius: 1, inset: 0.5, padding: 0.04 }
	if (columns > 18 || rows > 12) return { radius: 2, inset: 1, padding: 0.05 }
	return { radius: 3, inset: 1, padding: 0.06 }
}

function buildModel(rows: readonly HeatmapSpikeRow[]): HeatmapModel {
	const present = new Set(rows.map((row) => cellKey(row.x, row.y)))

	// Prune tracks that carry no signal. "No signal" means every cell in the
	// track is zero or absent — NOT merely absent, which was the first cut here
	// and was dead code: `allX` is derived from the rows, so every x in it has at
	// least one row by construction and the filter could never fire. Production
	// prunes ZERO-only tracks (`query-builder-heatmap-chart.tsx:450`), which is
	// the version that has something to say.
	//
	// This is also NOT the same thing as the pinned domains below: pinning is
	// what keeps a SPARSE hole rendering as a hole, while pruning drops a column
	// or row that says nothing end to end and would otherwise spend axis width on
	// it. The count is reported rather than dropped silently, because a hidden
	// track still misrepresents the range if nobody is told.
	const allX = uniqueInOrder(rows.map((row) => row.x))
	const allY = uniqueInOrder(rows.map((row) => row.y))
	const signal = new Set(
		rows
			.filter((row) => Number.isFinite(row.value) && row.value !== 0)
			.map((row) => cellKey(row.x, row.y)),
	)
	const nonEmptyX = allX.filter((x) => allY.some((y) => signal.has(cellKey(x, y))))
	const nonEmptyY = allY.filter((y) => allX.some((x) => signal.has(cellKey(x, y))))

	// Everything empty is a real answer ("nothing happened"), so keep the axes
	// rather than pruning down to an empty chart.
	const xDomain = nonEmptyX.length > 0 ? nonEmptyX : allX
	// Band `y` maps `domain[0]` to the TOP (`configured-scale.js` normalizes the
	// y range to ascending for categorical scales). Production puts the LARGEST
	// bucket at the top — `300ms+` above `0-100ms` — and first-appearance order
	// runs the other way, which `FINDINGS.md` recorded as a parity gap. Reverse.
	const yDomain = [...(nonEmptyY.length > 0 ? nonEmptyY : allY)].reverse()

	// Pruning the DOMAIN is only half of it — the rows have to go too. A datum
	// whose band value is not in the pinned domain does not disappear: the scale
	// maps it to nothing and the mark emits `<rect x="null">`, which the browser
	// resolves to x=0, stacking the pruned column on top of the first visible
	// one. It renders as a column split down the middle by a second, wrongly
	// coloured cell — which is exactly how this was caught.
	const visibleX = new Set(xDomain)
	const visibleY = new Set(yDomain)
	const visibleRows = rows.filter((row) => visibleX.has(row.x) && visibleY.has(row.y))

	// Scale over the VISIBLE rows: the pruned zeros would otherwise pin `min` to
	// 0 and stretch the ramp across a range the chart no longer draws.
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY
	for (const row of visibleRows) {
		if (!Number.isFinite(row.value)) continue
		min = Math.min(min, row.value)
		max = Math.max(max, row.value)
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0
		max = 1
	}
	if (min === max) max = min + 1

	const holes: HeatmapHole[] = []
	for (const x of xDomain) {
		for (const y of yDomain) {
			if (!present.has(cellKey(x, y))) holes.push({ x, y })
		}
	}

	return {
		xDomain,
		yDomain,
		domain: [min, max] as const,
		visibleRows,
		holes,
		prunedColumns: allX.length - nonEmptyX.length,
		prunedRows: allY.length - nonEmptyY.length,
		geometry: solveGeometry(xDomain.length, yDomain.length),
	}
}

/* ------------------------------------------------------------------ render */

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
 *    pair with no row emits no cell, so whatever is painted underneath shows
 *    through — the required distinction from a minimum-value cell. But band
 *    domains are otherwise inferred from the observed channel values, so an
 *    entirely empty column or row would silently vanish from the axis instead of
 *    rendering as a gap. The pinned `scaleBand(domain, range)` instances below
 *    are what makes a hole a hole.
 * 3. **`colorGradientLegend` works** — it needs `colors.domain` to be numeric
 *    `[min, max]` and calls `colors.map(value)` per step, both of which the
 *    hand-rolled scale satisfies. One honest caveat: it walks the domain
 *    *linearly* and samples the ramp at each value, so under `scaleType="log"` the
 *    bar shows the log-warped ramp against a linear value axis. That is correct
 *    (each swatch really is that value's colour) but it is not the production
 *    legend, which instead labels evenly-spaced *swatches* with their inverted
 *    values via `valueAtT`. There is no hook to supply tick positions.
 * 4. **Scale factory vs instance.** `scaleBand` (the factory) infers; `scaleBand()`
 *    (an instance) keeps its empty configured domain and renders nothing at all.
 *    Instances are passed here *because* the domain is being pinned deliberately.
 *
 * ## The hover cascade, and the undocumented selector that makes it possible
 *
 * `ChartMarkStateSelector.focus` accepts `'primary' | 'group' | 'key' | 'x' |
 * 'y' | 'series'` **and `'unmatched'`** (`types.d.ts:94`, resolved at
 * `mark-state.js:104`). `'unmatched'` appears nowhere in the package docs and is
 * the one that matters: it resolves to `!matches("group")`, i.e. every cell that
 * is not the focused one. Combined with `'x'` / `'y'` — which compare `xValue` /
 * `yValue` against the focused point (`focus-layer.js:233`) — a heatmap gets a
 * real crosshair with no DOM overlay and no geometry arithmetic, which was the
 * single largest parity gap `FINDINGS.md` recorded against production.
 *
 * States apply in ARRAY ORDER and their transitions merge (`resolveNodeState`,
 * `mark-state.js:63`), so the cascade below reads literally: dim the field, then
 * restore the cross, then mark the cell.
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

	const model = useMemo(() => buildModel(rows), [rows])

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
		const { radius, inset, padding } = model.geometry

		// The reference's two-layer cell — a neutral track under the colour — is
		// here a per-slot grout cell rather than one panel behind the whole plot,
		// and that is a package limit rather than a preference. Two routes to a
		// full-plot track were tried and neither works at 0.14.0:
		//
		// - `rect` with `x1: firstCategory, x2: lastCategory`. A band scale's
		//   `map()` returns the band CENTRE, so the rect spans centre-to-centre —
		//   measured at `x: 206.64, w: 867.46` against a plot starting at `x:
		//   71.74`. It renders as a visible slab offset into the grid. `inset`
		//   cannot correct it either: the missing bleed is half a band on each
		//   axis (135px vs 76px here) and `inset` is one number for all four sides.
		// - `rect` with the extent channels omitted, hoping it fills the plot. It
		//   emits no node at all (rect count 45 → 44).
		//
		// So the seams between cells show the card background, as they did before
		// this pass, and only the SLOTS are grouted. What that costs is production's
		// recessed-panel look; what it keeps is the part that carries meaning — an
		// empty slot reads as a hole in a surface rather than as absence.
		//
		// Holes are their OWN cells rather than absences, for one reason: a hole
		// has to be focusable. With `focus: "nearest"` an absent cell means the
		// pointer snaps to a neighbour and the tooltip confidently reports someone
		// else's value. A grout-filled cell under the cursor can say "no data".
		const holes = cell(model.holes, {
			x: (hole: HeatmapHole) => hole.x,
			y: (hole: HeatmapHole) => hole.y,
			fill: chrome.grout,
			inset,
			radius,
		})

		const data = cell(model.visibleRows, {
			x: (row: HeatmapSpikeRow) => row.x,
			y: (row: HeatmapSpikeRow) => row.y,
			// The ONLY per-datum colour route on a rect mark; `fill` is a
			// flat string. `ChartKey` is `string | number`, so a raw count
			// passes straight through to the colour scale.
			color: (row: HeatmapSpikeRow) => row.value,
			inset,
			radius,
			// `when` is a SELECTOR OBJECT, not a state name — `when: "focused"`
			// is the obvious guess and does not typecheck.
			//
			// One thing this deliberately does NOT do: `stroke: "currentColor"`. It
			// resolves on SVG by inheritance and resolves to nothing on canvas, so
			// the affordance silently differed between renderers. Every colour in
			// these specs has to be a literal; that is the whole reason
			// `usePlotColors` exists.
			states: [
				{
					// Everything that is not the hovered cell recedes. Production has
					// no equivalent — it paints two additive 10% bands and dims nothing
					// — and subtraction reads considerably better on a grid where every
					// cell is already carrying colour.
					when: { focus: "unmatched" },
					style: { opacity: 0.28 },
				},
				{
					// The cross. `x`/`y` match on the focused point's band value, so
					// these restore the hovered row and column out of the dim above.
					when: { focus: "x" },
					style: { opacity: 1 },
				},
				{
					when: { focus: "y" },
					style: { opacity: 1 },
				},
				{
					when: { focus: "primary" },
					style: {
						stroke: chrome.foreground,
						strokeWidth: 1.5,
						// Ring only — geometry deliberately fixed.
						//
						// Production draws `0 0 0 1.5px var(--foreground)` OUTSIDE the
						// cell (heatmap chart:737), where an SVG stroke is centred on the
						// edge, so ~0.75px of this one lands on the data. `inset: 0` would
						// grow the cell into its seam and win that back, and it was tried:
						// with no transition available it arrives as an instant 1px jump
						// per side, which reads as the grid twitching rather than as
						// feedback. That was this file's original finding and it still
						// holds — the easing that would have made a pop legible needs the
						// motion renderer, which animates nothing here (see FINDINGS.md).
						//
						// `strokeOpacity` is not an option for softening it either:
						// `ChartRectStateStyle` omits it. An earlier revision set it
						// anyway and it was inert.
					},
				},
			],
		})

		return defineChart({
			// Paint order is mark order: grout slots first, then the data over them.
			marks: [holes, data],
			x: {
				// Pinned instance: an inferred domain would drop a fully-empty
				// column, turning a hole into a missing axis slot.
				scale: scaleBand<string>(model.xDomain, [0, 1]).paddingInner(padding),
				grid: false,
			},
			y: {
				scale: scaleBand<string>(model.yDomain, [0, 1]).paddingInner(padding),
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
			tooltip: { use: tooltip, className: "maple-plot-tooltip" },
		})
	}, [model, colorScale, chrome])

	// A chart over an empty domain is not worth mounting — it would draw axes for
	// nothing. Production renders a decorative placeholder grid instead; same
	// idea, on the grout track so the surface still reads as a heatmap.
	if (rows.length === 0) {
		return (
			<div className={className}>
				<div className="flex h-full w-full flex-col items-center justify-center gap-2">
					<div
						className="grid grid-cols-8 gap-[2px] rounded-[4px] p-[3px]"
						style={{ backgroundColor: chrome.grout }}
					>
						{Array.from({ length: 32 }, (_value, index) => (
							<span
								key={index}
								className="size-1.5 rounded-[1px]"
								style={{
									backgroundColor:
										index === 11
											? colors.s1
											: index === 18
												? colors.s2
												: index === 21
													? colors.s3
													: undefined,
								}}
							/>
						))}
					</div>
					<span className="text-[11px] text-muted-foreground">No data</span>
				</div>
			</div>
		)
	}

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Request count by hour and latency bucket"
			definition={definition}
			footer={
				model.prunedColumns > 0 || model.prunedRows > 0 ? (
					<p className="pt-1 text-right text-[10px] text-muted-foreground/70">
						{[
							model.prunedColumns > 0 ? pluralize(model.prunedColumns, "empty column") : null,
							model.prunedRows > 0 ? pluralize(model.prunedRows, "empty row") : null,
						]
							.filter(Boolean)
							.join(" · ")}{" "}
						hidden
					</p>
				) : null
			}
			// The default body prints the raw x/y channels — here the two band
			// labels and nothing else, so the actual count would never appear.
			renderTooltipBody={({ points }) => {
				// Two marks means two datum shapes in the union, so the body narrows
				// rather than assumes.
				const slot = points[0]?.datum as Partial<HeatmapSpikeRow> | undefined
				if (typeof slot?.x !== "string" || typeof slot.y !== "string") return null

				const label = (
					<span className="text-muted-foreground">
						{slot.x} · {slot.y}
					</span>
				)

				// A hole carries no `value`. Distinguishing it here is the point of
				// giving holes their own mark: without it `focus: "nearest"` would
				// report a neighbouring cell's count for an empty slot.
				if (typeof slot.value !== "number") {
					return (
						<div className="flex items-center gap-2">
							{label}
							<span className="text-muted-foreground italic">no data</span>
						</div>
					)
				}

				return (
					<div className="flex items-center gap-2">
						<span
							className="size-2.5 shrink-0 rounded-[2px]"
							style={{ backgroundColor: colorScale(slot.value) }}
						/>
						{label}
						<span className="font-mono font-semibold tabular-nums">
							{formatNumber(slot.value)}
						</span>
					</div>
				)
			}}
		/>
	)
})
