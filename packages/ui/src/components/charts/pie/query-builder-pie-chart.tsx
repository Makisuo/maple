import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { useContainerSize } from "../../../hooks/use-container-size"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import {
	bucketCategorical,
	type CategoricalRow,
	MAX_CATEGORICAL,
	OTHER_COLOR,
	OTHER_LABEL,
} from "../_shared/bucket-series"

type Row = CategoricalRow

interface Slice extends Row {
	pct: number
	color: string
	startA: number
	endA: number
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

/**
 * Donut-centre total: exact counts under 10k read better than compact
 * notation ("1,500" instead of "1.5K"); larger totals stay compact.
 */
function fmtCenterTotal(value: number, unit?: string): string {
	if (!unit && Number.isInteger(value) && Math.abs(value) < 10_000) {
		return value.toLocaleString()
	}
	return fmtValue(value, unit)
}

/**
 * Cartesian point on a circle centred at (cx, cy) with radius r, at angle
 * `angle` measured clockwise from 12 o'clock (so 0 is top, π/2 is right).
 */
function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
	const theta = angle - Math.PI / 2
	return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)]
}

/**
 * Build a single slice path. A donut slice is an annular wedge; a pie slice
 * is a pizza wedge with apex at the centre. `endA - startA` must be in (0, 2π).
 */
function arcPath(
	cx: number,
	cy: number,
	outerR: number,
	innerR: number,
	startA: number,
	endA: number,
): string {
	const span = endA - startA
	if (span <= 0) return ""
	// Treat a full circle as two half-arcs so SVG can render it.
	if (span >= Math.PI * 2 - 0.0001) {
		const mid = startA + Math.PI
		if (innerR <= 0) {
			const [a1x, a1y] = polar(cx, cy, outerR, startA)
			const [a2x, a2y] = polar(cx, cy, outerR, mid)
			return `M ${a1x} ${a1y} A ${outerR} ${outerR} 0 1 1 ${a2x} ${a2y} A ${outerR} ${outerR} 0 1 1 ${a1x} ${a1y} Z`
		}
		const [a1x, a1y] = polar(cx, cy, outerR, startA)
		const [a2x, a2y] = polar(cx, cy, outerR, mid)
		const [b1x, b1y] = polar(cx, cy, innerR, startA)
		const [b2x, b2y] = polar(cx, cy, innerR, mid)
		return (
			`M ${a1x} ${a1y} A ${outerR} ${outerR} 0 1 1 ${a2x} ${a2y} ` +
			`A ${outerR} ${outerR} 0 1 1 ${a1x} ${a1y} ` +
			`M ${b1x} ${b1y} A ${innerR} ${innerR} 0 1 0 ${b2x} ${b2y} ` +
			`A ${innerR} ${innerR} 0 1 0 ${b1x} ${b1y} Z`
		)
	}
	const large = span > Math.PI ? 1 : 0
	const [ox1, oy1] = polar(cx, cy, outerR, startA)
	const [ox2, oy2] = polar(cx, cy, outerR, endA)
	if (innerR <= 0) {
		return `M ${cx} ${cy} L ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} Z`
	}
	const [ix1, iy1] = polar(cx, cy, innerR, startA)
	const [ix2, iy2] = polar(cx, cy, innerR, endA)
	return (
		`M ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} ` +
		`L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1} Z`
	)
}

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

const LEGEND_GAP = 6
const LEGEND_ROW_H = 18
const LEGEND_MAX_ROWS = 2
const PIE_PAD = 4
const PIE_MIN_SIZE = 48
// Tabular legend: a share of the card, bounded so the pie never starves and the
// name column never runs away. Below TABLE_MIN_PIE_W of remaining width there
// is no pie worth drawing, so that layout falls back to the bottom chips.
//
// The minimum is set by the columns, not by taste: swatch + gaps + padding +
// the Value and Percent columns come to TABLE_FIXED_W, and anything narrower
// than that leaves the flex-1 name column at zero width — a legend of coloured
// squares and numbers with no labels, which is worse than the chips it replaced.
const TABLE_LEGEND_RATIO = 0.46
const TABLE_FIXED_W = 116
const TABLE_LEGEND_MIN_W = TABLE_FIXED_W + 52
const TABLE_LEGEND_MAX_W = 240
const TABLE_MIN_PIE_W = 120
// Slices below this percentage do not get an in-slice label — the wedge is
// too narrow to host text without overflowing onto its neighbours.
const LABEL_MIN_PCT = 0.06

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

