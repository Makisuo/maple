import type { BarRect, TimelineBar, ViewportState } from "./trace-timeline-types"
import { ROW_GAP, ROW_HEIGHT } from "./trace-timeline-types"
import { CANVAS_COLORS, crisp, truncateText } from "./draw-helpers"
import { formatDuration } from "@/lib/format"

const FONT = '500 11px ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace'

interface DrawArgs {
	ctx: CanvasRenderingContext2D
	cssW: number
	cssH: number
	bars: TimelineBar[]
	totalRows: number
	parentIndexById: Map<string, number>
	viewport: ViewportState
	scrollTop: number
	traceStartMs: number
	timeAxisTicks: number[]
	overscan: number
	selectedSpanId?: string
	focusedIndex: number | null
	searchMatches: Set<string>
	isSearchActive: boolean
	hoveredSpanId: string | null
}

export interface DrawResult {
	barRects: BarRect[]
}

export function drawMain(args: DrawArgs): DrawResult {
	const {
		ctx,
		cssW,
		cssH,
		bars,
		totalRows,
		parentIndexById,
		viewport,
		scrollTop,
		traceStartMs,
		timeAxisTicks,
		overscan,
		selectedSpanId,
		focusedIndex,
		searchMatches,
		isSearchActive,
		hoveredSpanId,
	} = args

	ctx.clearRect(0, 0, cssW, cssH)

	const visibleMs = viewport.endMs - viewport.startMs
	if (visibleMs <= 0 || cssW <= 0 || cssH <= 0) return { barRects: [] }

	const rowSize = ROW_HEIGHT + ROW_GAP
	const firstRow = Math.max(0, Math.floor(scrollTop / rowSize) - overscan)
	const lastRow = Math.min(totalRows - 1, Math.ceil((scrollTop + cssH) / rowSize) + overscan)

	drawBackground(ctx, cssW, cssH, viewport, traceStartMs, timeAxisTicks)
	drawConnectors(ctx, bars, parentIndexById, firstRow, lastRow, scrollTop, viewport, cssW, cssH)

	const barRects: BarRect[] = []
	ctx.font = FONT
	ctx.textBaseline = "middle"

	for (let i = firstRow; i <= lastRow; i++) {
		const bar = bars[i]
		if (!bar) continue
		if (bar.endMs < viewport.startMs || bar.startMs > viewport.endMs) continue

		const xRaw = ((bar.startMs - viewport.startMs) / visibleMs) * cssW
		const wRaw = ((bar.endMs - bar.startMs) / visibleMs) * cssW
		// Clamp display rect inside viewport; track unclamped left for label anchor
		const x = Math.max(0, xRaw)
		const right = Math.min(cssW, xRaw + Math.max(1, wRaw))
		const w = Math.max(1, right - x)
		const y = bar.row * rowSize - scrollTop
		const dimmed = isSearchActive && !searchMatches.has(bar.span.spanId)
		drawSpanBar(ctx, bar, x, y, w, dimmed)
		barRects.push({ spanId: bar.span.spanId, row: bar.row, x, y, w, h: ROW_HEIGHT })
	}

	drawRings(ctx, barRects, selectedSpanId, focusedIndex, hoveredSpanId, isSearchActive, searchMatches)
	drawEventDots()

	return { barRects }
}

function drawBackground(
	ctx: CanvasRenderingContext2D,
	cssW: number,
	cssH: number,
	viewport: ViewportState,
	traceStartMs: number,
	ticks: number[],
) {
	const visibleMs = viewport.endMs - viewport.startMs
	ctx.save()
	ctx.strokeStyle = CANVAS_COLORS.gridLine
	ctx.lineWidth = 1
	ctx.beginPath()
	for (const offsetMs of ticks) {
		const absMs = traceStartMs + offsetMs
		const x = ((absMs - viewport.startMs) / visibleMs) * cssW
		if (x < -1 || x > cssW + 1) continue
		const xc = crisp(x)
		ctx.moveTo(xc, 0)
		ctx.lineTo(xc, cssH)
	}
	ctx.stroke()
	ctx.restore()
}

function drawConnectors(
	ctx: CanvasRenderingContext2D,
	bars: TimelineBar[],
	parentIndexById: Map<string, number>,
	firstRow: number,
	lastRow: number,
	scrollTop: number,
	viewport: ViewportState,
	cssW: number,
	cssH: number,
) {
	const visibleMs = viewport.endMs - viewport.startMs
	const rowSize = ROW_HEIGHT + ROW_GAP
	ctx.save()
	ctx.lineWidth = 1
	ctx.globalAlpha = 0.35

	for (let i = firstRow; i <= lastRow; i++) {
		const bar = bars[i]
		if (!bar || !bar.parentSpanId) continue
		const parentIdx = parentIndexById.get(bar.span.spanId)
		if (parentIdx === undefined) continue
		const parent = bars[parentIdx]
		if (!parent) continue

		const xFrac = (bar.startMs - viewport.startMs) / visibleMs
		if (xFrac < -0.01 || xFrac > 1.01) continue
		const x = crisp(xFrac * cssW)

		const parentY = parent.row * rowSize - scrollTop + ROW_HEIGHT
		const childY = bar.row * rowSize - scrollTop + ROW_HEIGHT / 2

		// Skip when both endpoints are above or both below the viewport.
		if (parentY > cssH && childY > cssH) continue
		if (parentY < 0 && childY < 0) continue

		ctx.strokeStyle = parent.borderColor
		ctx.beginPath()
		ctx.moveTo(x, parentY)
		ctx.lineTo(x, childY)
		ctx.lineTo(x + 4, childY)
		ctx.stroke()
	}
	ctx.restore()
}

