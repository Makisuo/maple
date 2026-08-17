import { usePlotColors } from "@maple/ui/components/plot/theme"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { defineChart } from "@tanstack/charts"
import { colorGradientLegend } from "@tanstack/charts/legend"
import { hexbin } from "@tanstack/charts/spatial/hexbin"
import { tooltip } from "@tanstack/charts/tooltip"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleLog } from "d3-scale"
import { memo, useMemo } from "react"

import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"
import { createSequentialColorScale, DENSITY_RAMP_TOKENS, rampStops } from "@/lab/charts/color-scale"

/**
 * No index signature. `hexbin` returns
 * `TransformLineage<TDatum> & Omit<TransformOutputRow<TOutputs>, …> & {x,y}`, and
 * the `Omit` there has the same effect it has on `pie()`: over a type with an
 * index signature, `keyof` widens to `string | number` and every named field
 * resolves to `unknown`. Channels are accessors, never field-name strings, for the
 * same reason.
 */
export interface TraceScatterSpikeRow {
	startMs: number
	durationMs: number
}

const SPAN_COUNT = 5_000
const WINDOW_MS = 30 * 60 * 1000
// Fixed instant, not `Date.now()` — the fixture must be byte-identical across
// runs so the renderer arms stay comparable, same rule as `bench-data.ts`.
const WINDOW_END_MS = Date.UTC(2026, 7, 17, 14, 0)
const WINDOW_START_MS = WINDOW_END_MS - WINDOW_MS

/** Numerical Recipes LCG. Deterministic, seeded, no `Math.random()`. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		return state / 0x1_0000_0000
	}
}

/**
 * ~5,000 spans shaped like a real APM trace scatter: a dense lognormal body in
 * the 4–90ms band, a mid shoulder, and a deliberate slow tail (~5%) reaching a
 * few seconds — plus a burst of timeouts in one 3-minute window so the density
 * structure has something to actually show.
 */
function makeSpans(): TraceScatterSpikeRow[] {
	const random = makeRandom(0x5eed_1234)
	const spans: TraceScatterSpikeRow[] = []
	const burstStart = WINDOW_START_MS + WINDOW_MS * 0.62
	const burstEnd = burstStart + 3 * 60 * 1000

	for (let index = 0; index < SPAN_COUNT; index++) {
		// Traffic rides a slow sine so the x density is not flat.
		const phase = (index / SPAN_COUNT) * Math.PI * 4
		const jitter = (random() - 0.5) * 0.04
		const position = Math.min(0.9999, Math.max(0, index / SPAN_COUNT + 0.03 * Math.sin(phase) + jitter))
		const startMs = WINDOW_START_MS + position * WINDOW_MS

		// Box–Muller from two LCG draws → lognormal duration body.
		const u1 = Math.max(1e-9, random())
		const u2 = random()
		const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)

		const roll = random()
		let durationMs: number
		if (startMs >= burstStart && startMs <= burstEnd && roll < 0.28) {
			durationMs = 900 * Math.exp(0.45 * normal)
		} else if (roll < 0.05) {
			durationMs = 320 * Math.exp(0.7 * normal)
		} else if (roll < 0.22) {
			durationMs = 70 * Math.exp(0.5 * normal)
		} else {
			durationMs = 12 * Math.exp(0.55 * normal)
		}

		spans.push({ startMs, durationMs: Math.min(9_500, Math.max(0.4, durationMs)) })
	}
	return spans
}

export const TRACE_SCATTER_SPIKE_ROWS: readonly TraceScatterSpikeRow[] = makeSpans()

const DURATION_DOMAIN: readonly [number, number] = [0.4, 10_000]