export function QueryBuilderPieChart({ data, className, legend, tooltip, unit, pie }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const { slices, total } = React.useMemo(() => {
		const rows: Row[] = source
			.map((row) => {
				const raw = row.name == null ? "" : String(row.name).trim()
				return {
					name: raw === "" ? "(no value)" : raw,
					value: asFiniteNumber(row[valueField]),
				}
			})
			// Zero/negative rows render as invisible arcs but still occupy
			// legend rows — drop them.
			.filter((row) => row.value > 0)
		// Collapse the long tail of small categories into a single "Other" slice
		// (also sorts largest-first). Keeps both the pie and its 2-row legend
		// legible when a group-by produces dozens of categories.
		const bucketed = bucketCategorical(rows, MAX_CATEGORICAL)
		const sum = bucketed.reduce((acc, r) => acc + r.value, 0)
		if (sum <= 0) return { slices: [] as Slice[], total: 0 }
		let cursor = 0
		// Resolved by name, so a slice keeps its color even though `bucketCategorical`
		// re-sorts largest-first. "Other" is a bucket, not an identity.
		const colors = resolveSeriesColors(
			bucketed.map((row) => row.name).filter((name) => name !== OTHER_LABEL),
		)
		const out: Slice[] = bucketed.map((row) => {
			const pct = row.value / sum
			const startA = cursor * 2 * Math.PI
			cursor += pct
			const endA = cursor * 2 * Math.PI
			const color = row.name === OTHER_LABEL ? OTHER_COLOR : (colors.get(row.name) ?? OTHER_COLOR)
			return { ...row, pct, color, startA, endA }
		})
		return { slices: out, total: sum }
	}, [source, valueField])

	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const containerSize = useContainerSize(containerRef)
	const size = { w: Math.floor(containerSize.width), h: Math.floor(containerSize.height) }

	// A composition breakdown is read as a ranked table, not as a colour-matching
	// exercise: `legend: "right"` puts the slices in a sorted Value/% table beside
	// the pie. "visible" keeps the compact bottom chips for cards too narrow to
	// host a table. Below TABLE_MIN_PIE_W of leftover width the table would starve
	// the pie, so it degrades to chips rather than rendering both badly.
	const showLegend = legend !== "hidden"
	const tableLegendW = clamp(
		Math.round(size.w * TABLE_LEGEND_RATIO),
		TABLE_LEGEND_MIN_W,
		TABLE_LEGEND_MAX_W,
	)
	const tableLegend = showLegend && legend === "right" && size.w - tableLegendW >= TABLE_MIN_PIE_W

	// Measure legend after render. We allow up to LEGEND_MAX_ROWS rows of
	// wrapped chips, then clip excess (the tooltip still shows the full name).
	const chipLegend = showLegend && !tableLegend
	const legendRef = React.useRef<HTMLDivElement | null>(null)
	const [legendH, setLegendH] = React.useState(() => (showLegend ? LEGEND_ROW_H : 0))
	React.useLayoutEffect(() => {
		if (!chipLegend || !legendRef.current) {
			if (legendH !== 0) setLegendH(0)
			return
		}
		const h = legendRef.current.scrollHeight
		const capped = Math.min(h, LEGEND_ROW_H * LEGEND_MAX_ROWS + 2)
		if (capped !== legendH) setLegendH(capped)
	}, [chipLegend, slices.length, size.w])

	const [hover, setHover] = React.useState<number | null>(null)

	const pieAreaW = tableLegend ? size.w - tableLegendW : size.w
	const pieAreaH = size.h - (chipLegend ? legendH + LEGEND_GAP : 0)
	const pieSize = Math.max(PIE_MIN_SIZE, Math.min(pieAreaW, pieAreaH) - PIE_PAD * 2)
	const cx = pieAreaW / 2
	const cy = Math.max(pieSize / 2 + PIE_PAD, pieAreaH / 2)
	const outerR = pieSize / 2
	const innerR = pie?.donut ? Math.max(8, Math.min(outerR - 6, pie.innerRadius ?? outerR * 0.58)) : 0

	const showLabels = pie?.showLabels === true
	const showPercent = pie?.showPercent !== false

	// Empty state.
	if (size.w === 0 || size.h === 0) {
		return <div ref={containerRef} className={cn("relative h-full w-full", className)} />
	}
	if (slices.length === 0 || total <= 0) {
		return (
			<div
				ref={containerRef}
				className={cn("relative h-full w-full grid place-items-center", className)}
			>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			className={cn("relative h-full w-full select-none", className)}
			onPointerLeave={() => setHover(null)}
		>
			<svg
				width={pieAreaW}
				height={pieAreaH}
				className="absolute left-0 top-0 overflow-visible"
				aria-hidden
			>
				{/* Subtle drop shadow under the entire pie. */}
				<defs>
					<filter id="pie-shadow" x="-20%" y="-20%" width="140%" height="140%">
						<feGaussianBlur stdDeviation="3" />
						<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.18 0" />
					</filter>
				</defs>

				{/* Shadow layer */}
				<g filter="url(#pie-shadow)" style={{ pointerEvents: "none", opacity: 0.6 }}>
					{slices.map((s) => (
						<path
							key={`shadow-${s.name}`}
							d={arcPath(cx, cy + 2, outerR, innerR, s.startA, s.endA)}
							fill="black"
						/>
					))}
				</g>

				{/* Slices */}
				<g>
					{slices.map((s, i) => {
						const isHover = hover === i
						const fade = hover !== null && !isHover ? 0.55 : 1
						return (
							<path
								key={s.name}
								d={arcPath(cx, cy, outerR, innerR, s.startA, s.endA)}
								fill={s.color}
								stroke="var(--background)"
								strokeWidth={1.5}
								strokeLinejoin="round"
								onPointerEnter={() => setHover(i)}
								style={{
									opacity: fade,
									transition: "opacity 140ms ease, transform 140ms ease",
									transformOrigin: `${cx}px ${cy}px`,
									transform: isHover ? "scale(1.035)" : undefined,
									cursor: "pointer",
								}}
							/>
						)
					})}
				</g>

				{/* In-slice labels (only for slices above the threshold). */}
				{showLabels && (
					<g style={{ pointerEvents: "none" }}>
						{slices.map((s) => {
							if (s.pct < LABEL_MIN_PCT) return null
							const midA = (s.startA + s.endA) / 2
							const labelR = innerR > 0 ? (innerR + outerR) / 2 : outerR * 0.62
							const [lx, ly] = polar(cx, cy, labelR, midA)
							const text = showPercent
								? `${(s.pct * 100).toFixed(s.pct < 0.1 ? 1 : 0)}%`
								: fmtValue(s.value, unit)
							return (
								<text
									key={`l-${s.name}`}
									x={lx}
									y={ly}
									textAnchor="middle"
									dominantBaseline="central"
									className="fill-white tabular-nums"
									style={{
										fontSize: 11,
										fontWeight: 600,
										textShadow: "0 1px 2px rgba(0,0,0,0.45)",
										paintOrder: "stroke",
										stroke: "rgba(0,0,0,0.35)",
										strokeWidth: 0.8,
									}}
								>
									{text}
								</text>
							)
						})}
					</g>
				)}

				{/* Donut centre: total. */}
				{pie?.donut && innerR > 18 && (
					<g style={{ pointerEvents: "none" }}>
						<text
							x={cx}
							y={cy - 6}
							textAnchor="middle"
							dominantBaseline="central"
							className="fill-foreground tabular-nums"
							style={{
								fontSize: Math.min(22, innerR * 0.6),
								fontWeight: 600,
								letterSpacing: "-0.02em",
							}}
						>
							{fmtCenterTotal(total, unit)}
						</text>
						<text
							x={cx}
							y={cy + Math.min(14, innerR * 0.36)}
							textAnchor="middle"
							dominantBaseline="central"
							className="fill-muted-foreground"
							style={{
								fontSize: Math.min(10, innerR * 0.28),
								letterSpacing: "0.04em",
								textTransform: "uppercase",
							}}
						>
							total
						</text>
					</g>
				)}
			</svg>

			{/* Tooltip */}
			{tooltip !== "hidden" && hover !== null && slices[hover] && (
				<div
					className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-[color-mix(in_oklch,var(--border)_80%,var(--foreground)_15%)] bg-popover/95 px-2.5 py-1.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)] backdrop-blur-sm"
					style={{
						left: clamp(
							cx + Math.cos(angleMid(slices[hover]) - Math.PI / 2) * (outerR * 0.85),
							60,
							pieAreaW - 60,
						),
						top: cy + Math.sin(angleMid(slices[hover]) - Math.PI / 2) * (outerR * 0.85) - 8,
						fontSize: 11,
					}}
				>
					<div className="flex items-center gap-1.5 font-medium text-foreground">
						<span
							className="size-2 rounded-[2px]"
							style={{ backgroundColor: slices[hover].color }}
						/>
						<span>{slices[hover].name}</span>
						{slices[hover].collapsedCount ? (
							<span className="font-normal text-muted-foreground">
								({slices[hover].collapsedCount} categories)
							</span>
						) : null}
					</div>
					<div className="mt-0.5 tabular-nums text-muted-foreground">
						<span className="text-foreground/90">{fmtValue(slices[hover].value, unit)}</span>
						<span className="px-1 text-muted-foreground/60">·</span>
						<span>{(slices[hover].pct * 100).toFixed(1)}%</span>
					</div>
				</div>
			)}

			{/* Tabular legend — sorted largest-first, with Value and % columns. */}
			{tableLegend && (
				<div
					className="absolute right-0 top-0 bottom-0 flex flex-col overflow-hidden"
					style={{ width: tableLegendW }}
				>
					{/* Column widths here must match the rows below and TABLE_FIXED_W. */}
					<div className="flex items-center gap-1.5 border-b border-border/60 px-1 pb-1 text-[10px] uppercase tracking-[0.04em] text-muted-foreground/70">
						<span className="size-2.5 shrink-0" />
						<span className="min-w-0 flex-1">Name</span>
						<span className="w-12 shrink-0 text-right">Value</span>
						<span className="w-8 shrink-0 text-right">%</span>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto">
						{slices.map((s, i) => {
							const isHover = hover === i
							const collapsed = s.collapsedCount
							return (
								<button
									key={s.name}
									type="button"
									title={
										collapsed
											? `${s.name} — ${collapsed} smaller categories · ${fmtValue(s.value, unit)} (${(s.pct * 100).toFixed(1)}%)`
											: `${s.name} · ${fmtValue(s.value, unit)} (${(s.pct * 100).toFixed(1)}%)`
									}
									onPointerEnter={() => setHover(i)}
									onFocus={() => setHover(i)}
									className={cn(
										"flex w-full items-center gap-1.5 rounded-[3px] px-1 py-[3px] text-left text-[11px] tabular-nums transition-colors",
										isHover
											? "bg-muted/50 text-foreground"
											: hover !== null
												? "text-muted-foreground/60"
												: "text-muted-foreground",
									)}
								>
									<span
										className="size-2.5 shrink-0 rounded-[2px]"
										style={{ backgroundColor: s.color }}
									/>
									<span className="min-w-0 flex-1 truncate">
										{s.name}
										{collapsed ? (
											<span className="pl-1 text-muted-foreground/60">
												+{collapsed}
											</span>
										) : null}
									</span>
									<span className="w-12 shrink-0 truncate text-right text-foreground/85">
										{fmtValue(s.value, unit)}
									</span>
									<span className="w-8 shrink-0 text-right">
										{(s.pct * 100).toFixed(s.pct >= 0.1 ? 0 : 1)}
									</span>
								</button>
							)
						})}
					</div>
				</div>
			)}

			{/* Legend — bottom, wrapping, capped at LEGEND_MAX_ROWS rows. */}
			{chipLegend && (
				<div
					ref={legendRef}
					className="absolute left-0 right-0 bottom-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 overflow-hidden px-2"
					style={{ maxHeight: LEGEND_ROW_H * LEGEND_MAX_ROWS + 2 }}
				>
					{slices.map((s, i) => {
						const isHover = hover === i
						return (
							<button
								key={s.name}
								type="button"
								title={`${s.name} · ${fmtValue(s.value, unit)} (${(s.pct * 100).toFixed(1)}%)`}
								onPointerEnter={() => setHover(i)}
								onFocus={() => setHover(i)}
								className={cn(
									"flex max-w-[140px] items-center gap-1.5 truncate text-[11px] tabular-nums transition-colors",
									isHover
										? "text-foreground"
										: hover !== null
											? "text-muted-foreground/60"
											: "text-muted-foreground",
								)}
								style={{ height: LEGEND_ROW_H }}
							>
								<span
									className="size-2.5 shrink-0 rounded-[2px]"
									style={{ backgroundColor: s.color }}
								/>
								<span className="truncate">{s.name}</span>
								{s.collapsedCount ? (
									<span className="shrink-0 text-muted-foreground/60">
										+{s.collapsedCount}
									</span>
								) : null}
							</button>
						)
					})}
				</div>
			)}
		</div>
	)
}

function angleMid(slice: Slice): number {
	return (slice.startA + slice.endA) / 2
}

function clamp(value: number, lo: number, hi: number): number {
	if (!Number.isFinite(value)) return lo
	return Math.max(lo, Math.min(hi, value))
}
