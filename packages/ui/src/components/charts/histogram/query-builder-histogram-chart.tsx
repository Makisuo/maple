import { barY, defineChart, rect } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import * as React from "react"

import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import { PlotFrame } from "../../plot/plot-frame"
import { integerTickValues, logYScale } from "../../plot/plot-scales"
import { cursorTooltip } from "../../plot/plot-tooltip"
import { usePlotColors, type PlotColorToken } from "../../plot/theme"
import type { QueryBuilderHistogramChartProps } from "../_shared/chart-types"

const HISTOGRAM_TOKENS = {
	bar: ["--chart-1", "#6366f1"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * Stable identity for the no-data case: `data ?? []` would allocate a fresh array
 * every render and defeat the binning memos below.
 */
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

/** Matches the previous chart's `bucketCount` default. */
const DEFAULT_BIN_COUNT = 30

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/** One already-aggregated bin, as a source can supply it. */
interface PrebucketedBin {
	name: string
	value: number
}

/**
 * A source is pre-bucketed when every row is a `{ name, value }` pair.
 *
 * The 200-row ceiling is what separates "someone ran a GROUP BY and handed us
 * counts" from "someone handed us raw rows that happen to carry a name column".
 */
function isPrebucketed(rows: ReadonlyArray<Record<string, unknown>>): boolean {
	if (rows.length === 0) return false
	return (
		rows.every((row) => typeof row.name === "string" && typeof row.value === "number") &&
		rows.length <= 200
	)
}

/**
 * The numeric column to distribute — the first one that is not an identifier.
 */
function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	const first = rows[0]
	if (!first) return "value"
	return (
		Object.keys(first).find(
			(key) => key !== "name" && key !== "bucket" && typeof first[key] === "number",
		) ?? "value"
	)
}

/**
 * The leading number of a bin label, for an axis tick.
 *
 * A tick sized for one number cannot hold `"150-200"`, so it shows the lower
 * bound and the tooltip keeps the full range. The previous implementation did
 * this with `String(value).split("-")[0] || String(value)`, which is a live bug
 * for any NEGATIVE lower bound: `"-50--20"` splits to an empty first element,
 * the `||` fallback fires, and the whole unsplit range prints on a tick sized
 * for one number. Every latency histogram happens to be non-negative, which is
 * why it survived; a histogram over a delta, a z-score or a temperature shows it
 * immediately.
 *
 * Matching the leading numeric token instead handles the sign, decimals and
 * exponents, and falls back to the whole label when there is no number to find
 * (`"400+"`, or a categorical name).
 */
/**
 * Splits a bin label on the dash that separates its two bounds.
 *
 * A "-" is the separator unless it is a sign or an exponent sign, so it must not
 * be the first character, must not follow another "-" (the sign of a negative
 * upper bound), and must not follow an "e"/"E".
 *
 *   "150-200"     -> 150      | "-50--20"   -> -50
 *   "1.0K-2.0K"   -> 1.0K     | "1e-3-2e-3" -> 1e-3
 *   "400+"        -> 400+     | "unknown"   -> unknown
 */
function splitBoundsAt(name: string): number {
	for (let index = 1; index < name.length; index += 1) {
		if (name[index] !== "-") continue
		const previous = name[index - 1]
		if (previous === "-" || previous === "e" || previous === "E") continue
		return index
	}
	return -1
}

/**
 * The lower bound of a bin label, for an axis tick.
 *
 * A tick has room for one bound, so it shows the lower one and the tooltip keeps
 * the full range. The Recharts implementation did this with
 * `String(value).split("-")[0] || String(value)`, which is a live bug for any
 * NEGATIVE lower bound: "-50--20" splits to an empty first element, the `||`
 * fallback fires, and the whole unsplit range prints on a tick sized for one
 * number. Every latency histogram happens to be non-negative, which is why it
 * survived; a histogram over a delta, a z-score or a temperature shows it
 * immediately.
 *
 * Note this deliberately splits rather than extracting a number: the bound
 * carries its unit suffix ("1.0K", "250ms"), and a numeric match would drop it
 * and turn 1.0K into 1.0 on the axis.
 */
export function binLowerBoundLabel(name: string): string {
	const separator = splitBoundsAt(name)
	return separator === -1 ? name : name.slice(0, separator)
}

function formatBound(value: number, unit: string | undefined): string {
	return unit?.startsWith("duration_") ? formatValueByUnit(value, unit) : formatNumber(value)
}

/** A bin whose bounds are real numbers, from raw observations. */
interface NumericBin {
	x1: number
	x2: number
	value: number
}

/**
 * The count axis, shared by both histogram shapes.
 *
 * A log scale cannot include zero, so `baseline` is the domain floor in both
 * directions: empty bins collapse to zero height rather than mapping log10(0) to
 * -Infinity.
 */
function useCountAxis(maxCount: number, useLogY: boolean) {
	return React.useMemo(() => {
		if (useLogY) {
			return {
				baseline: 1,
				y: {
					scale: logYScale(maxCount),
					grid: true,
					axis: { line: false, ticks: { size: 0, padding: 6, format: formatNumber } },
				},
			}
		}
		// Counts are integers and there is no `allowDecimals` option, so the tick
		// values are supplied outright.
		const domain: [number, number] = [0, Math.max(maxCount, 1)]
		return {
			baseline: 0,
			y: {
				scale: scaleLinear().domain(domain),
				grid: true,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 6,
						values: integerTickValues(domain),
						format: formatNumber,
					},
				},
			},
		}
	}, [maxCount, useLogY])
}

