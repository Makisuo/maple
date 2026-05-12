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

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, Math.min(1, value))
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

// Recognise ISO-8601-shaped strings. Used to opt the y-axis into the
// compact HH:MM presentation when every tick is a timestamp.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/

/**
 * If every y-axis tick is an ISO timestamp, render the time-of-day only.
 * Date context drops into the tooltip (which shows the full original
 * string verbatim), so we don't waste vertical space on a header.
 */
function shortenYLabel(raw: string, allIso: boolean): string {
	if (!allIso) return raw
	const tIdx = raw.indexOf("T")
	if (tIdx < 0) return raw
	return raw.slice(tIdx + 1).replace(/\.\d+Z?$/, "").replace(/Z$/, "").slice(0, 5)
}

/**
 * Pick evenly spaced tick indices for a categorical axis. Always includes
 * the first and last index so the axis is clearly bounded.
 */
function pickEvenTicks(count: number, maxTicks: number): number[] {
	if (count <= 0) return []
	if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i)
	const ticks = new Set<number>()
	for (let i = 0; i < maxTicks; i += 1) {
		ticks.add(Math.round((i * (count - 1)) / (maxTicks - 1)))
	}
	return Array.from(ticks).sort((a, b) => a - b)
}

// Layout budget. Every constant here is in CSS pixels and is consumed by
// both the `ResizeObserver` cell-sizing math and the JSX positioning.
const CELL_GAP = 1.5
const Y_LABEL_WIDTH = 56 // sans-serif HH:MM or short categorical labels
const X_LABEL_HEIGHT = 18 // single horizontal text row, no rotation
const LEGEND_HEIGHT = 22 // gradient bar + min/max labels
const PLOT_PADDING = 8 // outer padding around the chart

const MIN_CELL = 6
const MAX_CELL = 36

// Number of x-axis label ticks — Grafana-style restraint. Five labels is
// the sweet spot: enough to anchor the axis without becoming a wall.
const X_TICK_COUNT = 5
// Minimum vertical room each y-label needs to avoid stacking neighbours.
const Y_LABEL_MIN_PX = 14

