import { cell, defineChart } from "@tanstack/charts"
import type { ChartPoint } from "@tanstack/charts"
import { scaleBand } from "@tanstack/charts-scales/band"
import { tooltip } from "@tanstack/charts/tooltip"
import * as React from "react"

import {
	DEFAULT_HEATMAP_COLOR_SCALE,
	type HeatmapColorScale,
	type HeatmapScaleType,
} from "@maple/domain/http"
import { useContainerSize } from "../../../hooks/use-container-size"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import {
	PlotFrame,
	createSequentialColorScale,
	resolveSequentialDomain,
	usePlotColors,
	type PlotColorToken,
} from "../../plot"
import type { QueryBuilderHeatmapChartProps } from "../_shared/chart-types"

/** One row of the long-form shape the chart draws from. */
interface HeatmapPoint {
	x: string
	y: string
	value: number
}

/**
 * One slot in the grid — a cell with a value, or a hole with none.
 *
 * Holes are DATA rather than absences, and they share this type with the
 * painted cells on purpose. A `{x,y}` pair with no row emits no rect, so
 * `focus: "nearest"` would snap the pointer to a neighbour and the tooltip
 * would confidently report someone else's count. Giving a hole its own datum
 * makes it focusable, so it can say "no data" — and keeping ONE datum type
 * across both marks means the tooltip body narrows on `value` instead of
 * casting a union apart.
 */