function CountTooltipBody({ heading, count, color }: { heading: string; count: number; color: string }) {
	return (
		<div className="grid min-w-[9rem] items-start gap-1.5">
			<div className="border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight">
				{heading}
			</div>
			<div className="flex w-full items-center gap-2">
				<span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
				<div className="flex flex-1 items-center justify-between gap-3 leading-none">
					<span className="text-muted-foreground">Count</span>
					<span className="font-mono font-semibold text-foreground tabular-nums">
						{formatNumber(count)}
					</span>
				</div>
			</div>
		</div>
	)
}

/**
 * Raw observations binned into NUMERIC intervals.
 *
 * The x axis is a real linear scale over real numbers, so a bound never
 * round-trips through a string and `binLowerBoundLabel`'s parsing problem cannot
 * arise at all. This is the common case — a histogram over a numeric column.
 */
function NumericHistogram({
	bins,
	color,
	unit,
	useLogY,
	showTooltip,
	className,
}: {
	bins: readonly NumericBin[]
	color: string
	unit: string | undefined
	useLogY: boolean
	showTooltip: boolean
	className?: string
}) {
	const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)
	const { baseline, y } = useCountAxis(maxCount, useLogY)

	const definition = React.useMemo(
		() =>
			defineChart({
				marks: [
					// `rectY` does not exist at 0.14.0 — `@tanstack/charts/rect` exports
					// only `rect` and `cell` — so the baseline is an explicit `y1`
					// channel rather than an implied zero. Not a downgrade here: a log
					// axis needs a baseline of 1 anyway, and `rect` lets us say so.
					rect(bins, {
						x1: (bin: NumericBin) => bin.x1,
						x2: (bin: NumericBin) => bin.x2,
						y1: () => baseline,
						y2: (bin: NumericBin) => Math.max(bin.value, baseline),
						fill: color,
						fillOpacity: 0.85,
						// The equivalent of Recharts' `barCategoryGap={1}`, and it survives
						// bins of unequal width where a gap fraction would not.
						inset: 0.5,
						radius: 2,
						states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
					}),
				],
				x: {
					// The FACTORY, not an instance: it infers its domain from the
					// materialized x1/x2 channels. `scaleLinear()` would keep its empty
					// configured domain and silently draw axes with no bars at all.
					scale: scaleLinear,
					grid: false,
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							spacing: 56,
							format: (value: number) => formatBound(value, unit),
						},
					},
				},
				y,
				// Cartesian, so `focus: "nearest"` engages — which is what lets the
				// `states` entry above light the hovered bar. One bar is one datum, so
				// nearest is also the right semantic: there is no series to group across.
				focus: "nearest",
				focusRing: false,
				tooltip: showTooltip ? cursorTooltip("pointer") : false,
			}),
		[bins, color, unit, baseline, y, showTooltip],
	)

	return (
		<PlotFrame
			className={className}
			ariaLabel="Value distribution"
			definition={definition}
			// Mandatory: the default body prints the mark's raw channel values, which
			// for a `rect` are four pixel-space edges.
			renderTooltipBody={({ points }) => {
				const bin = points[0]?.datum
				if (!bin) return null
				return (
					<CountTooltipBody
						heading={`${formatBound(bin.x1, unit)} – ${formatBound(bin.x2, unit)}`}
						count={bin.value}
						color={color}
					/>
				)
			}}
		/>
	)
}

/**
 * Bins a source already aggregated, keyed by an opaque label.
 *
 * These stay categorical because the labels are not reliably re-numerable —
 * `"400+"` is an open interval with no upper bound — which is the same reason
 * the Recharts version treated every histogram this way.
 */