interface HoverState {
	x: string
	y: string
	xIdx: number
	yIdx: number
	value: number | null
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
	const [cellSize, setCellSize] = React.useState<number>(14)

	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const ro = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect
			if (!rect) return
			if (xValues.length === 0 || yValues.length === 0) return
			const availW = rect.width - Y_LABEL_WIDTH - PLOT_PADDING * 2
			const availH =
				rect.height - X_LABEL_HEIGHT - LEGEND_HEIGHT - PLOT_PADDING * 2 - 8 /* gap above legend */
			const perX = (availW - (xValues.length - 1) * CELL_GAP) / xValues.length
			const perY = (availH - (yValues.length - 1) * CELL_GAP) / yValues.length
			const next = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(Math.min(perX, perY))))
			setCellSize(next)
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [xValues.length, yValues.length])

	const [hover, setHover] = React.useState<HoverState | null>(null)

	// Empty state — a quiet placeholder, sans-serif to match the new
	// chart aesthetic. No monospace, no uppercase tracking.
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

	const allYIso = yValues.every((v) => ISO_RE.test(v))
	const stride = cellSize + CELL_GAP
	const gridWidth = xValues.length * cellSize + (xValues.length - 1) * CELL_GAP
	const gridHeight = yValues.length * cellSize + (yValues.length - 1) * CELL_GAP

	// Position helpers in plot-local coordinates (origin at top-left of
	// the cell grid).
	const colCenterX = (xi: number) => xi * stride + cellSize / 2
	const rowCenterY = (yi: number) => yi * stride + cellSize / 2

	// X-axis ticks: pick ~5 evenly spaced indices. The labels render
	// horizontally below the cell grid; truncation happens only if the
	// stride between two ticks is narrower than the label text.
	const xTickIndices = React.useMemo(
		() => pickEvenTicks(xValues.length, X_TICK_COUNT),
		[xValues.length],
	)

	// X-label budget per shown tick: roughly the distance between adjacent
	// ticks, minus a 4px gutter so labels never visually collide.
	const xLabelMaxPx =
		xTickIndices.length > 1
			? ((xValues.length - 1) * stride) / (xTickIndices.length - 1) - 4
			: gridWidth
	const xLabelMaxChars = Math.max(4, Math.floor(xLabelMaxPx / 6))

	// Y-axis ticks: density based on cell row height. We aim for ≥14px of
	// vertical room per label so they never stack.
	const yTickStride = Math.max(1, Math.ceil(Y_LABEL_MIN_PX / stride))
	const yTickIndices = React.useMemo(() => {
		const out: number[] = []
		for (let i = 0; i < yValues.length; i += yTickStride) out.push(i)
		// Always include the last row so the axis range is clearly bounded.
		if (out.length > 0 && out[out.length - 1] !== yValues.length - 1) {
			out.push(yValues.length - 1)
		}
		return out
	}, [yValues.length, yTickStride])

	// Legend: just two endpoints in linear mode; add a geometric midpoint
	// in log mode so the spacing is communicated.
	const legendTicks = React.useMemo(() => {
		if (span <= 0) return [{ value: min, pct: 0, anchor: "start" as const }]
		const out: Array<{ value: number; pct: number; anchor: "start" | "middle" | "end" }> = [
			{ value: min, pct: 0, anchor: "start" },
		]
		if (scaleType === "log") {
			out.push({ value: min + Math.expm1(0.5 * Math.log1p(span)), pct: 50, anchor: "middle" })
		}
		out.push({ value: max, pct: 100, anchor: "end" })
		return out
	}, [min, max, span, scaleType])

	// Constrain the legend bar to the chart-grid width — feels more
	// anchored than letting it stretch the whole container.
	const legendBarWidth = Math.min(280, gridWidth)

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

	return (
		<div ref={containerRef} className={cn("relative h-full w-full select-none", className)}>
			<div
				className="absolute inset-0 flex flex-col"
				style={{ padding: PLOT_PADDING }}
			>
				{/* Plot area */}
				<div className="relative min-h-0 flex-1">
					{/* Y-axis labels — absolutely positioned at row centers so
						 the axis stays aligned with the cell grid regardless of
						 row stride. */}
					<div className="absolute inset-y-0 left-0" style={{ width: Y_LABEL_WIDTH }}>
						<div
							className="relative"
							style={{ width: "100%", height: gridHeight }}
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
											"absolute right-0 truncate text-right text-[11px] tabular-nums transition-colors",
											isActive
												? "text-[var(--primary)]"
												: "text-muted-foreground/85",
										)}
										style={{
											top: rowCenterY(yi),
											transform: "translateY(-50%)",
											paddingRight: 8,
											width: Y_LABEL_WIDTH,
										}}
									>
										{label}
									</div>
								)
							})}
						</div>
					</div>

					{/* Cell grid */}
					<div
						className="absolute left-0 top-0"
						style={{ marginLeft: Y_LABEL_WIDTH }}
						onPointerLeave={() => setHover(null)}
					>
						<div
							className="grid"
							style={{
								gridTemplateColumns: `repeat(${xValues.length}, ${cellSize}px)`,
								gridTemplateRows: `repeat(${yValues.length}, ${cellSize}px)`,
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
									const isInCol = hover?.xIdx === xi
									const isInRow = hover?.yIdx === yi

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
												"relative transition-[box-shadow]",
												isHover && "z-10",
											)}
											style={{
												backgroundColor: fill,
												boxShadow: isHover
													? "0 0 0 1.5px var(--foreground)"
													: isInCol || isInRow
														? "inset 0 0 0 1px color-mix(in oklch, var(--primary) 45%, transparent)"
														: undefined,
											}}
										/>
									)
								}),
							)}
						</div>

						{/* X-axis ticks + labels, anchored to the bottom of the
							 cell grid in the same coordinate system. */}
						<div
							className="absolute left-0 right-0"
							style={{ top: gridHeight, height: X_LABEL_HEIGHT }}
						>
							{xTickIndices.map((xi, ti) => {
								const raw = xValues[xi]
								const isActive = hover?.xIdx === xi
								const display =
									raw.length > xLabelMaxChars
										? `${raw.slice(0, Math.max(1, xLabelMaxChars - 1))}…`
										: raw
								// Anchor endpoints so the first label stays clear of the
								// y-axis column and the last doesn't run past the grid's
								// right edge. Interior labels center over their tick.
								const isFirst = ti === 0
								const isLast = ti === xTickIndices.length - 1
								const labelTransform = isFirst
									? "translateX(0)"
									: isLast
										? "translateX(-100%)"
										: "translateX(-50%)"
								return (
									<React.Fragment key={raw}>
										<div
											aria-hidden
											className="absolute"
											style={{
												left: colCenterX(xi),
												top: 0,
												width: 1,
												height: 4,
												transform: "translateX(-0.5px)",
												background:
													"color-mix(in oklch, var(--border) 80%, transparent)",
											}}
										/>
										<div
											title={raw}
											className={cn(
												"absolute whitespace-nowrap text-[10.5px] tabular-nums transition-colors",
												isActive
													? "text-[var(--primary)]"
													: "text-muted-foreground/85",
											)}
											style={{
												left: colCenterX(xi),
												top: 5,
												transform: labelTransform,
											}}
										>
											{display}
										</div>
									</React.Fragment>
								)
							})}
						</div>

						{/* Tooltip */}
						{tooltip !== "hidden" && hover && (
							<div
								className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-[color-mix(in_oklch,var(--border)_80%,var(--foreground)_15%)] bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] backdrop-blur-sm"
								style={{
									left: colCenterX(hover.xIdx),
									top: rowCenterY(hover.yIdx) - 8,
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
				</div>

				{/* Horizontal legend strip — anchored under the cell grid,
					 starting at the same x-offset as the grid (Y_LABEL_WIDTH).
					 The gradient itself is built with `linear-gradient(in oklch
					 to right, …)` so the bar's transition matches what cells
					 do per-value. */}
				<div
					className="shrink-0"
					style={{
						marginLeft: Y_LABEL_WIDTH,
						marginTop: 8,
						height: LEGEND_HEIGHT,
						width: legendBarWidth,
					}}
				>
					<div
						style={{
							height: 8,
							width: "100%",
							background: `linear-gradient(in oklch to right, ${palette.join(", ")})`,
							borderRadius: 1,
						}}
					/>
					<div className="relative mt-1.5" style={{ height: 12 }}>
						{legendTicks.map(({ value, pct, anchor }) => (
							<div
								key={pct}
								className="absolute text-[10.5px] tabular-nums text-muted-foreground/85"
								style={{
									left: `${pct}%`,
									transform:
										anchor === "start"
											? "translateX(0)"
											: anchor === "end"
												? "translateX(-100%)"
												: "translateX(-50%)",
								}}
							>
								{formatScalar(value, unit)}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}