interface HeatmapSlot {
	x: string
	y: string
	value: number | null
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function deriveHeatmapPoints(rows: ReadonlyArray<Record<string, unknown>>): HeatmapPoint[] {
	if (rows.length === 0) return []

	const first = rows[0]
	if ("x" in first && "y" in first && "value" in first) {
		return rows.map((row) => ({
			x: String(row.x ?? ""),
			y: String(row.y ?? ""),
			value: asFiniteNumber(row.value),
		}))
	}

	const numericKeys = Object.keys(first).filter(
		(k) => k !== "name" && k !== "bucket" && typeof first[k] === "number",
	)
	const labelKey = "name" in first ? "name" : "bucket" in first ? "bucket" : null
	if (!labelKey || numericKeys.length === 0) return []

	const points: HeatmapPoint[] = []
	for (const row of rows) {
		const yLabel = String(row[labelKey] ?? "")
		for (const xKey of numericKeys) {
			points.push({
				x: xKey,
				y: yLabel,
				value: asFiniteNumber(row[xKey]),
			})
		}
	}
	return points
}

/**
 * Five-stop sequential palettes. The stops live in `tokens.css` as
 * `--heatmap-<name>-0..4` so they can differ per theme — each ramp is anchored
 * just above the local card surface and climbs to a saturated hot end, which
 * means the whole ramp inverts between light and dark.
 *
 * They are RESOLVED to `oklch()` literals through `usePlotColors` before they
 * reach the chart definition. The old grid mixed flanking stops with CSS
 * `color-mix(in oklch, …)` and let the browser do the interpolation; the canvas
 * renderer takes literal colours and cannot read a `var()`, so both the mixing
 * (`createSequentialColorScale`) and the resolution (`usePlotColors`) now happen
 * in JS. `mixOklch` in `plot/color-scale.ts` reproduces `color-mix(in oklch, …)`
 * numerically, so a value at t=0.4 still *looks* 40% of the way along.
 *
 * The literal beside each token is the fallback used when the document has no
 * stylesheet behind it (SSR, jsdom); they are the dark-theme values.
 */
const RAMP_STOP_TOKENS = {
	amber0: ["--heatmap-amber-0", "oklch(0.32 0.035 70)"],
	amber1: ["--heatmap-amber-1", "oklch(0.45 0.075 65)"],
	amber2: ["--heatmap-amber-2", "oklch(0.58 0.115 60)"],
	amber3: ["--heatmap-amber-3", "oklch(0.71 0.15 57)"],
	amber4: ["--heatmap-amber-4", "oklch(0.85 0.13 78)"],
	blues0: ["--heatmap-blues-0", "oklch(0.32 0.04 255)"],
	blues1: ["--heatmap-blues-1", "oklch(0.45 0.08 252)"],
	blues2: ["--heatmap-blues-2", "oklch(0.58 0.12 250)"],
	blues3: ["--heatmap-blues-3", "oklch(0.71 0.15 248)"],
	blues4: ["--heatmap-blues-4", "oklch(0.85 0.11 238)"],
	reds0: ["--heatmap-reds-0", "oklch(0.32 0.045 28)"],
	reds1: ["--heatmap-reds-1", "oklch(0.45 0.09 28)"],
	reds2: ["--heatmap-reds-2", "oklch(0.58 0.14 28)"],
	reds3: ["--heatmap-reds-3", "oklch(0.71 0.185 30)"],
	reds4: ["--heatmap-reds-4", "oklch(0.85 0.135 45)"],
	viridis0: ["--heatmap-viridis-0", "oklch(0.32 0.055 285)"],
	viridis1: ["--heatmap-viridis-1", "oklch(0.45 0.095 265)"],
	viridis2: ["--heatmap-viridis-2", "oklch(0.58 0.09 200)"],
	viridis3: ["--heatmap-viridis-3", "oklch(0.71 0.135 150)"],
	viridis4: ["--heatmap-viridis-4", "oklch(0.85 0.17 112)"],
	magma0: ["--heatmap-magma-0", "oklch(0.32 0.06 300)"],
	magma1: ["--heatmap-magma-1", "oklch(0.45 0.12 312)"],
	magma2: ["--heatmap-magma-2", "oklch(0.58 0.175 350)"],
	magma3: ["--heatmap-magma-3", "oklch(0.71 0.16 35)"],
	magma4: ["--heatmap-magma-4", "oklch(0.85 0.115 80)"],
	cividis0: ["--heatmap-cividis-0", "oklch(0.32 0.045 262)"],
	cividis1: ["--heatmap-cividis-1", "oklch(0.45 0.055 250)"],
	cividis2: ["--heatmap-cividis-2", "oklch(0.58 0.03 130)"],
	cividis3: ["--heatmap-cividis-3", "oklch(0.71 0.075 95)"],
	cividis4: ["--heatmap-cividis-4", "oklch(0.85 0.13 95)"],
} as const satisfies Record<`${HeatmapColorScale}${0 | 1 | 2 | 3 | 4}`, readonly [PlotColorToken, string]>

type RampColors = Readonly<Record<keyof typeof RAMP_STOP_TOKENS, string>>

const RAMP_INDICES = [0, 1, 2, 3, 4] as const

/**
 * The grid's chrome. Module scope, like every token map handed to
 * `usePlotColors`: the hook memoizes on the object's identity, so a fresh
 * literal per render would re-read computed style on every frame.
 */
const HEATMAP_CHROME_TOKENS = {
	foreground: ["--foreground", "#fafafa"],
	/** The recessed surface a hole is a hole *in*. */
	grout: ["--heatmap-grout", "oklch(0.175 0.008 62)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * Whether a persisted `colorScale` still names a ramp we ship.
 *
 * A runtime guard, not a type-level one: a dashboard saved months ago can carry
 * a scale that has since been renamed, and the old lookup's
 * `COLOR_SCALES[…] ?? COLOR_SCALES.amber` existed for exactly that. Derived from
 * the token table itself so the two cannot drift.
 */
function isKnownColorScale(value: string): value is HeatmapColorScale {
	return `${value}0` in RAMP_STOP_TOKENS
}

function rampStopsFor(scale: HeatmapColorScale, colors: RampColors): readonly string[] {
	return RAMP_INDICES.map((index) => colors[`${scale}${index}`])
}

function clamp(value: number, lo: number, hi: number): number {
	if (!Number.isFinite(value)) return lo
	return Math.max(lo, Math.min(hi, value))
}

function clamp01(value: number): number {
	return clamp(value, 0, 1)
}

/**
 * The data value that lands at parametric position t along the ramp.
 *
 * The legend needs this: with a log scale the midpoint *swatch* is not the
 * midpoint *value*, and labelling it as though it were is what made an earlier
 * gradient bar lie about log-scaled grids. It mirrors d3's own transforms —
 * `scaleSequential` is linear in the value, `scaleSequentialLog` is linear in
 * `log(value)` — so a swatch's label and its colour describe the same number.
 *
 * The domain comes from `resolveSequentialDomain`, the same function the cells'
 * scale is built from. Reimplementing the log floor here is what let the legend
 * label a sub-1 grid `1 / 1 / 1` while the cells were painted from a different
 * (inverted) domain entirely.
 */
function valueAtRampPosition(
	t: number,
	domain: readonly [number, number],
	scaleType: HeatmapScaleType,
): number {
	const [lo, hi] = resolveSequentialDomain(domain, scaleType)
	if (hi <= lo) return lo
	if (scaleType === "log") return lo * (hi / lo) ** clamp01(t)
	return lo + clamp01(t) * (hi - lo)
}

/** Inverse of `valueAtRampPosition` — where a value sits along the ramp, 0..1. */
function rampPositionOf(
	value: number,
	domain: readonly [number, number],
	scaleType: HeatmapScaleType,
): number {
	const [lo, hi] = resolveSequentialDomain(domain, scaleType)
	if (hi <= lo) return 0
	if (scaleType === "log") return clamp01(Math.log(Math.max(value, lo) / lo) / Math.log(hi / lo))
	return clamp01((value - lo) / (hi - lo))
}

function formatScalar(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

/**
 * Legend ticks between the endpoints are interpolated, so they land on values
 * the data never contains — under a log scale the midpoint of 15..103 is
 * 39.3…, which is noise dressed up as precision. Snap to the data's own
 * granularity: integers when the range is integral, three significant figures
 * otherwise.
 */
function roundTick(value: number, min: number, span: number): number {
	if (Number.isInteger(min) && Number.isInteger(min + span)) return Math.round(value)
	if (value === 0) return 0
	const magnitude = Math.floor(Math.log10(Math.abs(value)))
	const factor = 10 ** (2 - magnitude)
	return Math.round(value * factor) / factor
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/

function shortenYLabel(raw: string, allIso: boolean): string {
	if (!allIso) return raw
	const tIdx = raw.indexOf("T")
	if (tIdx < 0) return raw
	return raw
		.slice(tIdx + 1)
		.replace(/\.\d+Z?$/, "")
		.replace(/Z$/, "")
		.slice(0, 5)
}

// ──────────────────────────────────────────────────────────────────────────────
// Model
// ──────────────────────────────────────────────────────────────────────────────

interface HeatmapModel {
	xDomain: string[]
	yDomain: string[]
	/** Slots carrying a value — what the coloured mark draws. */
	cells: HeatmapSlot[]
	/** Slots with no row behind them — the focusable holes. */
	holes: HeatmapSlot[]
	/** `[min, max]` over the DRAWN cells. */
	domain: [number, number]
	/** The real spread, before the degenerate bump below. Drives the legend. */
	span: number
	hiddenX: number
	hiddenY: number
}

const EMPTY_MODEL: HeatmapModel = {
	xDomain: [],
	yDomain: [],
	cells: [],
	holes: [],
	domain: [0, 1],
	span: 0,
	hiddenX: 0,
	hiddenY: 0,
}

function buildModel(points: readonly HeatmapPoint[]): HeatmapModel {
	if (points.length === 0) return EMPTY_MODEL

	const xs = Array.from(new Set(points.map((p) => p.x)))
	const ys = Array.from(new Set(points.map((p) => p.y)))

	// Axis entries where every cell is absent or zero carry no information, but
	// they still claim a full row/column — on a service grid that is routinely
	// most of the plot, and it reads as a broken chart rather than a quiet one.
	// Drop them, and report the count rather than hiding data silently.
	const liveX = new Set<string>()
	const liveY = new Set<string>()
	for (const p of points) {
		if (p.value !== 0) {
			liveX.add(p.x)
			liveY.add(p.y)
		}
	}

	const keptX = xs.filter((x) => liveX.has(x))
	const keptY = ys.filter((y) => liveY.has(y))

	// An all-zero result is a real answer ("nothing happened"). Pruning it to
	// nothing would turn that into an empty state, so keep the axes intact.
	const pruned = keptX.length > 0 && keptY.length > 0
	const xDomain = pruned ? keptX : xs
	// Band `y` maps `domain[0]` to the TOP (`configured-scale.js` normalizes a
	// categorical y range to ascending), and the CSS grid this replaced drew
	// `yValues` top-down after the same reverse. Either way the LAST bucket a
	// query reports — `300ms+` — belongs above `0-100ms`.
	const yDomain = [...(pruned ? keptY : ys)].reverse()

	/**
	 * The composite slot key. The separator is an explicit `\u0000` rather than a
	 * space because band categories are arbitrary strings and a space is a
	 * plausible one — `"GET /a" + "v2"` and `"GET" + "/a v2"` must not collide.
	 * Written as an escape, never as a literal control byte: a raw NUL makes git
	 * classify the whole file as binary, which silently disables diffs on it.
	 */
	const slotKey = (x: string, y: string) => `${x}\u0000${y}`

	const lookup = new Map<string, number>()
	for (const point of points) {
		lookup.set(slotKey(point.x, point.y), point.value)
	}

	// Pruning the DOMAIN is only half of it — the slots have to go too. A datum
	// whose band value is not in the pinned domain does not disappear: the scale
	// maps it to nothing, the mark emits `<rect x="null">`, and the browser
	// resolves that to x=0, stacking the pruned column on top of the first
	// visible one. Walking the surviving cross-product filters both at once, and
	// hands back the holes for free.
	const cells: HeatmapSlot[] = []
	const holes: HeatmapSlot[] = []
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY
	for (const x of xDomain) {
		for (const y of yDomain) {
			const value = lookup.get(slotKey(x, y))
			if (value === undefined) {
				holes.push({ x, y, value: null })
				continue
			}
			cells.push({ x, y, value })
			if (value < min) min = value
			if (value > max) max = value
		}
	}

	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0
		max = 1
	}
	const span = max - min
	// A single-valued grid has no ramp to walk. Widening the domain by one keeps
	// every cell on the bottom stop, which is what the old `span <= 0 → t = 0`
	// normalize painted; a degenerate d3 domain would instead park them all at
	// the ramp's midpoint.
	const domain: [number, number] = span > 0 ? [min, max] : [min, min + 1]

	return {
		xDomain,
		yDomain,
		cells,
		holes,
		domain,
		span,
		hiddenX: pruned ? xs.length - keptX.length : 0,
		hiddenY: pruned ? ys.length - keptY.length : 0,
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Geometry
//
// The CSS grid this replaced solved cell size, seam width and corner radius from
// the container in two passes (seam width depends on cell size, which depends on
// seam width). A band scale takes over the hard part — it divides the plot and
// positions every cell — but its padding is a FRACTION of the step, so the
// pixel-denominated parts of that solver still have to be expressed here.
// ──────────────────────────────────────────────────────────────────────────────

// Upper bounds keep cells from ballooning on huge cards with tiny grids.
// Wider than tall — matches the grafana / signoz time-bucket heatmap shape.
const MAX_CELL_W = 72
const MAX_CELL_H = 40

// Cell seams. The gap is the grid — it shows the grout, which sits deliberately
// *below* the card so the gutter reads as a drawn line. 2px is the working
// default; below ~14px cells that much gutter eats the data, so drop to 1px.
const CELL_GAP_WIDE = 2
const CELL_GAP_TIGHT = 1
const TIGHT_CELL_THRESHOLD = 14

/**
 * The y gutter, BOUNDED.
 *
 * The axis grows `margin.left` to fit whatever it measures (`includeLabelMargin`
 * in `scene.js`), so an unbounded label wins the argument with the grid: a
 * service/operation axis on a 480px widget took ~230px of gutter and left ~250px
 * of plot. The old CSS grid clamped the gutter to `[36, 96]` and ellipsised
 * inside it, and the same two numbers apply here — with the difference that the
 * bound now has to be enforced twice, once by locking the margin and once by
 * truncating the label so nothing is drawn outside the lock.
 *
 * `6.3px` per character is the same average-glyph estimate the old solver used
 * for the repo's 11px UI face; the inset covers the tick padding plus a little
 * air between the longest label and the first column.
 */
const Y_LABEL_CHAR_PX = 6.3
const Y_LABEL_INSET_PX = 10
const Y_GUTTER_MIN = 36
const Y_GUTTER_MAX = 96

/**
 * The band below the plot that the x tick labels live in: the tick padding plus
 * one 11px line plus its descender. Locked rather than measured, because a locked
 * `margin.bottom` is half of what keeps the grid and the x axis together.
 */
const X_AXIS_BAND_PX = 20

/** A hair of headroom so the top row's rounded corners are not flush to the card. */
const PLOT_TOP_PAD = 2

/**
 * The heights of the two DOM strips below the plot, which is what makes the
 * vertical arithmetic exact rather than an estimate.
 *
 * `PlotFrame` puts the legend and the footnote in flex siblings of the measured
 * chart box, so the chart gets `containerH` minus whatever they take. Both are
 * rendered by this file at a FIXED height for that reason — an estimate here
 * lands as a gap between the last row and the x axis, which is exactly the
 * regression this replaced.
 */
const LEGEND_BLOCK_H = 34
const FOOTNOTE_BLOCK_H = 16

/** The padding fraction before anything has been measured. */
const UNMEASURED_PADDING_INNER = 0.05

export interface HeatmapMargin {
	top: number
	right: number
	bottom: number
	left: number
}

export interface HeatmapLayout {
	/**
	 * The margin LOCK handed to the chart spec, or `null` before the container has
	 * been measured (in which case the scene's automatic margins run).
	 *
	 * Locking all four sides is what pins the plot rect to the grid. The band
	 * scales below therefore carry no `paddingOuter`: buying a capped grid's
	 * surplus back as outer padding centres the cells inside the plot rect, but
	 * the axis labels are drawn at the RECT's edges, so a 4×3 grid on a 700×320
	 * card ended up with its y labels ~170px left of the first column. Spending the
	 * surplus as margin instead shrinks the rect onto the grid, and the labels
	 * follow.
	 */
	margin: HeatmapMargin | null
	paddingInnerX: number
	paddingInnerY: number
	radius: number
	/** Bounded y gutter in px. Also the legend's left inset. */
	gutter: number
	/** What a capped grid leaves on the right. Also the legend's right inset. */
	rightInset: number
	/** Characters a y label may show before it is ellipsised into the gutter. */
	yLabelChars: number
}

export interface HeatmapLayoutInput {
	containerW: number
	containerH: number
	columns: number
	rows: number
	/** Length of the longest y label AFTER `shortenYLabel`, in characters. */
	longestYLabelChars: number
	hasFootnote: boolean
}

/**
 * The seam is a fraction of the step, so it has to be solved from the length the
 * axis will actually have: with no outer padding, `bandwidth = (length - (count -
 * 1) * gap) / count` exactly when `paddingInner = gap * count / (length + gap)`.
 * That is the CSS grid formula the old solver used, restated in d3's terms.
 */
function seamPaddingInner(length: number, count: number, gapPx: number): number {
	return clamp01((gapPx * count) / (length + gapPx))
}

/** The pixel length a grid of `count` capped cells wants, seams included. */
function cappedGridLength(count: number, maxCellPx: number, gapPx: number): number {
	return count * maxCellPx + Math.max(0, count - 1) * gapPx
}

/**
 * Solve the whole layout — gutter, margins, band padding — in one pass.
 *
 * Pure, and exported for its own tests: every number here is a pixel the chart
 * cannot assert on from the outside, because jsdom lays nothing out.
 */
export function solveHeatmapLayout(input: HeatmapLayoutInput): HeatmapLayout {
	const { containerW, containerH, columns, rows, longestYLabelChars, hasFootnote } = input

	const gutter = clamp(longestYLabelChars * Y_LABEL_CHAR_PX + Y_LABEL_INSET_PX, Y_GUTTER_MIN, Y_GUTTER_MAX)
	const yLabelChars = Math.max(1, Math.floor((gutter - Y_LABEL_INSET_PX) / Y_LABEL_CHAR_PX))

	const chartBoxH = containerH - LEGEND_BLOCK_H - (hasFootnote ? FOOTNOTE_BLOCK_H : 0)
	const availW = containerW - gutter
	const availH = chartBoxH - PLOT_TOP_PAD - X_AXIS_BAND_PX

	if (!(availW > 0) || !(availH > 0) || columns <= 0 || rows <= 0) {
		return {
			margin: null,
			paddingInnerX: UNMEASURED_PADDING_INNER,
			paddingInnerY: UNMEASURED_PADDING_INNER,
			radius: 2,
			gutter,
			rightInset: 0,
			yLabelChars,
		}
	}

	// The seam width depends on the cell size, which depends on the seam width.
	// The old solver ran the whole layout twice to break that; here the first pass
	// only needs a cell size, so it is one division rather than one layout.
	const roughW = Math.min(availW / columns, MAX_CELL_W)
	const roughH = Math.min(availH / rows, MAX_CELL_H)
	const gap =
		roughW >= TIGHT_CELL_THRESHOLD && roughH >= TIGHT_CELL_THRESHOLD ? CELL_GAP_WIDE : CELL_GAP_TIGHT

	const gridW = Math.min(availW, cappedGridLength(columns, MAX_CELL_W, gap))
	const gridH = Math.min(availH, cappedGridLength(rows, MAX_CELL_H, gap))

	const cellW = (gridW - Math.max(0, columns - 1) * gap) / columns
	const cellH = (gridH - Math.max(0, rows - 1) * gap) / rows

	return {
		// Top-anchored, left-anchored: the surplus a capped grid leaves goes to the
		// right and the bottom, where it pushes nothing.
		margin: {
			top: PLOT_TOP_PAD,
			right: Math.max(0, containerW - gutter - gridW),
			bottom: Math.max(X_AXIS_BAND_PX, chartBoxH - PLOT_TOP_PAD - gridH),
			left: gutter,
		},
		paddingInnerX: seamPaddingInner(gridW, columns, gap),
		paddingInnerY: seamPaddingInner(gridH, rows, gap),
		radius: cellW >= 10 && cellH >= 10 ? 2 : 1,
		gutter,
		rightInset: Math.max(0, containerW - gutter - gridW),
		yLabelChars,
	}
}

/** Ellipsise a y label into the characters the bounded gutter can show. */
export function truncateYLabel(label: string, maxChars: number): string {
	if (label.length <= maxChars) return label
	// One character of the budget is the ellipsis itself.
	return `${label.slice(0, Math.max(1, maxChars - 1))}…`
}

// ──────────────────────────────────────────────────────────────────────────────
// Legend
// ──────────────────────────────────────────────────────────────────────────────

const LEGEND_STEPS = 5
const LEGEND_BAR_H = 8
const LEGEND_FONT_PX = 10

interface HeatmapLegendProps {
	domain: readonly [number, number]
	span: number
	scaleType: HeatmapScaleType
	colorAt: (value: number) => string
	unit?: string
	/** The hovered cell's value, or `null` — drives the position marker. */
	hovered: number | null
	/**
	 * The plot's own left and right insets, so the stepped bar spans exactly the
	 * columns. `PlotFrame`'s legend slot is full-bleed, so without these the bar
	 * starts under the y gutter and runs past the last column — and a legend that
	 * does not line up with the grid reads as a second, unrelated scale.
	 */
	insetLeft: number
	insetRight: number
}

/**
 * Discrete steps rather than a gradient bar.
 *
 * A gradient implies a linear position→value mapping, which is a lie under a log
 * scale; five swatches plus values read back through `valueAtRampPosition` stay
 * honest under both. This is also why the package's own `colorGradientLegend` is
 * not used: it walks the domain LINEARLY and samples the ramp at each value, so
 * under `scaleType="log"` it would show the log-warped ramp against a linear
 * value axis, and it offers no hook to supply tick positions.
 *
 * DOM rather than a mark, in `PlotFrame`'s `legend` slot, for the same reason
 * every other chart's legend is: it is chrome around the plot, not part of it.
 */
function HeatmapLegend({
	domain,
	span,
	scaleType,
	colorAt,
	unit,
	hovered,
	insetLeft,
	insetRight,
}: HeatmapLegendProps) {
	const ticks: ReadonlyArray<{ t: number; anchor: "start" | "middle" | "end" }> =
		span <= 0
			? [{ t: 0, anchor: "start" }]
			: [
					{ t: 0, anchor: "start" },
					{ t: 0.5, anchor: "middle" },
					{ t: 1, anchor: "end" },
				]

	return (
		// The height is FIXED, not intrinsic: `solveHeatmapLayout` subtracts this
		// strip from the container to get the chart box, and an intrinsic height
		// would make that arithmetic a guess.
		<div
			data-heatmap-legend=""
			className="pt-2"
			style={{ height: LEGEND_BLOCK_H, paddingLeft: insetLeft, paddingRight: insetRight }}
		>
			<div className="relative flex gap-px" style={{ height: LEGEND_BAR_H }}>
				{Array.from({ length: LEGEND_STEPS }).map((_, index) => (
					<div
						key={index}
						className="flex-1 rounded-[2px]"
						style={{
							backgroundColor: colorAt(
								valueAtRampPosition((index + 0.5) / LEGEND_STEPS, domain, scaleType),
							),
						}}
					/>
				))}
				{hovered !== null && (
					<div
						aria-hidden
						className="pointer-events-none absolute"
						style={{
							left: `${rampPositionOf(hovered, domain, scaleType) * 100}%`,
							top: -1,
							width: 1,
							height: LEGEND_BAR_H + 2,
							background: "var(--foreground)",
						}}
					/>
				)}
			</div>
			<div className="relative mt-1.5" style={{ height: 12 }}>
				{ticks.map(({ t, anchor }) => (
					<div
						key={t}
						className="absolute tabular-nums text-muted-foreground"
						style={{
							left: `${t * 100}%`,
							transform:
								anchor === "start"
									? "translateX(0)"
									: anchor === "end"
										? "translateX(-100%)"
										: "translateX(-50%)",
							fontSize: LEGEND_FONT_PX,
							lineHeight: 1,
						}}
					>
						{formatScalar(
							roundTick(valueAtRampPosition(t, domain, scaleType), domain[0], span),
							unit,
						)}
					</div>
				))}
			</div>
		</div>
	)
}

// ──────────────────────────────────────────────────────────────────────────────
// Chart
// ──────────────────────────────────────────────────────────────────────────────

/** Everything not the hovered cell recedes to this. */
const UNMATCHED_OPACITY = 0.28

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

export function QueryBuilderHeatmapChart({
	data,
	className,
	tooltip: tooltipMode,
	unit,
	colorScale,
	scaleType = "linear",
}: QueryBuilderHeatmapChartProps) {
	const source = Array.isArray(data) ? data : EMPTY_ROWS
	const points = React.useMemo(() => deriveHeatmapPoints(source), [source])
	const model = React.useMemo(() => buildModel(points), [points])

	const ramp = usePlotColors(RAMP_STOP_TOKENS)
	const chrome = usePlotColors(HEATMAP_CHROME_TOKENS)

	const requested = colorScale ?? DEFAULT_HEATMAP_COLOR_SCALE
	const paletteKey = isKnownColorScale(requested) ? requested : DEFAULT_HEATMAP_COLOR_SCALE
	const stops = React.useMemo(() => rampStopsFor(paletteKey, ramp), [paletteKey, ramp])

	const colors = React.useMemo(
		() => createSequentialColorScale({ stops, domain: model.domain, scaleType }),
		[stops, model.domain, scaleType],
	)

	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const { width, height } = useContainerSize(containerRef)

	const allYIso = React.useMemo(() => model.yDomain.every((v) => ISO_RE.test(v)), [model.yDomain])

	// Pruned axes are reported, never dropped silently — otherwise a trimmed grid
	// reads as the whole result. Resolved before the layout because the strip it
	// occupies is height the plot does not get.
	const footnote =
		model.hiddenX > 0 || model.hiddenY > 0
			? [
					model.hiddenX > 0 ? pluralize(model.hiddenX, "empty column") : null,
					model.hiddenY > 0 ? pluralize(model.hiddenY, "empty row") : null,
				]
					.filter(Boolean)
					.join(" · ") + " hidden"
			: null

	const longestYLabelChars = React.useMemo(
		() =>
			model.yDomain.reduce(
				(longest, value) => Math.max(longest, shortenYLabel(value, allYIso).length),
				0,
			),
		[model.yDomain, allYIso],
	)

	const layout = React.useMemo(
		() =>
			solveHeatmapLayout({
				containerW: width,
				containerH: height,
				columns: model.xDomain.length,
				rows: model.yDomain.length,
				longestYLabelChars,
				hasFootnote: footnote !== null,
			}),
		[width, height, model.xDomain.length, model.yDomain.length, longestYLabelChars, footnote],
	)

	/**
	 * The hovered cell's value, for the legend's position marker.
	 *
	 * React state on a hover path is only affordable because `onFocusChange` is
	 * EDGE-triggered — it fires when the focused datum changes, not on every
	 * pointer tick. The chart definition deliberately does not depend on it, so a
	 * crossing re-renders the legend marker and rebuilds no scene.
	 */
	const [hovered, setHovered] = React.useState<number | null>(null)
	const handleFocusChange = React.useCallback((point: ChartPoint<HeatmapSlot, string, string> | null) => {
		setHovered(point?.datum.value ?? null)
	}, [])

	const definition = React.useMemo(() => {
		const { radius } = layout

		/**
		 * The hover cascade, shared by BOTH marks.
		 *
		 * `states` on the cells alone left the grout holes at full strength while
		 * every non-cross cell dropped to `UNMATCHED_OPACITY`, so hovering made the
		 * empty slots the brightest thing on the grid — and a focused hole drew no
		 * ring at all. The holes are data (see `HeatmapSlot`), so they take part in
		 * the cascade like data.
		 *
		 * `when` is a SELECTOR OBJECT, not a state name. `focus: "unmatched"` is
		 * undocumented and is the one that matters — it resolves to
		 * `!matches("group")`, i.e. every cell that is not the focused one — while
		 * `"x"`/`"y"` compare the focused point's band values. States apply in array
		 * order and merge, so this reads literally: dim the field, restore the cross,
		 * ring the cell.
		 *
		 * The grid this replaced painted two additive 10%-foreground bands and dimmed
		 * nothing. Subtraction reads better on a grid where every cell already
		 * carries colour, and it needs no hit-test arithmetic at all.
		 */
		const focusStates = [
			{ when: { focus: "unmatched" }, style: { opacity: UNMATCHED_OPACITY } },
			{ when: { focus: "x" }, style: { opacity: 1 } },
			{ when: { focus: "y" }, style: { opacity: 1 } },
			{
				when: { focus: "primary" },
				// Ring only — geometry deliberately fixed. The old grid drew
				// `0 0 0 1.5px var(--foreground)` OUTSIDE the cell, where an SVG stroke is
				// centred on the edge, so ~0.75px of this one lands on the data. Growing
				// the cell into its seam to win that back arrives as an instant 1px jump
				// per side, which reads as the grid twitching rather than as feedback:
				// `states[].transition` is applied BY the motion renderer, which is
				// SVG-only and creates no track for `cell` at 0.14.0.
				// `ChartRectStateStyle` also omits `strokeOpacity`, so softening the ring
				// is not available either.
				style: { stroke: chrome.foreground, strokeWidth: 1.5 },
			},
		] as const

		/**
		 * Grout is per-SLOT rather than one panel behind the plot, and that is a
		 * package limit rather than a preference. Two routes to a full-plot track
		 * were tried at 0.14.0 and neither works: a `rect` with
		 * `x1: firstCategory, x2: lastCategory` spans centre-to-centre (a band
		 * scale's `map()` returns the band CENTRE), so it paints as a slab offset
		 * into the grid, and `inset` cannot correct it because the missing bleed is
		 * half a band per axis while `inset` is one number for all four sides; a
		 * `rect` with the extent channels omitted emits no node at all.
		 *
		 * What survives is the half that carries meaning: an empty slot reads as a
		 * hole in a surface rather than as absence, and it is focusable.
		 */
		const holes = cell(model.holes, {
			x: (slot: HeatmapSlot) => slot.x,
			y: (slot: HeatmapSlot) => slot.y,
			fill: chrome.grout,
			radius,
			states: focusStates,
		})

		const cells = cell(model.cells, {
			x: (slot: HeatmapSlot) => slot.x,
			y: (slot: HeatmapSlot) => slot.y,
			// The ONLY per-datum colour route on a rect mark: `RectOptions.fill` is
			// a flat `string`, not a `VisualChannel`, so colour has to travel
			// through the `color` channel and the chart-level colour scale.
			color: (slot: HeatmapSlot) => slot.value,
			radius,
			states: focusStates,
		})

		return defineChart({
			// Paint order is mark order: grout slots first, the data over them.
			marks: [holes, cells],
			// The plot rect, pinned. See `HeatmapLayout.margin`: `null` before the
			// first measurement, where the scene's automatic margins are the better
			// answer anyway.
			margin: layout.margin ?? undefined,
			x: {
				// A pinned INSTANCE, not the bare factory: an inferred domain drops a
				// fully-empty column, turning a hole into a missing axis slot.
				//
				// No `paddingOuter`: the plot rect is already the grid, so there is no
				// surplus left inside it to buy back.
				scale: scaleBand<string>(model.xDomain, [0, 1]).paddingInner(layout.paddingInnerX),
				grid: false,
				axis: {
					line: false,
					// No `spacing`/`count` policy: a band scale has no `ticks()`, so
					// every category is a candidate and the axis thins them by MEASURED
					// label collision, keeping the ends first on a categorical x. That
					// is what the old `pickXTicks` stride approximated with a
					// characters-times-6.3px estimate.
					ticks: { size: 0, padding: 6 },
				},
			},
			y: {
				scale: scaleBand<string>(model.yDomain, [0, 1]).paddingInner(layout.paddingInnerY),
				grid: false,
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 6,
						// An all-ISO y axis is a time axis wearing timestamps; only the
						// clock time distinguishes the rows, and the date repeated down
						// the axis costs the width every label has to fit in. The
						// truncation is what makes the locked `margin.left` safe — the
						// axis would otherwise measure the full string and want a gutter
						// it is not going to get.
						format: (value: string) =>
							truncateYLabel(shortenYLabel(value, allYIso), layout.yLabelChars),
					},
					// `thinTickLabels` only prioritises the ends automatically for a
					// categorical X, so a y axis was thinned middle-out and could drop the
					// first and last ROW labels — the two that say what the axis spans.
					tickLabels: { thin: { priority: "ends" } },
				},
			},
			color: { scale: colors },
			focus: "nearest",
			focusRing: false,
			// Suppression omits the tooltip from the spec rather than rendering an
			// empty body: returning `null` from `renderTooltipBody` still paints the
			// shell, so an empty card would follow the cursor.
			tooltip:
				tooltipMode === "hidden"
					? false
					: {
							use: tooltip,
							className: "maple-plot-tooltip",
							// Anchored to the CELL, as the old floating tooltip was: the
							// default "point" anchor resolves to the datum's plotted
							// position, which for a cell is its centre.
							anchor: "point",
							placement: "top",
							offset: 6,
						},
		})
	}, [model, layout, colors, chrome, allYIso, tooltipMode])

	// Empty state — a quiet placeholder with a tiny suggestive grid. A chart over
	// an empty domain is not worth mounting; it would draw axes for nothing.
	if (model.xDomain.length === 0 || model.yDomain.length === 0) {
		return (
			<div ref={containerRef} className={cn("relative h-full w-full", className)}>
				<div className="absolute inset-0 grid place-items-center">
					<div className="flex flex-col items-center gap-2.5">
						<div
							className="grid grid-cols-8 gap-[2px] rounded-[4px] p-[3px]"
							style={{ background: chrome.grout }}
						>
							{Array.from({ length: 32 }).map((_, i) => (
								<div
									key={i}
									className="size-1.5 rounded-[1px]"
									style={{
										// Three tinted cells so the placeholder still reads as a
										// heatmap rather than graph paper.
										background:
											i === 11
												? ramp.amber1
												: i === 12
													? ramp.amber3
													: i === 20
														? ramp.amber2
														: "color-mix(in oklch, var(--foreground) 8%, transparent)",
									}}
								/>
							))}
						</div>
						<div className="text-[11px] text-muted-foreground">No data</div>
					</div>
				</div>
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			className={cn("relative h-full w-full select-none", className)}
			style={{ animation: "tile-in 0.35s ease both" }}
		>
			<PlotFrame
				className="h-full w-full"
				ariaLabel="Heatmap"
				definition={definition}
				onFocusChange={handleFocusChange}
				legend={
					<HeatmapLegend
						domain={model.domain}
						span={model.span}
						scaleType={scaleType}
						colorAt={colors}
						unit={unit}
						hovered={hovered}
						insetLeft={layout.gutter}
						insetRight={layout.rightInset}
					/>
				}
				// Pruned axes are reported, never dropped silently — otherwise a
				// trimmed grid reads as the whole result. Right-aligned to the grid's
				// last column, and a FIXED height for the same reason the legend has
				// one: `solveHeatmapLayout` subtracts this strip from the container.
				footer={
					footnote ? (
						<p
							className="pt-1 text-right text-[10px] leading-[12px] tabular-nums text-muted-foreground/70"
							style={{
								height: FOOTNOTE_BLOCK_H,
								paddingLeft: layout.gutter,
								paddingRight: layout.rightInset,
							}}
						>
							{footnote}
						</p>
					) : null
				}
				renderTooltipBody={({ points: focused }) => {
					const slot = focused[0]?.datum
					if (!slot) return null
					return (
						<>
							<div className="text-muted-foreground">
								<span>{slot.x}</span>
								<span className="px-1 text-muted-foreground/50">·</span>
								<span>{slot.y}</span>
							</div>
							<div className="mt-1 flex items-center gap-1.5">
								{/*
								 * A hole carries no value. Distinguishing it here is the point
								 * of giving holes their own datum: without it `focus: "nearest"`
								 * would report a neighbouring cell's count for an empty slot.
								 */}
								{slot.value === null ? (
									<span className="italic text-muted-foreground">no data</span>
								) : (
									<>
										<span
											className="size-2 shrink-0 rounded-[2px]"
											style={{ backgroundColor: colors(slot.value) }}
										/>
										<span className="font-medium tabular-nums text-foreground">
											{formatScalar(slot.value, unit)}
										</span>
									</>
								)}
							</div>
						</>
					)
				}}
			/>
		</div>
	)
}
