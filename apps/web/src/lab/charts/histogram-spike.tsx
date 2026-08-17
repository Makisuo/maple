import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { formatNumber } from "@maple/ui/lib/format"
import { defineChart, rect } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleLog } from "d3-scale"
import { binX } from "@tanstack/charts/transform/bin"
import { memo, useMemo } from "react"

import { histogramSampleData } from "@maple/ui/components/charts/_shared/sample-data"

import { cursorTooltip } from "@/lab/bench/tanstack/chart-shared"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"

/**
 * One raw observation. No index signature, deliberately — `binX` returns
 * `TransformLineage<TDatum> & …`, and any `Omit`/`keyof` walk over a type with an
 * index signature collapses `keyof` to `string | number` and drops the named
 * fields (the same trap `pie()` hits in `pie-spike.tsx`).
 */
export interface HistogramSpikeRow {
	value: number
}

const HISTOGRAM_TOKENS = {
	bar: ["--chart-1", "#6366f1"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** Bin count, matching the production chart's `histogram.bucketCount` default. */
const BIN_COUNT = 30

/**
 * The fixture, reconstructed as RAW OBSERVATIONS.
 *
 * `histogramSampleData` is pre-bucketed — `{ name: "150-200", value: 132 }` —
 * which is exactly the shape `binX` cannot consume: it bins numbers, not
 * intervals. The production chart has an `isPrebucketed()` bypass for this, and
 * that bypass does not map onto `binX` at all. It maps onto a *different* chart:
 * `rect` fed directly with parsed `x1`/`x2` and no transform. Two observations
 * about that:
 *
 *   1. It is only expressible if the labels parse back into numbers, and the
 *      fixture's last bucket is `"400+"` — an open interval with no upper bound.
 *      A pre-bucketed source is therefore not reliably re-numerable, which is
 *      the real reason the production chart keeps its labels as opaque strings.
 *   2. That opacity is where the production bug lives (see the header comment on
 *      `HistogramSpike`).
 *
 * So this spike takes the honest path for a `binX` chart: expand the fixture's
 * counts back into the observations that would have produced them, spreading
 * each bucket's samples evenly across its interval. Deterministic — no
 * `Math.random()` — so the bench is reproducible run to run. `"400+"` is given
 * the width of its predecessor.
 */
function expandSampleData(): HistogramSpikeRow[] {
	const rows: HistogramSpikeRow[] = []
	let previousWidth = 50
	for (const bucket of histogramSampleData) {
		const [rawLower, rawUpper] = bucket.name.split("-")
		const lower = Number.parseFloat(rawLower ?? "")
		if (!Number.isFinite(lower)) continue
		const parsedUpper = Number.parseFloat(rawUpper ?? "")
		const upper = Number.isFinite(parsedUpper) ? parsedUpper : lower + previousWidth
		previousWidth = upper - lower
		for (let index = 0; index < bucket.value; index++) {
			rows.push({ value: lower + ((index + 0.5) / bucket.value) * (upper - lower) })
		}
	}
	return rows
}

export const histogramSpikeRows: readonly HistogramSpikeRow[] = expandSampleData()

function formatInterval(from: number, to: number): string {
	return `${formatNumber(from)} – ${formatNumber(to)}`
}

/**
 * Phase 0 spike: a histogram built from `binX` + `rect`, replacing
 * `packages/ui/src/components/charts/histogram/query-builder-histogram-chart.tsx`.
 *
 * **`rectY` does not exist at 0.14.0.** `@tanstack/charts/rect` exports exactly
 * two marks — `rect` and `cell` — so the y baseline is an explicit `y1` channel
 * rather than an implied zero. That is not a downgrade here: a log y-axis needs
 * a baseline of 1 anyway, and `rect` lets us say so.
 *
 * **What this buys over the production chart.** `bucketize()` there formats each
 * bucket into a STRING label (`"150-200"`), feeds Recharts a categorical axis
 * over those strings, and then recovers the lower bound in the tick formatter
 * with `String(value).split("-")[0]`. That formatter is a live bug: for any
 * negative lower bound the label is `"-50--20"`, `split("-")[0]` is the empty
 * string, and the `|| String(value)` fallback fires — printing the entire
 * unsplit range on a tick sized for one number. Every latency histogram happens
 * to be non-negative, which is why it has survived; a histogram over a delta,
 * a z-score, or a temperature would show it immediately.
 *
 * `binX` carries numeric `x1`/`x2` through to the mark, so the x axis is a real
 * linear scale formatting real numbers and the interval never round-trips
 * through a string. The tooltip prints the interval from the same two numbers.
 */
export const HistogramSpike = memo(function HistogramSpike({
	rows,
	renderer,
	logScaleY = false,
	className,
}: {
	rows: readonly HistogramSpikeRow[]
	renderer: TanstackRenderer
	logScaleY?: boolean
	className?: string
}) {
	const colors = usePlotColors(HISTOGRAM_TOKENS)

	const bins = useMemo(
		() => binX(rows, { value: (row: HistogramSpikeRow) => row.value, thresholds: BIN_COUNT }),
		[rows],
	)

	const definition = useMemo(() => {
		// A log scale cannot include zero, so the bar baseline is the domain floor
		// in both directions: 0 for linear, 1 for log. Empty bins collapse to zero
		// height rather than mapping `log10(0)` to -Infinity.
		const baseline = logScaleY ? 1 : 0
		const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)

		return defineChart({
			marks: [
				rect(bins, {
					// Accessors, never `x1: "x1"`. `ChannelField` resolves
					// `TDatum[TKey] extends TValue`, and the bin datum's derived fields
					// do not survive that check — the same constraint the pie spike hit.
					x1: (bin) => bin.x1,
					x2: (bin) => bin.x2,
					y1: () => baseline,
					y2: (bin) => Math.max(bin.value, baseline),
					fill: colors.bar,
					fillOpacity: 0.85,
					// Recharts draws `barCategoryGap={1}`; an inset is the equivalent and
					// it survives the bins being unequal widths.
					inset: 0.5,
					radius: 2,
					// Unlike every polar mark, `rect` DOES take `states`, so the hover
					// affordance the pie spike could not express costs one entry here.
					states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
				}),
			],
			x: {
				// The FACTORY, not an instance: it infers its domain from the
				// materialized `x1`/`x2` channels. `scaleLinear()` would keep its empty
				// configured domain and draw axes with no bars at all, silently.
				scale: scaleLinear,
				grid: false,
				axis: {
					line: false,
					// A number formatter over numbers. No string splitting, no empty
					// labels on negative bounds.
					ticks: { size: 0, padding: 8, spacing: 56, format: formatNumber },
				},
			},
			y: logScaleY
				? {
						// `[1, max]`, not `[0, max]`: there is no zero-anchor default for a
						// log axis and zero has no position on one. Matches the production
						// chart's `domain={[1, "auto"]}` under `scale="log"`.
						// d3's `scaleLog`, configured. `[1, max]` rather than `[0, max]`:
						// zero has no position on a log axis, which is also why the bar
						// baseline below is 1. Matches the production chart's
						// `domain={[1, "auto"]}` under `scale="log"`.
						scale: scaleLog().domain([1, Math.max(maxCount, 10)]),
						grid: true,
						axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
					}
				: {
						// TanStack's inferred linear domain starts at the DATA MINIMUM,
						// where Recharts' `YAxis` anchors at 0. A configured instance is the
						// only way to pin the floor.
						scale: scaleLinear().domain([0, Math.max(maxCount, 1)]),
						nice: true,
						grid: true,
						axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
					},
			// Cartesian, so `focus: "nearest"` does engage — verified by the `states`
			// entry above lighting up the hovered bar, which is exactly what a polar
			// mark cannot do. One bar is one datum, so nearest is also the right
			// semantic: there is no series to group across.
			focus: "nearest",
			focusRing: false,
			tooltip: cursorTooltip("pointer"),
		})
	}, [bins, colors, logScaleY])

	if (bins.length === 0) {
		return (
			<div className={className}>
				<div className="grid h-full w-full place-items-center">
					<span className="text-[11px] text-muted-foreground">No data</span>
				</div>
			</div>
		)
	}

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Value distribution"
			definition={definition}
			// Mandatory: the default body prints the mark's raw channel values, which
			// for a `rect` are four pixel-space edges. The interval is the whole point
			// of using `binX`, so it is what the heading shows.
			renderTooltipBody={({ points }) => {
				const bin = points[0]?.datum
				if (!bin) return null
				return (
					<div className="grid min-w-[9rem] items-start gap-1.5">
						<div className="border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight">
							{formatInterval(bin.x1, bin.x2)}
						</div>
						<div className="flex w-full items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: colors.bar }}
							/>
							<div className="flex flex-1 items-center justify-between gap-3 leading-none">
								<span className="text-muted-foreground">Count</span>
								<span className="font-mono font-semibold text-foreground tabular-nums">
									{formatNumber(bin.value)}
								</span>
							</div>
						</div>
					</div>
				)
			}}
		/>
	)
})
