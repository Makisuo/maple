import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { pieSampleData } from "../_shared/sample-data"
import { getSemanticSeriesColor } from "../../../lib/semantic-series-colors"

interface Row {
	name: string
	value: number
}

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
		return (
			`M ${cx} ${cy} L ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} Z`
		)
	}
	const [ix1, iy1] = polar(cx, cy, innerR, startA)
	const [ix2, iy2] = polar(cx, cy, innerR, endA)
	return (
		`M ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2} ` +
		`L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1} Z`
	)
}

// ──────────────────────────────────────────────────────────────────────────────
// Layout constants.
// ──────────────────────────────────────────────────────────────────────────────

const LEGEND_GAP = 6
const LEGEND_ROW_H = 18
const LEGEND_MAX_ROWS = 2
const PIE_PAD = 4
const PIE_MIN_SIZE = 48
// Slices below this percentage do not get an in-slice label — the wedge is
// too narrow to host text without overflowing onto its neighbours.
const LABEL_MIN_PCT = 0.06

export function QueryBuilderPieChart({ data, className, legend, tooltip, unit, pie }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> =
		Array.isArray(data) && data.length > 0
			? data
			: (pieSampleData as ReadonlyArray<Record<string, unknown>>)

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const { slices, total } = React.useMemo(() => {
		const rows: Row[] = source.map((row) => ({
			name: String(row.name ?? "—"),
			value: asFiniteNumber(row[valueField]),
		}))
		const sum = rows.reduce((acc, r) => acc + r.value, 0)
		if (sum <= 0) return { slices: [] as Slice[], total: 0 }
		let cursor = 0
		const out: Slice[] = rows.map((row, idx) => {
			const pct = row.value / sum
			const startA = cursor * 2 * Math.PI
			cursor += pct
			const endA = cursor * 2 * Math.PI
			const color =
				getSemanticSeriesColor(row.name) ?? `var(--chart-${(idx % 5) + 1})`
			return { ...row, pct, color, startA, endA }
		})
		return { slices: out, total: sum }
	}, [source, valueField])

	// Measure container.
	const containerRef = React.useRef<HTMLDivElement | null>(null)
	const [size, setSize] = React.useState({ w: 0, h: 0 })
	React.useEffect(() => {
		const el = containerRef.current
		if (!el) return
		const ro = new ResizeObserver((entries) => {
			const r = entries[0]?.contentRect
			if (r) setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// Measure legend after render. We allow up to LEGEND_MAX_ROWS rows of
	// wrapped chips, then clip excess (the tooltip still shows the full name).
	const showLegend = legend !== "hidden"
	const legendRef = React.useRef<HTMLDivElement | null>(null)
	const [legendH, setLegendH] = React.useState(() =>
		showLegend ? LEGEND_ROW_H : 0,
	)
	React.useLayoutEffect(() => {
		if (!showLegend || !legendRef.current) {
			if (legendH !== 0) setLegendH(0)
			return
		}
		const h = legendRef.current.scrollHeight
		const capped = Math.min(h, LEGEND_ROW_H * LEGEND_MAX_ROWS + 2)
		if (capped !== legendH) setLegendH(capped)
	}, [showLegend, slices.length, size.w])

	const [hover, setHover] = React.useState<number | null>(null)

	const pieAreaW = size.w
	const pieAreaH = size.h - (showLegend ? legendH + LEGEND_GAP : 0)
	const pieSize = Math.max(
		PIE_MIN_SIZE,
		Math.min(pieAreaW, pieAreaH) - PIE_PAD * 2,
	)
	const cx = pieAreaW / 2
	const cy = Math.max(pieSize / 2 + PIE_PAD, pieAreaH / 2)
	const outerR = pieSize / 2
	const innerR = pie?.donut
		? Math.max(8, Math.min(outerR - 6, pie.innerRadius ?? outerR * 0.58))
		: 0

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
				className={cn(
					"relative h-full w-full grid place-items-center",
					className,
				)}
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
						<feColorMatrix
							values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.18 0"
						/>
					</filter>
				</defs>

				{/* Shadow layer */}
				<g
					filter="url(#pie-shadow)"
					style={{ pointerEvents: "none", opacity: 0.6 }}
				>
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
										textShadow:
											"0 1px 2px rgba(0,0,0,0.45)",
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
							{fmtValue(total, unit)}
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
						top:
							cy + Math.sin(angleMid(slices[hover]) - Math.PI / 2) * (outerR * 0.85) - 8,
						fontSize: 11,
					}}
				>
					<div className="flex items-center gap-1.5 font-medium text-foreground">
						<span
							className="size-2 rounded-[2px]"
							style={{ backgroundColor: slices[hover].color }}
						/>
						<span>{slices[hover].name}</span>
					</div>
					<div className="mt-0.5 tabular-nums text-muted-foreground">
						<span className="text-foreground/90">
							{fmtValue(slices[hover].value, unit)}
						</span>
						<span className="px-1 text-muted-foreground/60">·</span>
						<span>{(slices[hover].pct * 100).toFixed(1)}%</span>
					</div>
				</div>
			)}

			{/* Legend — bottom, wrapping, capped at LEGEND_MAX_ROWS rows. */}
			{showLegend && (
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
