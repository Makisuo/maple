import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { cn } from "../../../lib/utils"
import { heatmapSampleData } from "../_shared/sample-data"

interface HeatmapPoint {
	x: string
	y: string
	value: number
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function deriveHeatmapPoints(rows: Record<string, unknown>[]): HeatmapPoint[] {
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
 * Five-stop sequential palettes expressed in OKLCH for perceptually uniform
 * interpolation. We render them via CSS `color-mix(in oklch, …)` which lets
 * the engine do the lerp in perceptual space — so a value at t=0.4 actually
 * *looks* 40% of the way between coldest and hottest, not just numerically.
 */
const COLOR_SCALES: Record<string, string[]> = {
	blues: [
		"oklch(0.96 0.018 240)",
		"oklch(0.82 0.075 240)",
		"oklch(0.62 0.135 245)",
		"oklch(0.44 0.165 250)",
		"oklch(0.28 0.135 255)",
	],
	reds: [
		"oklch(0.96 0.018 25)",
		"oklch(0.84 0.085 30)",
		"oklch(0.66 0.180 30)",
		"oklch(0.48 0.190 28)",
		"oklch(0.32 0.135 25)",
	],
	viridis: [
		"oklch(0.22 0.090 295)",
		"oklch(0.42 0.115 270)",
		"oklch(0.58 0.080 195)",
		"oklch(0.76 0.150 145)",
		"oklch(0.94 0.180 105)",
	],
	magma: [
		"oklch(0.12 0.015 295)",
		"oklch(0.32 0.135 310)",
		"oklch(0.56 0.180 5)",
		"oklch(0.76 0.165 50)",
		"oklch(0.96 0.090 95)",
	],
	cividis: [
		"oklch(0.23 0.060 260)",
		"oklch(0.42 0.040 240)",
		"oklch(0.58 0.025 95)",
		"oklch(0.76 0.090 90)",
		"oklch(0.92 0.140 95)",
	],
}

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

function formatScalar(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
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
// Layout constants. Every dimension here is in CSS pixels.
// ──────────────────────────────────────────────────────────────────────────────

const CELL_GAP = 2
const X_AXIS_H = 20
const LEGEND_HEIGHT = 22
const GAP_GRID_TO_LEGEND = 8
const PLOT_PAD_X = 6
const PLOT_PAD_TOP = 2
const PLOT_PAD_BOTTOM = 4

const MIN_CELL = 6
// Upper bounds keep cells from ballooning on huge cards with tiny grids.
// Wider than tall — matches the grafana / signoz time-bucket heatmap shape.
const MAX_CELL_W = 96
const MAX_CELL_H = 64

const LABEL_FONT_PX = 11
const LABEL_CHAR_PX = 6.3 // tabular-nums approximation at 11px
const LABEL_GUTTER_PX = 6
const Y_LABEL_MIN_PX = 36
const Y_LABEL_MAX_PX = 96

// Minimum vertical room each y-label needs to avoid stacking neighbours.
const Y_LABEL_MIN_VERTICAL_PX = 13

interface HoverState {
	x: string
	y: string
	xIdx: number
	yIdx: number
	value: number | null
}

interface LayoutResult {
	cellW: number
	cellH: number
	gridW: number
	gridH: number
	yLabelW: number
	xTickIndices: number[]
	yTickIndices: number[]
	gridOffsetX: number
}

function computeLayout(
	containerW: number,
	containerH: number,
	xValues: string[],
	yValues: string[],
	allYIso: boolean,
): LayoutResult | null {
	if (containerW <= 0 || containerH <= 0) return null
	if (xValues.length === 0 || yValues.length === 0) return null

	const longestYChars = yValues.reduce(
		(m, v) => Math.max(m, shortenYLabel(v, allYIso).length),
		0,
	)
	const yLabelW = clamp(longestYChars * LABEL_CHAR_PX + 10, Y_LABEL_MIN_PX, Y_LABEL_MAX_PX)

	const availW = containerW - yLabelW - PLOT_PAD_X * 2
	if (availW <= 0) return null

	const naturalCellW = (availW - (xValues.length - 1) * CELL_GAP) / xValues.length
	const cellW = clamp(Math.floor(naturalCellW), MIN_CELL, MAX_CELL_W)

	const availH = containerH - X_AXIS_H - LEGEND_HEIGHT - GAP_GRID_TO_LEGEND - PLOT_PAD_TOP - PLOT_PAD_BOTTOM
	if (availH <= 0) return null

	const naturalCellH = (availH - (yValues.length - 1) * CELL_GAP) / yValues.length
	const cellH = clamp(Math.floor(naturalCellH), MIN_CELL, MAX_CELL_H)

	const gridW = xValues.length * cellW + (xValues.length - 1) * CELL_GAP
	const gridH = yValues.length * cellH + (yValues.length - 1) * CELL_GAP

	// Center the grid horizontally when the cell width is capped.
	const gridOffsetX = Math.max(0, Math.floor((availW - gridW) / 2))

	// X-tick density — guaranteed non-overlap via stride-based picking.
	const longestXChars = xValues.reduce((m, v) => Math.max(m, v.length), 0)
	const longestXPx = longestXChars * LABEL_CHAR_PX
	const xTickIndices = pickXTicks(xValues.length, cellW + CELL_GAP, longestXPx + LABEL_GUTTER_PX)

	// Y-tick density. Aim for >= Y_LABEL_MIN_VERTICAL_PX between visible labels.
	const yStride = cellH + CELL_GAP
	const yTickStep = Math.max(1, Math.ceil(Y_LABEL_MIN_VERTICAL_PX / yStride))
	const yTickIndices: number[] = []
	for (let i = 0; i < yValues.length; i += yTickStep) yTickIndices.push(i)
	if (yTickIndices[yTickIndices.length - 1] !== yValues.length - 1) {
		yTickIndices.push(yValues.length - 1)
	}

	return {
		cellW,
		cellH,
		gridW,
		gridH,
		yLabelW,
		xTickIndices,
		yTickIndices,
		gridOffsetX,
	}
}

export function QueryBuilderHeatmapChart({ data, className, tooltip, unit, heatmap }: BaseChartProps) {
	const source = Array.isArray(data) && data.length > 0 ? data : heatmapSampleData
	const points = React.useMemo(() => deriveHeatmapPoints(source), [source])

	const xValues = React.useMemo(() => Array.from(new Set(points.map((p) => p.x))), [points])
	const yValues = React.useMemo(() => Array.from(new Set(points.map((p) => p.y))).reverse(), [points])

	const lookup = React.useMemo(() => {
		const map = new Map<string, number>()
		for (const point of points) {
			map.set(`${point.x}::${point.y}`, point.value)
		}
		return map
	}, [points])

	const { min, max, span } = React.useMemo(() => {
		if (points.length === 0) return { min: 0, max: 0, span: 0 }
		let lo = Number.POSITIVE_INFINITY
		let hi = Number.NEGATIVE_INFINITY
		for (const p of points) {
			if (p.value < lo) lo = p.value
			if (p.value > hi) hi = p.value
		}
		return { min: lo, max: hi, span: hi - lo }
	}, [points])

	const scaleType = heatmap?.scaleType ?? "linear"
	const palette = COLOR_SCALES[heatmap?.colorScale ?? "blues"] ?? COLOR_SCALES.blues

	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const [size, setSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 })

	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const ro = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect
			if (!rect) return
			setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) })
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	const allYIso = React.useMemo(() => yValues.every((v) => ISO_RE.test(v)), [yValues])

	const layout = React.useMemo(
		() => computeLayout(size.w, size.h, xValues, yValues, allYIso),
		[size.w, size.h, xValues, yValues, allYIso],
	)

	const [hover, setHover] = React.useState<HoverState | null>(null)

	// Empty state — a quiet placeholder with a tiny suggestive grid.
	if (xValues.length === 0 || yValues.length === 0) {
		return (
			<div ref={containerRef} className={cn("relative h-full w-full", className)}>
				<div className="absolute inset-0 grid place-items-center">
					<div className="flex flex-col items-center gap-2.5">
						<div className="grid grid-cols-8 gap-[2px]">
							{Array.from({ length: 32 }).map((_, i) => (
								<div
									key={i}
									className="size-1.5"
									style={{
										background: "color-mix(in oklch, var(--foreground) 8%, transparent)",
									}}
								/>
							))}
						</div>
						<div className="text-[11px] text-muted-foreground/70">No data</div>
					</div>
				</div>
			</div>
		)
	}

	if (!layout) {
		return <div ref={containerRef} className={cn("relative h-full w-full", className)} />
	}

	const { cellW, cellH, gridW, gridH, yLabelW, xTickIndices, yTickIndices, gridOffsetX } = layout

	const xStride = cellW + CELL_GAP
	const yStride = cellH + CELL_GAP
	const colCenterX = (xi: number) => xi * xStride + cellW / 2
	const rowCenterY = (yi: number) => yi * yStride + cellH / 2

	// Legend ticks: linear shows endpoints; log adds a geometric midpoint so
	// the spacing reads as logarithmic.
	const legendTicks: Array<{ value: number; pct: number; anchor: "start" | "middle" | "end" }> =
		span <= 0
			? [{ value: min, pct: 0, anchor: "start" }]
			: scaleType === "log"
				? [
						{ value: min, pct: 0, anchor: "start" },
						{
							value: min + Math.expm1(0.5 * Math.log1p(span)),
							pct: 50,
							anchor: "middle",
						},
						{ value: max, pct: 100, anchor: "end" },
					]
				: [
						{ value: min, pct: 0, anchor: "start" },
						{ value: max, pct: 100, anchor: "end" },
					]

	const noDataFill = "color-mix(in oklch, var(--muted-foreground) 10%, transparent)"

	const handlePointerEnter = (xi: number, yi: number) => {
		const x = xValues[xi]
		const y = yValues[yi]
		const has = lookup.has(`${x}::${y}`)
		setHover({
			x,
			y,
			xIdx: xi,
			yIdx: yi,
			value: has ? (lookup.get(`${x}::${y}`) ?? 0) : null,
		})
	}

	const plotLeft = yLabelW + gridOffsetX

	return (
		<div ref={containerRef} className={cn("relative h-full w-full select-none", className)}>
			<div
				className="absolute inset-0"
				style={{
					padding: `${PLOT_PAD_TOP}px ${PLOT_PAD_X}px ${PLOT_PAD_BOTTOM}px ${PLOT_PAD_X}px`,
				}}
			>
				{/* Plot column: cell grid + x-axis + legend, stacked. */}
				<div className="relative h-full w-full">
					{/* Y-axis labels — anchored to row centers so the axis stays
					    aligned with the cell grid regardless of row stride. */}
					<div
						className="absolute top-0"
						style={{ left: gridOffsetX, width: yLabelW, height: gridH }}
					>
						{yTickIndices.map((yi) => {
							const raw = yValues[yi]
							const label = shortenYLabel(raw, allYIso)
							const isActive = hover?.yIdx === yi
							return (
								<div
									key={raw}
									title={raw}
									className={cn(
										"absolute right-0 truncate text-right tabular-nums transition-colors",
										isActive ? "text-[var(--primary)]" : "text-muted-foreground/85",
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

					{/* Cell grid */}
					<div
						className="absolute top-0"
						style={{ left: plotLeft }}
						onPointerLeave={() => setHover(null)}
					>
						<div
							className="grid"
							style={{
								gridTemplateColumns: `repeat(${xValues.length}, ${cellW}px)`,
								gridTemplateRows: `repeat(${yValues.length}, ${cellH}px)`,
								gap: `${CELL_GAP}px`,
							}}
						>
							{yValues.flatMap((y, yi) =>
								xValues.map((x, xi) => {
									const key = `${x}::${y}`
									const has = lookup.has(key)
									const value = lookup.get(key) ?? 0
									const t = normalize(value, min, span, scaleType)
									const isHover = hover?.xIdx === xi && hover?.yIdx === yi
									const isCrossRow = hover && hover.yIdx === yi && hover.xIdx !== xi
									const isCrossCol = hover && hover.xIdx === xi && hover.yIdx !== yi

									const fill = !has
										? noDataFill
										: span === 0 || (value === min && span > 0)
											? palette[0]
											: colorForT(t, palette)

									return (
										<div
											key={key}
											onPointerEnter={() => handlePointerEnter(xi, yi)}
											className={cn(
												"relative transition-[box-shadow,filter] duration-150",
												isHover && "z-10",
											)}
											style={{
												backgroundColor: fill,
												borderRadius: 1.5,
												boxShadow: isHover
													? "0 0 0 1.5px var(--foreground), 0 0 0 3.5px color-mix(in oklch, var(--foreground) 28%, transparent)"
													: isCrossRow || isCrossCol
														? "inset 0 0 0 1px color-mix(in oklch, var(--foreground) 35%, transparent)"
														: undefined,
												filter:
													hover && !isHover && !isCrossRow && !isCrossCol
														? "saturate(0.55) brightness(0.92)"
														: undefined,
											}}
										/>
									)
								}),
							)}
						</div>

						{/* X-axis: ticks + labels, anchored under the cell grid. */}
						<div
							className="absolute"
							style={{ left: 0, top: gridH, width: gridW, height: X_AXIS_H }}
						>
							{xTickIndices.map((xi, ti) => {
								const raw = xValues[xi]
								const isActive = hover?.xIdx === xi
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
												background:
													"color-mix(in oklch, var(--border) 80%, transparent)",
											}}
										/>
										<div
											title={raw}
											className={cn(
												"absolute whitespace-nowrap tabular-nums transition-colors",
												isActive
													? "text-[var(--primary)]"
													: "text-muted-foreground/85",
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

						{/* Tooltip — anchored above hovered cell. */}
						{tooltip !== "hidden" && hover && (
							<div
								className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-[color-mix(in_oklch,var(--border)_80%,var(--foreground)_15%)] bg-popover/95 px-2.5 py-1.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] backdrop-blur-sm"
								style={{
									left: colCenterX(hover.xIdx),
									top: rowCenterY(hover.yIdx) - 10,
									fontSize: LABEL_FONT_PX,
								}}
							>
								<div className="font-medium text-foreground">
									<span>{hover.x}</span>
									<span className="px-1 text-muted-foreground/60">·</span>
									<span>{hover.y}</span>
								</div>
								<div className="mt-0.5 tabular-nums text-muted-foreground">
									{hover.value === null ? (
										<span className="italic text-muted-foreground/70">no data</span>
									) : (
										<span className="text-foreground/90">
											{formatScalar(hover.value, unit)}
										</span>
									)}
								</div>
							</div>
						)}
					</div>

					{/* Legend strip — same width as the cell grid, anchored under
					    the x-axis. A thin gradient bar plus endpoint values. */}
					<div
						className="absolute"
						style={{
							left: plotLeft,
							top: gridH + X_AXIS_H + GAP_GRID_TO_LEGEND,
							width: gridW,
							height: LEGEND_HEIGHT,
						}}
					>
						<div
							style={{
								height: 10,
								width: "100%",
								background: `linear-gradient(in oklch to right, ${palette.join(", ")})`,
								borderRadius: 2,
								boxShadow:
									"inset 0 0 0 0.5px color-mix(in oklch, var(--foreground) 12%, transparent)",
							}}
						/>
						<div className="relative mt-1.5" style={{ height: 12 }}>
							{legendTicks.map(({ value, pct, anchor }) => (
								<div
									key={pct}
									className="absolute tabular-nums text-muted-foreground/85"
									style={{
										left: `${pct}%`,
										transform:
											anchor === "start"
												? "translateX(0)"
												: anchor === "end"
													? "translateX(-100%)"
													: "translateX(-50%)",
										fontSize: LABEL_FONT_PX - 0.5,
										lineHeight: 1,
									}}
								>
									{formatScalar(value, unit)}
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
