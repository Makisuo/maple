import { useMemo } from "react"
import type { DashboardTemplatePreviewWidget } from "@maple/domain/http"

const GRID_COLS = 12
const VIEW_W = 240
const VIEW_H = 112
const OUTER_PAD = 10
const WIDGET_GAP = 2

// Deterministic PRNG (mulberry32 over an FNV-1a hash) so every widget's glyph
// is distinct but stable across renders and SSR.
function makeRng(seed: string): () => number {
	let h = 0x811c9dc5
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	let state = h >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// A bounded random walk reads like a metric series; independent uniform noise
// reads like static.
function seededWalk(seed: string, count: number): number[] {
	const rng = makeRng(seed)
	let v = 0.25 + rng() * 0.4
	const out: number[] = []
	for (let i = 0; i < count; i++) {
		out.push(v)
		v = Math.min(0.88, Math.max(0.12, v + (rng() - 0.5) * 0.55))
	}
	// Normalize to the full glyph height — midpoint smoothing eats peaks, and an
	// unlucky walk otherwise renders as a near-flat line.
	const lo = Math.min(...out)
	const span = Math.max(...out) - lo || 1
	return out.map((n) => 0.1 + 0.8 * ((n - lo) / span))
}

interface Box {
	x: number
	y: number
	w: number
	h: number
}

// Horizontal inset is fixed; vertical inset scales with box height so short
// widget rows keep a usable drawing area for the series.
function glyphInsets(box: Box): { padX: number; padY: number } {
	return { padX: 3.5, padY: Math.min(4, Math.max(1.5, box.h * 0.18)) }
}

function seriesPoints(box: Box, values: number[]): Array<[number, number]> {
	const { padX, padY } = glyphInsets(box)
	const x0 = box.x + padX
	const innerW = box.w - padX * 2
	const y0 = box.y + padY
	const innerH = box.h - padY * 2
	return values.map((v, i) => [
		x0 + (innerW * i) / (values.length - 1),
		y0 + innerH * (1 - v),
	])
}

// Quadratic smoothing through segment midpoints — monotone-ish curve without a
// charting library.
function smoothPath(points: Array<[number, number]>): string {
	if (points.length < 2) return ""
	const f = (n: number) => n.toFixed(1)
	let d = `M ${f(points[0][0])} ${f(points[0][1])}`
	for (let i = 1; i < points.length - 1; i++) {
		const [cx, cy] = points[i]
		const mx = (cx + points[i + 1][0]) / 2
		const my = (cy + points[i + 1][1]) / 2
		d += ` Q ${f(cx)} ${f(cy)} ${f(mx)} ${f(my)}`
	}
	const [lx, ly] = points[points.length - 1]
	d += ` L ${f(lx)} ${f(ly)}`
	return d
}

function LineGlyph({ box, seed, filled }: { box: Box; seed: string; filled: boolean }) {
	const count = Math.max(5, Math.min(9, Math.round(box.w / 16)))
	const points = seriesPoints(box, seededWalk(seed, count))
	const path = smoothPath(points)
	const baseline = box.y + box.h - glyphInsets(box).padY
	const first = points[0]
	const last = points[points.length - 1]
	return (
		<>
			{filled && first && last && (
				<path
					d={`${path} L ${last[0].toFixed(1)} ${baseline.toFixed(1)} L ${first[0].toFixed(1)} ${baseline.toFixed(1)} Z`}
					className="fill-primary/10"
				/>
			)}
			<path
				d={path}
				className="fill-none stroke-primary/55"
				strokeWidth={1.25}
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</>
	)
}

function BarGlyph({ box, seed }: { box: Box; seed: string }) {
	const count = Math.max(5, Math.min(10, Math.round(box.w / 14)))
	const values = seededWalk(seed, count)
	const { padX, padY } = glyphInsets(box)
	const x0 = box.x + padX
	const innerW = box.w - padX * 2
	const innerH = box.h - padY * 2
	const baseline = box.y + box.h - padY
	const slot = innerW / count
	const barW = slot * 0.55
	return (
		<>
			{values.map((v, i) => {
				const barH = innerH * (0.2 + v * 0.75)
				return (
					<rect
						key={i}
						x={x0 + slot * i + (slot - barW) / 2}
						y={baseline - barH}
						width={barW}
						height={barH}
						rx={0.75}
						className="fill-primary/30"
					/>
				)
			})}
		</>
	)
}

function StatGlyph({ box }: { box: Box }) {
	const { padX, padY } = glyphInsets(box)
	const x0 = box.x + padX
	const innerW = box.w - padX * 2
	const innerH = box.h - padY * 2
	const labelH = 1.25
	const valueH = Math.min(5.5, innerH * 0.38)
	const valueY = box.y + box.h - padY - valueH
	return (
		<>
			<rect
				x={x0}
				y={box.y + padY}
				width={Math.min(16, innerW * 0.45)}
				height={labelH}
				rx={labelH / 2}
				className="fill-muted-foreground/30"
			/>
			<rect
				x={x0}
				y={valueY}
				width={Math.min(24, innerW * 0.65)}
				height={valueH}
				rx={1.25}
				className="fill-primary/45"
			/>
		</>
	)
}

function RowsGlyph({ box, withMarkers }: { box: Box; withMarkers: boolean }) {
	const { padX, padY } = glyphInsets(box)
	const x0 = box.x + padX
	const innerW = box.w - padX * 2
	const innerH = box.h - padY * 2
	const rows = Math.max(2, Math.min(4, Math.floor(innerH / 7)))
	const rowH = 1.25
	const step = innerH / rows
	const markerW = withMarkers ? 2.5 : 0
	return (
		<>
			{Array.from({ length: rows }, (_, i) => {
				const y = box.y + padY + step * i + (step - rowH) / 2
				// Stagger row widths slightly so it reads as table content, not stripes.
				const widthScale = 1 - (i % 3) * 0.12
				return (
					<g key={i}>
						{withMarkers && (
							<rect
								x={x0}
								y={y}
								width={markerW}
								height={rowH}
								rx={rowH / 2}
								className="fill-primary/40"
							/>
						)}
						<rect
							x={x0 + markerW + (withMarkers ? 2 : 0)}
							y={y}
							width={(innerW - markerW - (withMarkers ? 2 : 0)) * widthScale}
							height={rowH}
							rx={rowH / 2}
							className="fill-muted-foreground/30"
						/>
					</g>
				)
			})}
		</>
	)
}

function EmptyPreview() {
	const x = OUTER_PAD
	const y = OUTER_PAD
	const w = VIEW_W - OUTER_PAD * 2
	const h = VIEW_H - OUTER_PAD * 2
	const cx = VIEW_W / 2
	const cy = VIEW_H / 2
	return (
		<>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={3}
				className="fill-none stroke-border"
				strokeDasharray="4 4"
				vectorEffect="non-scaling-stroke"
			/>
			<path
				d={`M ${cx - 5} ${cy} H ${cx + 5} M ${cx} ${cy - 5} V ${cy + 5}`}
				className="stroke-muted-foreground/60"
				strokeWidth={1.25}
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</>
	)
}

interface TemplatePreviewProps {
	templateId: string
	preview: ReadonlyArray<DashboardTemplatePreviewWidget>
	className?: string
}

export function TemplatePreview({ templateId, preview, className }: TemplatePreviewProps) {
	const rows = useMemo(
		() => Math.max(1, ...preview.map((w) => w.y + w.h)),
		[preview],
	)

	const label =
		preview.length === 0
			? "Empty dashboard layout"
			: `Dashboard layout with ${preview.length} widgets`

	return (
		<svg
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
			className={className}
		>
			{preview.length === 0 ? (
				<EmptyPreview />
			) : (
				preview.map((widget, index) => {
					const box: Box = {
						x: OUTER_PAD + (widget.x / GRID_COLS) * (VIEW_W - OUTER_PAD * 2) + WIDGET_GAP,
						y: OUTER_PAD + (widget.y / rows) * (VIEW_H - OUTER_PAD * 2) + WIDGET_GAP,
						w: (widget.w / GRID_COLS) * (VIEW_W - OUTER_PAD * 2) - WIDGET_GAP * 2,
						h: (widget.h / rows) * (VIEW_H - OUTER_PAD * 2) - WIDGET_GAP * 2,
					}
					const seed = `${templateId}:${widget.title}:${index}`
					return (
						<g key={index} className="opacity-90 transition-opacity duration-150 group-hover:opacity-100">
							<title>{widget.title}</title>
							<rect
								x={box.x}
								y={box.y}
								width={box.w}
								height={box.h}
								rx={2}
								className="fill-muted/25 stroke-border/80"
								vectorEffect="non-scaling-stroke"
							/>
							{(widget.kind === "line" || widget.kind === "area") && (
								<LineGlyph box={box} seed={seed} filled={widget.kind === "area"} />
							)}
							{widget.kind === "bar" && <BarGlyph box={box} seed={seed} />}
							{widget.kind === "stat" && <StatGlyph box={box} />}
							{(widget.kind === "table" || widget.kind === "list") && (
								<RowsGlyph box={box} withMarkers={widget.kind === "list"} />
							)}
						</g>
					)
				})
			)}
		</svg>
	)
}