/**
 * The colour domain is a **fixed estimate, and it has to be.**
 *
 * `hexbin` reduces inside `resolveLayout` — after scales and plot bounds resolve —
 * and nothing surfaces the reduced rows back to the caller. So the app cannot know
 * the real `[1, maxBinCount]` before defining the chart, and there is no hook to
 * learn it afterwards. The sequential scale is built with `clamp(true)` (d3
 * extrapolates past the domain by default), so a wrong guess
 * saturates the top of the ramp rather than breaking; but a genuinely adaptive
 * density legend is not expressible at 0.14.0.
 */
const DENSITY_DOMAIN: readonly [number, number] = [1, 90]

const BIN_WIDTH_PX = 13

/**
 * How much empty domain to leave at each end of the x axis, as a fraction of the
 * data's span.
 *
 * `clip: true` bounds the hexes to the plot rect, which stopped them painting
 * over the axis labels — but clipping is the wrong tool on its own, because the
 * bins on the first and last column are still CENTRED on the plot edge. Half of
 * each one gets cut away, so the chart ends in a column of half-hexagons that
 * are visibly truncated yet still hit-test and still open a tooltip: the shape
 * lies about the bin, and the interaction target no longer matches what is drawn.
 *
 * Padding the domain is the actual fix — it moves the outermost bin centres
 * inward so a whole hexagon fits, and `clip` goes back to being a backstop for
 * the pathological case rather than the mechanism. `binWidth` is in pixels and
 * the plot width is not knowable at definition time (that is the same
 * chicken-and-egg as the density domain above), so this is a fraction: ~1.6% of
 * a 900px plot is ~15px, one bin's worth.
 */
const EDGE_PAD_FRACTION = 0.016

function padTimeDomain(min: number, max: number): readonly [number, number] {
	const pad = (max - min) * EDGE_PAD_FRACTION
	return [min - pad, max + pad] as const
}

/**
 * Phase 0 spike: the standard APM trace scatter — span duration (log y) against
 * timestamp (x) — which Maple cannot draw today because Recharts' `ScatterChart`
 * collapses at trace cardinality (a DOM node per span; 5,000 spans is a stall).
 *
 * `hexbin` aggregates in **final screen space**, so the mark count is bounded by
 * the plot area rather than the row count: at `binWidth` 13 a 900×360 plot can
 * hold roughly 1,900 hexagons no matter whether 5,000 or 5,000,000 spans go in.
 * That is the property that makes this chart possible at all, and it is the one
 * thing here with no Recharts equivalent.
 *
 * Three findings from building it:
 *
 * - **`hexagon.fill` IS a `VisualChannel`**, unlike `cell.fill` — so this chart
 *   could have skipped the chart-level colour scale entirely and coloured each bin
 *   from an accessor. It uses the `color` channel anyway, because
 *   `colorGradientLegend` reads the *chart's* resolved colour scale and a
 *   density plot without a legend is unreadable.
 * - **`hexbin` requires invertible x and y scales** and throws
 *   `"hexbin: x and y scales must support inversion"` otherwise — it bins in
 *   pixels then inverts each bin centre back into data space. Any custom scale
 *   handed to a spatial transform must implement `invert`.
 * - **`hexagon` has no `states`**, so there is no focus affordance on a bin — the
 *   same gap the polar marks have. Hover feedback is the tooltip only.
 */