function drawSpanBar(
	ctx: CanvasRenderingContext2D,
	bar: TimelineBar,
	x: number,
	y: number,
	w: number,
	dimmed: boolean,
) {
	ctx.save()
	if (dimmed) ctx.globalAlpha = 0.35

	// Fill
	ctx.fillStyle = bar.fill
	ctx.fillRect(x, y, w, ROW_HEIGHT)

	// Left border in service color (3px)
	const borderW = Math.min(3, w)
	ctx.fillStyle = bar.borderColor
	ctx.fillRect(x, y, borderW, ROW_HEIGHT)

	// Text labels when bar is wide enough
	if (w > 60) {
		const padX = borderW + 6
		const innerW = w - padX - 6
		if (innerW > 0) {
			const name = bar.span.spanName
			// Reserve room for duration when very wide
			const showDuration = w > 200
			let nameMax = innerW
			let durationText = ""
			let durationW = 0
			if (showDuration) {
				durationText = formatDuration(bar.span.durationMs)
				durationW = ctx.measureText(durationText).width
				nameMax = Math.max(0, innerW - durationW - 12)
			}
			const truncated = truncateText(ctx, name, nameMax)
			if (truncated.length > 0) {
				ctx.fillStyle = bar.isError ? "oklch(0.95 0.05 25)" : CANVAS_COLORS.barLabel
				ctx.fillText(truncated, x + padX, y + ROW_HEIGHT / 2)
			}
			if (showDuration && durationText) {
				ctx.fillStyle = CANVAS_COLORS.barLabelMuted
				ctx.fillText(durationText, x + w - durationW - 6, y + ROW_HEIGHT / 2)
			}
		}
	}

	ctx.restore()
}

function drawRings(
	ctx: CanvasRenderingContext2D,
	barRects: BarRect[],
	selectedSpanId: string | undefined,
	focusedIndex: number | null,
	hoveredSpanId: string | null,
	isSearchActive: boolean,
	searchMatches: Set<string>,
) {
	if (barRects.length === 0) return
	ctx.save()
	for (const r of barRects) {
		const isMatch = isSearchActive && searchMatches.has(r.spanId)
		if (isMatch) {
			ctx.strokeStyle = CANVAS_COLORS.matchRing
			ctx.lineWidth = 1
			ctx.setLineDash([])
			ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
		}
		if (hoveredSpanId && r.spanId === hoveredSpanId) {
			ctx.strokeStyle = "oklch(0.95 0 0 / 0.45)"
			ctx.lineWidth = 1
			ctx.setLineDash([])
			ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
		}
		if (selectedSpanId && r.spanId === selectedSpanId) {
			ctx.strokeStyle = CANVAS_COLORS.selectedRing
			ctx.lineWidth = 2
			ctx.setLineDash([])
			ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2)
		}
		if (focusedIndex !== null && r.row === focusedIndex) {
			ctx.strokeStyle = CANVAS_COLORS.focusRing
			ctx.lineWidth = 1.5
			ctx.setLineDash([4, 2])
			ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5)
			ctx.setLineDash([])
		}
	}
	ctx.restore()
}

// Reserved for Phase 2 when span events are plumbed through SpanNode.
function drawEventDots() {
	// no-op
}

export function drawOverlay(
	ctx: CanvasRenderingContext2D,
	cssW: number,
	cssH: number,
	cursorX: number | null,
	viewport: ViewportState,
	traceStartMs: number,
) {
	ctx.clearRect(0, 0, cssW, cssH)
	if (cursorX == null || cssW <= 0 || cssH <= 0) return

	const visibleMs = viewport.endMs - viewport.startMs
	const xc = crisp(cursorX)
	ctx.save()
	ctx.strokeStyle = CANVAS_COLORS.crosshair
	ctx.lineWidth = 1
	ctx.beginPath()
	ctx.moveTo(xc, 0)
	ctx.lineTo(xc, cssH)
	ctx.stroke()

	// Pill at top with time-from-trace-start
	const t = viewport.startMs + (cursorX / cssW) * visibleMs - traceStartMs
	const label = formatDuration(t)
	ctx.font = FONT
	const textW = ctx.measureText(label).width
	const padX = 6
	const pillH = 16
	const pillW = Math.ceil(textW + padX * 2)
	let pillX = cursorX - pillW / 2
	pillX = Math.max(4, Math.min(cssW - pillW - 4, pillX))
	const pillY = 4

	ctx.fillStyle = CANVAS_COLORS.crosshairPillBg
	ctx.fillRect(pillX, pillY, pillW, pillH)
	ctx.strokeStyle = CANVAS_COLORS.crosshairPillBorder
	ctx.lineWidth = 1
	ctx.strokeRect(pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1)

	ctx.fillStyle = CANVAS_COLORS.crosshairPillText
	ctx.textBaseline = "middle"
	ctx.fillText(label, pillX + padX, pillY + pillH / 2)
	ctx.restore()
}