function CategoricalHistogram({
	bins,
	color,
	useLogY,
	showTooltip,
	className,
}: {
	bins: readonly PrebucketedBin[]
	color: string
	useLogY: boolean
	showTooltip: boolean
	className?: string
}) {
	const maxCount = bins.reduce((max, bin) => Math.max(max, bin.value), 0)
	const { baseline, y } = useCountAxis(maxCount, useLogY)

	const definition = React.useMemo(
		() =>
			defineChart({
				marks: [
					barY(bins, {
						x: (bin: PrebucketedBin) => bin.name,
						// An EXPLICIT baseline, not the implied `y` one. `barY`'s implicit
						// baseline is zero, and zero has no position on a log axis — so
						// under `logScaleY` every bar becomes degenerate and the chart
						// paints its axes with no bars at all, silently. `y1`/`y2` say
						// where the bar starts, which is the domain floor either way.
						y1: baseline,
						y2: (bin: PrebucketedBin) => Math.max(bin.value, baseline),
						fill: color,
						fillOpacity: 0.85,
						radius: 2,
						states: [{ when: { focus: "primary" }, style: { fillOpacity: 1 } }],
					}),
				],
				x: {
					// The DOMAIN IS PINNED, and it has to be. `scaleBand` (the bare
					// factory) infers its domain from the observed channel values, but
					// `scaleBand()` is a configured INSTANCE that keeps its empty
					// configured domain — and an empty band domain renders the axes with
					// no bars at all, silently. Passing an instance is only correct when
					// the domain comes with it.
					//
					// `paddingInner` is the band-scale equivalent of Recharts'
					// `barCategoryGap={1}` — a hairline between adjacent bars — and it is
					// only reachable on an instance, which is why this is pinned rather
					// than inferred.
					scale: scaleBand<string>(
						bins.map((bin) => bin.name),
						[0, 1],
					).paddingInner(0.05),
					grid: false,
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: binLowerBoundLabel },
						// Collision-aware thinning that keeps the ends. Recharts got this
						// from `interval="preserveStartEnd"` + `minTickGap={32}`.
						tickLabels: { thin: { minGap: 32, priority: "ends" } },
					},
				},
				y,
				focus: "nearest",
				focusRing: false,
				tooltip: showTooltip ? cursorTooltip("pointer") : false,
			}),
		[bins, color, baseline, y, showTooltip],
	)

	return (
		<PlotFrame
			className={className}
			ariaLabel="Value distribution"
			definition={definition}
			renderTooltipBody={({ points }) => {
				const bin = points[0]?.datum
				if (!bin) return null
				// The full range, not the truncated tick label — the tick shows the
				// lower bound only because it has room for one number.
				return <CountTooltipBody heading={bin.name} count={bin.value} color={color} />
			}}
		/>
	)
}

export function QueryBuilderHistogramChart({
	data,
	className,
	tooltip,
	unit,
	logScale,
	bucketCount,
	bucketWidth,
	logScaleY,
}: QueryBuilderHistogramChartProps) {
	// No sample-data fallback: substituting fixtures for real rows made every
	// misconfigured histogram (a source with no numeric column, an empty result)
	// render a plausible-looking distribution instead of an empty state.
	const source = Array.isArray(data) ? data : EMPTY_ROWS
	const binCount = bucketCount ?? DEFAULT_BIN_COUNT
	const binWidth = bucketWidth
	const useLogY = logScaleY ?? logScale ?? false
	const showTooltip = tooltip !== "hidden"

	const colors = usePlotColors(HISTOGRAM_TOKENS)

	const prebucketed = React.useMemo<PrebucketedBin[] | null>(() => {
		if (!isPrebucketed(source)) return null
		return source.map((row) => ({ name: String(row.name ?? "—"), value: asFiniteNumber(row.value) }))
	}, [source])

	const numeric = React.useMemo<NumericBin[]>(() => {
		if (prebucketed) return []

		const valueField = pickValueField(source)
		const values = source
			.map((row) => row[valueField])
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
		if (values.length === 0) return []

		const min = Math.min(...values)
		const max = Math.max(...values)
		const span = max - min
		const width = binWidth ?? (span > 0 ? span / binCount : 1)
		const safeWidth = width > 0 ? width : 1

		const counts = new Map<number, number>()
		for (const value of values) {
			const index = Math.min(Math.floor((value - min) / safeWidth), binCount - 1)
			counts.set(index, (counts.get(index) ?? 0) + 1)
		}

		return Array.from({ length: binCount }, (_, index) => {
			const lower = min + index * safeWidth
			return { x1: lower, x2: lower + safeWidth, value: counts.get(index) ?? 0 }
		})
	}, [prebucketed, source, binCount, binWidth])

	if (prebucketed && prebucketed.length > 0) {
		return (
			<CategoricalHistogram
				bins={prebucketed}
				color={colors.bar}
				useLogY={useLogY}
				showTooltip={showTooltip}
				className={className}
			/>
		)
	}

	if (numeric.length > 0) {
		return (
			<NumericHistogram
				bins={numeric}
				color={colors.bar}
				unit={unit}
				useLogY={useLogY}
				showTooltip={showTooltip}
				className={className}
			/>
		)
	}

	return (
		<div className={cn("relative grid h-full w-full place-items-center", className)}>
			<span className="text-[11px] text-muted-foreground">No data</span>
		</div>
	)
}
