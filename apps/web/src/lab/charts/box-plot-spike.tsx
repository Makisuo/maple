import { PlotFrame, cursorTooltip, usePlotColors, type PlotColorToken } from "@maple/ui/components/plot"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { boxY, defineChart } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLog } from "d3-scale"

import { memo, useMemo } from "react"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
/**
 * One RAW observation — a single span's duration, not a pre-computed summary.
 *
 * `boxY` is a mark, not a transform over summaries: it takes the raw rows and
 * computes the Tukey five-number summary and the outlier set itself (confirmed
 * in `dist/box.d.ts` — `boxRows()` is the same computation exposed standalone,
 * and `boxY`'s datum is the `BoxSummaryDatum | BoxOutlierDatum` union it
 * produces, carrying `TransformLineage` back to these rows). It needs exactly
 * two channels: `x` (the category) and `y` (the numeric observation).
 *
 * No index signature — see `pie-spike.tsx`; `BoxDatum` is built with
 * `TransformLineage<TDatum>`, and a `keyof` walk over an index signature drops
 * every named field.
 */
export interface BoxPlotSpikeRow {
	operation: string
	durationMs: number
}

const BOX_TOKENS = {
	box: ["--chart-1", "#6366f1"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** Median latency and lognormal sigma per operation — a realistic APM spread. */
const OPERATIONS: readonly { name: string; medianMs: number; sigma: number }[] = [
	{ name: "GET /api/traces", medianMs: 8, sigma: 0.45 },
	{ name: "GET /api/spans", medianMs: 21, sigma: 0.6 },
	{ name: "POST /v1/traces", medianMs: 5.5, sigma: 0.35 },
	{ name: "GET /api/services", medianMs: 46, sigma: 0.5 },
	{ name: "POST /api/query", medianMs: 190, sigma: 0.75 },
	{ name: "GET /api/dashboards", medianMs: 62, sigma: 0.55 },
	{ name: "pg.select alert_rules", medianMs: 2.4, sigma: 0.4 },
	{ name: "clickhouse.spans_scan", medianMs: 540, sigma: 0.85 },
]

const SAMPLES_PER_OPERATION = 120

/** Numerical Recipes LCG. Deterministic, seeded, no `Math.random()`. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		return state / 0x1_0000_0000
	}
}

/**
 * Deterministic lognormal latency samples — no `Math.random()`, no `Date.now()`,
 * so the rows stay byte-identical between runs and the bench numbers remain
 * comparable across sessions (the discipline `bench-data.ts` sets out).
 *
 * Lognormal, via Box–Muller over a seeded LCG, is the same generator
 * `trace-scatter-spike.tsx` uses and it is not decoration. An earlier version
 * summed three sine terms for the spread and then multiplied every 17th sample
 * by ~2.6 to manufacture outliers, and the result was a broken-looking chart for
 * two compounding reasons: the sine spread gave each operation a near-symmetric,
 * NARROW interquartile range, while the injected tail pushed the axis maximum to
 * roughly 4× the tallest box. Every box collapsed to a few pixels of height —
 * a box plot that reads as a bar chart.
 *
 * A real latency distribution is right-skewed and produces its own outliers past
 * 1.5×IQR, which is the whisker rule this mark exists to exercise. Nothing needs
 * to be injected.
 */
function makeRows(): BoxPlotSpikeRow[] {
	const random = makeRandom(0xb0c5_1234)
	const rows: BoxPlotSpikeRow[] = []
	for (const operation of OPERATIONS) {
		for (let sample = 0; sample < SAMPLES_PER_OPERATION; sample++) {
			const u1 = Math.max(1e-9, random())
			const u2 = random()
			const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
			rows.push({
				operation: operation.name,
				durationMs: Math.max(
					0.2,
					Math.round(operation.medianMs * Math.exp(operation.sigma * normal) * 10) / 10,
				),
			})
		}
	}
	return rows
}

export const boxPlotSpikeRows: readonly BoxPlotSpikeRow[] = makeRows()

/**
 * Phase 0 spike: latency distribution per operation — a chart Maple cannot draw
 * today at all. There is no box plot in `packages/ui/src/components/charts/`,
 * and Recharts has no primitive for one; the closest available shape is three
 * separate percentile series, which shows the quartiles but not the spread and
 * never shows an outlier.
 *
 * `boxY` renders the whole composite — box, median rule, both whiskers, and one
 * dot per outlier — as a single mark.
 *
 * Two limits worth recording:
 *
 * - **`fill` and `stroke` are plain `string`s, not `VisualChannel`s** (compare
 *   `barY`, where both accept an accessor). So every box in a `boxY` mark is one
 *   colour; colouring by category, or by an SLO breach, is not expressible.
 *   `strokeWidth` is shared by the whiskers, the median and the outliers too —
 *   the sub-parts have no independent styling.
 * - **`states` is absent.** `BoxOptions` extends only `ChartMarkMotionOptions`,
 *   so unlike `rect`/`bar`/`line` there is no focus-reactive style. The hover
 *   affordance is the tooltip alone, exactly as in the polar spike — though for
 *   a different reason (no `states` field rather than no focus context).
 */
export const BoxPlotSpike = memo(function BoxPlotSpike({
	rows,
	renderer,
	className,
}: {
	rows: readonly BoxPlotSpikeRow[]
	renderer: TanstackRenderer
	className?: string
}) {
	const colors = usePlotColors(BOX_TOKENS)

	const definition = useMemo(() => {
		let minDuration = Number.POSITIVE_INFINITY
		let maxDuration = 0
		for (const row of rows) {
			minDuration = Math.min(minDuration, row.durationMs)
			maxDuration = Math.max(maxDuration, row.durationMs)
		}

		return defineChart({
			marks: [
				// Accessors, not `x: "operation"` — `ChannelField` cannot resolve a
				// field name here, the same constraint as every other mark in this lab.
				boxY(rows, {
					x: (row: BoxPlotSpikeRow) => row.operation,
					y: (row: BoxPlotSpikeRow) => row.durationMs,
					fill: colors.box,
					fillOpacity: 0.35,
					stroke: colors.box,
					strokeWidth: 1.5,
					// `inset` is NOT the width knob it looks like. `boxY` forwards it to
					// the internal `barY`'s inset, which the renderer clamps — raising it
					// from 10 to 26 moved the drawn box by a couple of pixels. Band
					// padding on the x scale below is what actually sizes a box.
					inset: 2,
					r: 2.5,
				}),
			],
			scales: {
				x: {
					// A PINNED instance, not the `scaleBand` factory. The factory infers the
					// categories fine, but it also leaves `paddingInner` at zero, so each box
					// fills its whole slot and the chart reads as a bar chart. Padding is the
					// only lever that actually narrows a `boxY` box (see the `inset` note
					// above), and pinning is the price of setting it.
					scale: scaleBand<string>(
						OPERATIONS.map((operation) => operation.name),
						[0, 1],
					).paddingInner(0.55),
					axis: {
						line: false,
						ticks: { size: 0, padding: 8 },
						// Operation names are long; rotating beats thinning, which would drop
						// whole boxes' labels.
						tickLabels: { rotate: -30, anchor: "end", fontSize: 10 },
					},
				},
				y: {
					// LOG, not linear. Latency across operations spans orders of magnitude —
					// a 2ms index lookup beside a 540ms table scan — and on a linear axis
					// pinned at zero every fast operation's box collapses onto the baseline
					// while the slow one's outliers set the maximum. The chart then shows
					// only "one of these is slow", which the reader already knew, and hides
					// the spread, which is the entire reason to draw a box plot.
					//
					// A log axis gives every operation the same visual budget for its own
					// distribution. This is also what the production percentile charts
					// cannot express at all.
					// The domain follows the DATA with a little headroom, not the enclosing
					// whole decades. Snapping outward added most of an unused decade at each
					// end here, and on a log axis every wasted decade is a proportional
					// slice of every box's height.
					// d3's `scaleLog`, per the Scales and D3 guide: the compact scales cover
					// linear/band/point/ordinal, and anything beyond that is a documented
					// d3-scale dependency rather than something to hand-roll.
					//
					// A CONFIGURED INSTANCE, and called deliberately rather than defensively.
					// `isScaleFactory()` is `typeof source === "function" && !("copy" in
					// source)`, and `copy` lives on the INSTANCE, not on the factory
					// function — verified: `"copy" in scaleLog` is false, `"copy" in
					// scaleLog()` is true. So a bare `scaleLog` would be treated as a factory
					// and would infer its domain from the data, which is a perfectly good
					// default; it is simply not what this chart wants.
					//
					// It wants the domain to follow the data with a little headroom rather
					// than snapping out to whole decades, because on a log axis every wasted
					// decade takes a proportional slice out of every box's height.
					scale: scaleLog().domain([minDuration * 0.85, maxDuration * 1.2]),
					grid: true,
					axis: { line: false, ticks: { size: 0, padding: 6, format: formatLatency } },
				},
			},
			// Cartesian, so `focus: "nearest"` engages — the polar caveat from
			// `pie-spike.tsx` does not apply. Nearest rather than `group-x`: the
			// summary and its outliers are separate data in the same mark, and nearest
			// is what distinguishes hovering the box from hovering an outlier dot.
			focus: "nearest",
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		})
	}, [rows, colors])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Latency distribution by operation"
			definition={definition}
			// Mandatory: the default body prints raw channel values — for a summary
			// that is the category and one pixel-mapped number, which says nothing
			// about a five-number summary. The datum is a discriminated union, so the
			// body branches on `kind` and an outlier gets its own readout.
			renderTooltipBody={({ points }) => {
				const datum = points[0]?.datum
				if (!datum) return null

				const heading = (
					<div className="border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight">
						{String(datum.category)}
					</div>
				)

				if (datum.kind === "outlier") {
					return (
						<div className="grid min-w-[10rem] items-start gap-1.5">
							{heading}
							<div className="flex w-full items-center justify-between gap-3 leading-none">
								<span className="text-muted-foreground">Outlier</span>
								<span className="font-mono font-semibold text-foreground tabular-nums">
									{formatLatency(datum.value)}
								</span>
							</div>
						</div>
					)
				}

				const summaryRows: readonly (readonly [string, string])[] = [
					["Max (whisker)", formatLatency(datum.whiskerHigh)],
					["Q3", formatLatency(datum.q3)],
					["Median", formatLatency(datum.median)],
					["Q1", formatLatency(datum.q1)],
					["Min (whisker)", formatLatency(datum.whiskerLow)],
					["Samples", formatNumber(datum.count)],
				]

				return (
					<div className="grid min-w-[11rem] items-start gap-1.5">
						{heading}
						<div className="grid gap-1.5">
							{summaryRows.map(([label, value]) => (
								<div
									key={label}
									className={
										label === "Median"
											? "flex w-full items-center justify-between gap-3 leading-none [&_*]:font-semibold"
											: "flex w-full items-center justify-between gap-3 leading-none"
									}
								>
									<span className="text-muted-foreground">{label}</span>
									<span className="font-mono font-semibold text-foreground tabular-nums">
										{value}
									</span>
								</div>
							))}
						</div>
					</div>
				)
			}}
		/>
	)
})