export const TraceScatterSpike = memo(function TraceScatterSpike({
	rows,
	renderer,
	className,
}: {
	rows: readonly TraceScatterSpikeRow[]
	renderer: TanstackRenderer
	className?: string
}) {
	const colors = usePlotColors(DENSITY_RAMP_TOKENS)

	const colorScale = useMemo(
		() =>
			createSequentialColorScale({
				stops: rampStops(colors),
				domain: DENSITY_DOMAIN,
				// Density in a trace scatter is extremely skewed — a linear ramp
				// paints everything but the hottest core at the bottom stop.
				scaleType: "log",
			}),
		[colors],
	)

	const timeDomain = useMemo(() => {
		let min = Number.POSITIVE_INFINITY
		let max = Number.NEGATIVE_INFINITY
		for (const row of rows) {
			if (!Number.isFinite(row.startMs)) continue
			min = Math.min(min, row.startMs)
			max = Math.max(max, row.startMs)
		}
		if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
			return padTimeDomain(WINDOW_START_MS, WINDOW_END_MS)
		}
		return padTimeDomain(min, max)
	}, [rows])

	const definition = useMemo(() => {
		return defineChart({
			// A hexagon is drawn around its bin CENTRE, so bins on the plot edge
			// paint half a hex outside it — over the y-axis labels. `clip` is off by
			// default and bounds marks to the plot rect. Any mark with extent
			// (hexbin, dots, whiskers) wants this; rects and lines do not notice.
			clip: true,
			marks: [
				hexbin(rows, {
					x: (row: TraceScatterSpikeRow) => row.startMs,
					y: (row: TraceScatterSpikeRow) => row.durationMs,
					binWidth: BIN_WIDTH_PX,
					// `x`, `y`, `source` and `sourceIndexes` are reserved output
					// names and the transform asserts on them at construction.
					outputs: {
						count: { reduce: "count" },
						slowestMs: {
							value: (row: TraceScatterSpikeRow) => row.durationMs,
							reduce: "max",
						},
					},
					color: (bin) => bin.count,
					strokeWidth: 0,
				}),
			],
			x: {
				// Pinned instance, not the `scaleLinear` factory: `resolveScaleInput`
				// applies `includeZero` when it infers, which on epoch milliseconds
				// would stretch the domain back to 1970 and collapse the plot.
				scale: scaleLinear([timeDomain[0], timeDomain[1]], [0, 1]),
				grid: false,
				axis: {
					ticks: {
						count: 6,
						format: (value: number) =>
							new Date(value).toLocaleTimeString(undefined, {
								hour: "2-digit",
								minute: "2-digit",
							}),
					},
				},
			},
			y: {
				// d3's `scaleLog` (see `box-plot-spike.tsx` for the factory-vs-instance
				// note). `hexbin` bins in pixels and inverts each bin centre back into
				// data space — it throws `"hexbin: x and y scales must support
				// inversion"` otherwise — and d3 supplies `invert` along with proper
				// log `ticks`/`tickFormat`, which is the whole reason not to hand-roll.
				scale: scaleLog().domain([...DURATION_DOMAIN]),
				grid: true,
				// `clip` bounds the hexes to the plot rect, but the rect butts straight
				// up against the tick labels, so a clipped edge hex still sits ~3px
				// into them. Tick padding is what buys the gap. `format` is left unset
				// so the scale's own `tickFormat` keeps producing "300.0ms"/"3.00s".
				axis: { line: false, ticks: { padding: 10, format: formatDuration } },
			},
			color: {
				scale: colorScale,
				legend: colorGradientLegend({
					label: "Spans per bin",
					placement: "bottom",
					format: (value) => formatNumber(Math.round(value)),
				}),
			},
			focus: "nearest",
			focusRing: true,
			tooltip: { use: tooltip, className: "maple-bench-tooltip" },
		})
	}, [rows, colorScale, timeDomain])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Span duration by time, hex-binned by density"
			definition={definition}
			// The default body prints the bin's raw x/y — an epoch millisecond and
			// a bin-centre duration — and never mentions the count, which is the
			// only reason the chart exists.
			renderTooltipBody={({ points }) => {
				const bin = points[0]?.datum
				if (!bin) return null
				return (
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: colorScale(bin.count) }}
							/>
							<span className="font-mono font-semibold tabular-nums">
								{formatNumber(bin.count)} spans
							</span>
						</div>
						<span className="text-muted-foreground">
							~{formatDuration(bin.y)} · slowest {formatDuration(bin.slowestMs)}
						</span>
						<span className="text-muted-foreground">
							{new Date(bin.x).toLocaleTimeString(undefined, {
								hour: "2-digit",
								minute: "2-digit",
								second: "2-digit",
							})}
						</span>
					</div>
				)
			}}
		/>
	)
})
