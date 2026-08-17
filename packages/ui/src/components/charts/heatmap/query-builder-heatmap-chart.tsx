import * as React from "react"

import type { HeatmapColorScale } from "@maple/domain/http"
import type { BaseChartProps } from "../_shared/chart-types"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { useContainerSize } from "../../../hooks/use-container-size"
import { cn } from "../../../lib/utils"
import { ChartFloatingTooltip } from "../../ui/chart"

interface HeatmapPoint {
	x: string
	y: string
	value: number
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
 * Five-stop sequential palettes. The stops themselves live in `tokens.css` as
 * `--heatmap-<name>-0..4` so they can differ per theme — each ramp is anchored
 * just above the local card surface and climbs to a saturated hot end, which
 * means the whole ramp inverts between light and dark. Interpolation happens via
 * CSS `color-mix(in oklch, …)`, so a value at t=0.4 actually *looks* 40% of the
 * way along, not just numerically.
 */
const COLOR_SCALES: Record<HeatmapColorScale, readonly string[]> = {
	amber: [
		"var(--heatmap-amber-0)",
		"var(--heatmap-amber-1)",
		"var(--heatmap-amber-2)",
		"var(--heatmap-amber-3)",
		"var(--heatmap-amber-4)",
	],
	blues: [
		"var(--heatmap-blues-0)",
		"var(--heatmap-blues-1)",
		"var(--heatmap-blues-2)",
		"var(--heatmap-blues-3)",
		"var(--heatmap-blues-4)",
	],
	reds: [
		"var(--heatmap-reds-0)",
		"var(--heatmap-reds-1)",
		"var(--heatmap-reds-2)",
		"var(--heatmap-reds-3)",
		"var(--heatmap-reds-4)",
	],
	viridis: [
		"var(--heatmap-viridis-0)",
		"var(--heatmap-viridis-1)",
		"var(--heatmap-viridis-2)",
		"var(--heatmap-viridis-3)",
		"var(--heatmap-viridis-4)",
	],
	magma: [
		"var(--heatmap-magma-0)",
		"var(--heatmap-magma-1)",
		"var(--heatmap-magma-2)",
		"var(--heatmap-magma-3)",
		"var(--heatmap-magma-4)",
	],
	cividis: [
		"var(--heatmap-cividis-0)",
		"var(--heatmap-cividis-1)",
		"var(--heatmap-cividis-2)",
		"var(--heatmap-cividis-3)",
		"var(--heatmap-cividis-4)",
	],
} satisfies Record<HeatmapColorScale, readonly string[]>

const DEFAULT_COLOR_SCALE: HeatmapColorScale = "amber"

function clamp(value: number, lo: number, hi: number): number {
	if (!Number.isFinite(value)) return lo
	return Math.max(lo, Math.min(hi, value))
}

function clamp01(value: number): number {
	return clamp(value, 0, 1)
}

/**
 * Compose a CSS color at parametric position t (0..1) along a palette by
 * mixing the two flanking stops in OKLCH. Falls back to endpoints at the
 * boundaries to avoid `color-mix` rounding shenanigans.
 */
function colorForT(t: number, palette: readonly string[]): string {
	const clamped = clamp01(t)
	if (clamped <= 0) return palette[0]
	if (clamped >= 1) return palette[palette.length - 1]
	const segments = palette.length - 1
	const idx = clamped * segments
	const lo = Math.floor(idx)
	const hi = Math.min(palette.length - 1, lo + 1)
	const local = idx - lo
	const loPct = ((1 - local) * 100).toFixed(2)
	const hiPct = (local * 100).toFixed(2)
	return `color-mix(in oklch, ${palette[lo]} ${loPct}%, ${palette[hi]} ${hiPct}%)`
}

function normalize(value: number, min: number, span: number, scaleType: "linear" | "log"): number {
	if (span <= 0) return 0
	if (scaleType === "log") {
		const denom = Math.log1p(span)
		return denom > 0 ? Math.log1p(Math.max(0, value - min)) / denom : 0
	}
	return (value - min) / span
}

/**
 * Inverse of `normalize` — the data value that lands at parametric position t.
 * The legend needs this: with a log scale the midpoint *swatch* is not the
 * midpoint *value*, and labelling it as though it were is what made the old
 * gradient bar lie about log-scaled grids.
 */
function valueAtT(t: number, min: number, span: number, scaleType: "linear" | "log"): number {
	if (span <= 0) return min
	if (scaleType === "log") return min + Math.expm1(t * Math.log1p(span))
	return min + t * span
}

function formatScalar(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

/**
 * Legend ticks between the endpoints are interpolated, so they land on values
 * the data never contains — under a log scale the midpoint of 15..103 is
 * 23.434…, which is noise dressed up as precision. Snap to the data's own
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

/**
 * Pick x-axis tick indices using a fixed STRIDE guaranteed to give each
 * label `minLabelPx` of horizontal room. First and last index are always
 * included so the axis range is clearly bounded; intermediate picks step by
 * `stride` from index 0. A trailing pick is dropped if it would land within
 * one stride of `count - 1` (which we always append).
 */
function pickXTicks(count: number, cellStridePx: number, minLabelPx: number): number[] {
	if (count <= 0) return []
	if (count === 1) return [0]
	const stride = Math.max(1, Math.ceil(minLabelPx / cellStridePx))
	// Endpoints only — even one intermediate would crowd the axis.
	if (stride * 2 > count - 1) return [0, count - 1]
	const out: number[] = [0]
	for (let i = stride; i < count - stride; i += stride) out.push(i)
	out.push(count - 1)
	return out
}

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

const X_AXIS_H = 20
const LEGEND_HEIGHT = 24
const GAP_GRID_TO_LEGEND = 8
const PLOT_PAD_X = 6
const PLOT_PAD_TOP = 2
const PLOT_PAD_BOTTOM = 4

const MIN_CELL = 6
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

const LABEL_FONT_PX = 11
const LEGEND_FONT_PX = 10
const LABEL_CHAR_PX = 6.3 // tabular-nums approximation at 11px
const LABEL_GUTTER_PX = 6
const Y_LABEL_MIN_PX = 36
const Y_LABEL_MAX_PX = 96

// Minimum vertical room each y-label needs to avoid stacking neighbours.
const Y_LABEL_MIN_VERTICAL_PX = 16

const LEGEND_STEPS = 5
const LEGEND_BAR_H = 8
const TOOLTIP_OFFSET = 6
// Only reserved when something was actually pruned.
const FOOTNOTE_H = 13

const TRACK_BG = "var(--heatmap-grout)"
// The bands sit *over* saturated cells, so a token 5% wash vanishes against
// them. 10% registers as a crosshair without washing the colours out.
const CROSSHAIR_BG = "color-mix(in oklch, var(--foreground) 10%, transparent)"

interface HoverState {
	xIdx: number
	yIdx: number
	/** False while fading out after pointer-leave — keeps the last position so
	 *  the crosshair dissolves in place instead of snapping to a corner. */
	active: boolean
}

interface LayoutResult {
	cellW: number
	cellH: number
	gap: number
	radius: number
	gridW: number
	gridH: number
	yLabelW: number
	xTickIndices: number[]
	yTickIndices: number[]
	gridOffsetX: number
}

function layoutForGap(
	containerW: number,
	containerH: number,
	xValues: string[],
	yValues: string[],
	allYIso: boolean,
	gap: number,
	footnoteH: number,
): LayoutResult | null {
	const longestYChars = yValues.reduce((m, v) => Math.max(m, shortenYLabel(v, allYIso).length), 0)
	const yLabelW = clamp(longestYChars * LABEL_CHAR_PX + 10, Y_LABEL_MIN_PX, Y_LABEL_MAX_PX)

	// The grid sits inside a track whose padding equals the seam width, so the
	// outer cells get the same breathing room as the inner ones.
	const availW = containerW - yLabelW - PLOT_PAD_X * 2 - gap * 2
	if (availW <= 0) return null

	const naturalCellW = (availW - (xValues.length - 1) * gap) / xValues.length
	const cellW = clamp(Math.floor(naturalCellW), MIN_CELL, MAX_CELL_W)

	const availH =
		containerH -
		X_AXIS_H -
		LEGEND_HEIGHT -
		GAP_GRID_TO_LEGEND -
		PLOT_PAD_TOP -
		PLOT_PAD_BOTTOM -
		gap * 2 -
		footnoteH
	if (availH <= 0) return null

	const naturalCellH = (availH - (yValues.length - 1) * gap) / yValues.length
	const cellH = clamp(Math.floor(naturalCellH), MIN_CELL, MAX_CELL_H)

	const gridW = xValues.length * cellW + (xValues.length - 1) * gap
	const gridH = yValues.length * cellH + (yValues.length - 1) * gap

	// Center the grid horizontally when the cell width is capped.
	const gridOffsetX = Math.max(0, Math.floor((availW - gridW) / 2))

	// X-tick density — guaranteed non-overlap via stride-based picking.
	const longestXChars = xValues.reduce((m, v) => Math.max(m, v.length), 0)
	const longestXPx = longestXChars * LABEL_CHAR_PX
	const xTickIndices = pickXTicks(xValues.length, cellW + gap, longestXPx + LABEL_GUTTER_PX)

	// Y-tick density. Aim for >= Y_LABEL_MIN_VERTICAL_PX between visible labels.
	const yStride = cellH + gap
	const yTickStep = Math.max(1, Math.ceil(Y_LABEL_MIN_VERTICAL_PX / yStride))
	const yTickIndices: number[] = []
	for (let i = 0; i < yValues.length; i += yTickStep) yTickIndices.push(i)
	// Always label the last row, but drop the previous pick if the two would
	// land within one step of each other (they'd visually collide).
	const lastPicked = yTickIndices[yTickIndices.length - 1]
	if (lastPicked !== yValues.length - 1) {
		if (yValues.length - 1 - lastPicked < yTickStep) yTickIndices.pop()
		yTickIndices.push(yValues.length - 1)
	}

	return {
		cellW,
		cellH,
		gap,
		radius: cellW >= 10 && cellH >= 10 ? 2 : 1,
		gridW,
		gridH,
		yLabelW,
		xTickIndices,
		yTickIndices,
		gridOffsetX,
	}
}

/**
 * Seam width depends on cell size, which depends on seam width — so solve it in
 * two passes: lay out with the wide seam, and if that lands on small cells, redo
 * with the tight one (which also buys those cells a pixel or two back).
 */
function computeLayout(
	containerW: number,
	containerH: number,
	xValues: string[],
	yValues: string[],
	allYIso: boolean,
	footnoteH: number,
): LayoutResult | null {
	if (containerW <= 0 || containerH <= 0) return null
	if (xValues.length === 0 || yValues.length === 0) return null

	const wide = layoutForGap(containerW, containerH, xValues, yValues, allYIso, CELL_GAP_WIDE, footnoteH)
	if (!wide) return null
	if (wide.cellW >= TIGHT_CELL_THRESHOLD && wide.cellH >= TIGHT_CELL_THRESHOLD) return wide

	return layoutForGap(containerW, containerH, xValues, yValues, allYIso, CELL_GAP_TIGHT, footnoteH) ?? wide
}

// ──────────────────────────────────────────────────────────────────────────────
// Cell grid. Memoized and completely hover-unaware: focus is drawn by overlays
// on top, so sweeping the pointer across a 500-cell grid repaints three small
// divs instead of restyling every cell.
// ──────────────────────────────────────────────────────────────────────────────

interface CellGridProps {
	xValues: string[]
	yValues: string[]
	lookup: Map<string, number>
	min: number
	span: number
	scaleType: "linear" | "log"
	palette: readonly string[]
	cellW: number
	cellH: number
	gap: number
	radius: number
}

const CellGrid = React.memo(function CellGrid({
	xValues,
	yValues,
	lookup,
	min,
	span,
	scaleType,
	palette,
	cellW,
	cellH,
	gap,
	radius,
}: CellGridProps) {
	return (
		<div
			className="grid"
			style={{
				gridTemplateColumns: `repeat(${xValues.length}, ${cellW}px)`,
				gridTemplateRows: `repeat(${yValues.length}, ${cellH}px)`,
				gap: `${gap}px`,
				// Hit-testing is arithmetic on the wrapper, so the cells never need
				// to be pointer targets themselves.
				pointerEvents: "none",
			}}
		>
			{yValues.flatMap((y) =>
				xValues.map((x) => {
					const key = `${x}::${y}`
					const value = lookup.get(key)
					return (
						<div
							key={key}
							style={{
								// Missing cells stay transparent so the track reads through
								// them — a hole, visibly different from a min-value cell.
								backgroundColor:
									value === undefined
										? undefined
										: colorForT(normalize(value, min, span, scaleType), palette),
								borderRadius: radius,
							}}
						/>
					)
				}),
			)}
		</div>
	)
})

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

export function QueryBuilderHeatmapChart({ data, className, tooltip, unit, heatmap }: BaseChartProps) {
	const source = Array.isArray(data) ? data : EMPTY_ROWS
	const points = React.useMemo(() => deriveHeatmapPoints(source), [source])

	// Axis entries where every cell is absent or zero carry no information, but
	// they still claim a full row/column — on a service grid that is routinely
	// most of the plot, and it reads as a broken chart rather than a quiet one.
	// Drop them, and report the count rather than hiding data silently.
	const { xValues, yValues, hiddenX, hiddenY } = React.useMemo(() => {
		const xs = Array.from(new Set(points.map((p) => p.x)))
		const ys = Array.from(new Set(points.map((p) => p.y)))

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
		if (keptX.length === 0 || keptY.length === 0) {
			return { xValues: xs, yValues: ys.reverse(), hiddenX: 0, hiddenY: 0 }
		}

		return {
			xValues: keptX,
			yValues: keptY.reverse(),
			hiddenX: xs.length - keptX.length,
			hiddenY: ys.length - keptY.length,
		}
	}, [points])

	const lookup = React.useMemo(() => {
		const map = new Map<string, number>()
		for (const point of points) {
			map.set(`${point.x}::${point.y}`, point.value)
		}
		return map
	}, [points])

	const { min, span } = React.useMemo(() => {
		if (points.length === 0) return { min: 0, span: 0 }
		let lo = Number.POSITIVE_INFINITY
		let hi = Number.NEGATIVE_INFINITY
		for (const p of points) {
			if (p.value < lo) lo = p.value
			if (p.value > hi) hi = p.value
		}
		return { min: lo, span: hi - lo }
	}, [points])

	const scaleType = heatmap?.scaleType ?? "linear"
	const palette = COLOR_SCALES[heatmap?.colorScale ?? DEFAULT_COLOR_SCALE] ?? COLOR_SCALES.amber

	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const { width, height } = useContainerSize(containerRef)

	const allYIso = React.useMemo(() => yValues.every((v) => ISO_RE.test(v)), [yValues])

	const footnote =
		hiddenX > 0 || hiddenY > 0
			? [
					hiddenX > 0 ? `${hiddenX} empty ${hiddenX === 1 ? "column" : "columns"}` : null,
					hiddenY > 0 ? `${hiddenY} empty ${hiddenY === 1 ? "row" : "rows"}` : null,
				]
					.filter(Boolean)
					.join(" · ") + " hidden"
			: null

	const layout = React.useMemo(
		() =>
			computeLayout(
				Math.floor(width),
				Math.floor(height),
				xValues,
				yValues,
				allYIso,
				footnote ? FOOTNOTE_H : 0,
			),
		[width, height, xValues, yValues, allYIso, footnote],
	)

	const [hover, setHover] = React.useState<HoverState | null>(null)

	// The tooltip anchors to the hovered cell's box (see `gridRef` below), so its
	// own dimensions no longer need measuring — floating-ui flips and shifts it
	// against the window.
	const gridRef = React.useRef<HTMLDivElement | null>(null)

	// Empty state — a quiet placeholder with a tiny suggestive grid.
	if (xValues.length === 0 || yValues.length === 0) {
		return (
			<div ref={containerRef} className={cn("relative h-full w-full", className)}>
				<div className="absolute inset-0 grid place-items-center">
					<div className="flex flex-col items-center gap-2.5">
						<div
							className="grid grid-cols-8 gap-[2px] p-[3px]"
							style={{ background: TRACK_BG, borderRadius: 4 }}
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
												? "var(--heatmap-amber-1)"
												: i === 12
													? "var(--heatmap-amber-3)"
													: i === 20
														? "var(--heatmap-amber-2)"
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

	if (!layout) {
		return <div ref={containerRef} className={cn("relative h-full w-full", className)} />
	}

	const { cellW, cellH, gap, radius, gridW, gridH, yLabelW, xTickIndices, yTickIndices, gridOffsetX } =
		layout

	const xStride = cellW + gap
	const yStride = cellH + gap
	const colLeft = (xi: number) => xi * xStride
	const rowTop = (yi: number) => yi * yStride
	const colCenterX = (xi: number) => colLeft(xi) + cellW / 2
	const rowCenterY = (yi: number) => rowTop(yi) + cellH / 2

	const hoverValue =
		hover && hover.active ? lookup.get(`${xValues[hover.xIdx]}::${yValues[hover.yIdx]}`) : undefined

	// Legend: discrete steps rather than a gradient bar. A gradient implies a
	// linear position→value mapping, which is a lie under a log scale; five
	// swatches plus values read from `valueAtT` stay honest under both.
	const legendTicks: Array<{ t: number; anchor: "start" | "middle" | "end" }> =
		span <= 0
			? [{ t: 0, anchor: "start" }]
			: [
					{ t: 0, anchor: "start" },
					{ t: 0.5, anchor: "middle" },
					{ t: 1, anchor: "end" },
				]

	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const xIdx = clamp(Math.floor(event.nativeEvent.offsetX / xStride), 0, xValues.length - 1)
		const yIdx = clamp(Math.floor(event.nativeEvent.offsetY / yStride), 0, yValues.length - 1)
		setHover((prev) =>
			prev && prev.active && prev.xIdx === xIdx && prev.yIdx === yIdx
				? prev
				: { xIdx, yIdx, active: true },
		)
	}

	// Keep the last cell on pointer-leave so the crosshair fades in place.
	const handlePointerLeave = () => setHover((prev) => (prev ? { ...prev, active: false } : null))

	const plotLeft = yLabelW + gridOffsetX
	const trackW = gridW + gap * 2
	const trackH = gridH + gap * 2
	const belowTrack = trackH

	return (
		<div ref={containerRef} className={cn("relative h-full w-full select-none", className)}>
			<div
				className="absolute inset-0"
				style={{
					padding: `${PLOT_PAD_TOP}px ${PLOT_PAD_X}px ${PLOT_PAD_BOTTOM}px ${PLOT_PAD_X}px`,
					animation: "tile-in 0.35s ease both",
				}}
			>
				{/* Plot column: cell grid + x-axis + legend, stacked. */}
				<div className="relative h-full w-full">
					{/* Y-axis labels — anchored to row centers so the axis stays
					    aligned with the cell grid regardless of row stride. */}
					<div
						className="absolute"
						style={{ left: gridOffsetX, top: gap, width: yLabelW, height: gridH }}
					>
						{yTickIndices.map((yi) => {
							const raw = yValues[yi]
							const label = shortenYLabel(raw, allYIso)
							const isActive = hover?.active && hover.yIdx === yi
							return (
								<div
									key={raw}
									title={raw}
									className={cn(
										"absolute right-0 truncate text-right tabular-nums transition-colors duration-100",
										isActive ? "font-medium text-foreground" : "text-muted-foreground",
									)}
									style={{
										top: rowCenterY(yi),
										transform: "translateY(-50%)",
										paddingRight: LABEL_GUTTER_PX,
										width: yLabelW,
										fontSize: LABEL_FONT_PX,
										lineHeight: 1,
									}}
								>
									{label}
								</div>
							)
						})}
					</div>

					{/* Track — a recessed surface behind the grid, so gaps and missing
					    cells read as holes in something rather than bare canvas. */}
					<div
						className="absolute top-0"
						style={{
							left: plotLeft,
							width: trackW,
							height: trackH,
							padding: gap,
							background: TRACK_BG,
							borderRadius: 4,
						}}
					>
						<div
							ref={gridRef}
							className="relative"
							style={{ width: gridW, height: gridH }}
							onPointerMove={handlePointerMove}
							onPointerLeave={handlePointerLeave}
						>
							<CellGrid
								xValues={xValues}
								yValues={yValues}
								lookup={lookup}
								min={min}
								span={span}
								scaleType={scaleType}
								palette={palette}
								cellW={cellW}
								cellH={cellH}
								gap={gap}
								radius={radius}
							/>

							{/* Crosshair: a row band, a column band and a ring on the cell.
							    Additive emphasis — nothing else in the grid is dimmed. */}
							{hover && (
								<>
									<div
										aria-hidden
										className="pointer-events-none absolute transition-opacity duration-100"
										style={{
											left: -gap,
											top: rowTop(hover.yIdx),
											width: gridW + gap * 2,
											height: cellH,
											background: CROSSHAIR_BG,
											borderRadius: 2,
											opacity: hover.active ? 1 : 0,
										}}
									/>
									<div
										aria-hidden
										className="pointer-events-none absolute transition-opacity duration-100"
										style={{
											left: colLeft(hover.xIdx),
											top: -gap,
											width: cellW,
											height: gridH + gap * 2,
											background: CROSSHAIR_BG,
											borderRadius: 2,
											opacity: hover.active ? 1 : 0,
										}}
									/>
									<div
										aria-hidden
										className="pointer-events-none absolute transition-opacity duration-100"
										style={{
											left: colLeft(hover.xIdx),
											top: rowTop(hover.yIdx),
											width: cellW,
											height: cellH,
											borderRadius: radius,
											boxShadow: "0 0 0 1.5px var(--foreground)",
											opacity: hover.active ? 1 : 0,
										}}
									/>
								</>
							)}

							{/*
							 * Tooltip — anchored to the hovered cell's box (the same four values
							 * the crosshair ring uses) and portalled, so it escapes the widget
							 * card's `overflow-hidden` rather than being clamped inside the grid,
							 * and so flipping lands it *below* the cell instead of over it.
							 */}
							{tooltip !== "hidden" && hover && (
								<ChartFloatingTooltip
									containerRef={gridRef}
									x={colLeft(hover.xIdx)}
									y={rowTop(hover.yIdx)}
									width={cellW}
									height={cellH}
									open={hover.active}
									side="top"
									sideOffset={TOOLTIP_OFFSET}
									className="whitespace-nowrap"
								>
									<div className="text-muted-foreground">
										<span>{xValues[hover.xIdx]}</span>
										<span className="px-1 text-muted-foreground/50">·</span>
										<span>{yValues[hover.yIdx]}</span>
									</div>
									<div className="mt-1 flex items-center gap-1.5">
										{hoverValue === undefined ? (
											<span className="italic text-muted-foreground">no data</span>
										) : (
											<>
												<span
													className="size-2 shrink-0 rounded-[2px]"
													style={{
														backgroundColor: colorForT(
															normalize(hoverValue, min, span, scaleType),
															palette,
														),
													}}
												/>
												<span className="font-medium tabular-nums text-foreground">
													{formatScalar(hoverValue, unit)}
												</span>
											</>
										)}
									</div>
								</ChartFloatingTooltip>
							)}
						</div>
					</div>

					{/* X-axis: ticks + labels, anchored under the track. */}
					<div
						className="absolute"
						style={{ left: plotLeft + gap, top: belowTrack, width: gridW, height: X_AXIS_H }}
					>
						{xTickIndices.map((xi, ti) => {
							const raw = xValues[xi]
							const isActive = hover?.active && hover.xIdx === xi
							const isFirst = ti === 0
							const isLast = ti === xTickIndices.length - 1
							return (
								<React.Fragment key={raw}>
									<div
										aria-hidden
										className="absolute"
										style={{
											left: colCenterX(xi),
											top: 0,
											width: 1,
											height: 3,
											transform: "translateX(-0.5px)",
											background: "var(--border)",
										}}
									/>
									<div
										title={raw}
										className={cn(
											"absolute whitespace-nowrap tabular-nums transition-colors duration-100",
											isActive
												? "font-medium text-foreground"
												: "text-muted-foreground",
										)}
										style={{
											left: colCenterX(xi),
											top: 5,
											transform: isFirst
												? "translateX(0)"
												: isLast
													? "translateX(-100%)"
													: "translateX(-50%)",
											fontSize: LABEL_FONT_PX,
											lineHeight: 1,
										}}
									>
										{raw}
									</div>
								</React.Fragment>
							)
						})}
					</div>

					{/* Legend — five stepped swatches plus the values at t=0/0.5/1, and
					    a marker showing where the hovered cell sits in the range. */}
					<div
						className="absolute"
						style={{
							left: plotLeft + gap,
							top: belowTrack + X_AXIS_H + GAP_GRID_TO_LEGEND,
							width: gridW,
							height: LEGEND_HEIGHT,
						}}
					>
						<div className="relative flex gap-px" style={{ height: LEGEND_BAR_H }}>
							{Array.from({ length: LEGEND_STEPS }).map((_, i) => (
								<div
									key={i}
									className="flex-1 rounded-[2px]"
									style={{
										backgroundColor: colorForT((i + 0.5) / LEGEND_STEPS, palette),
									}}
								/>
							))}
							{hoverValue !== undefined && (
								<div
									aria-hidden
									className="pointer-events-none absolute transition-opacity duration-100"
									style={{
										left: `${clamp01(normalize(hoverValue, min, span, scaleType)) * 100}%`,
										top: -1,
										width: 1,
										height: LEGEND_BAR_H + 2,
										background: "var(--foreground)",
										opacity: hover?.active ? 1 : 0,
									}}
								/>
							)}
						</div>
						<div className="relative mt-1.5" style={{ height: 12 }}>
							{legendTicks.map(({ t, anchor }) => (
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
										roundTick(valueAtT(t, min, span, scaleType), min, span),
										unit,
									)}
								</div>
							))}
						</div>
					</div>

					{/* Pruned axes are reported, never dropped silently — otherwise a
					    trimmed grid reads as the whole result. */}
					{footnote && (
						<div
							className="absolute text-right tabular-nums text-muted-foreground/70"
							style={{
								left: plotLeft + gap,
								top: belowTrack + X_AXIS_H + GAP_GRID_TO_LEGEND + LEGEND_HEIGHT,
								width: gridW,
								fontSize: LEGEND_FONT_PX,
								lineHeight: 1,
							}}
						>
							{footnote}
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
