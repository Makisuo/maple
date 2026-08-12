import * as React from "react"

import { spanStartMs } from "../../lib/span-tree"
import type { SpanNode } from "../../lib/types"
import { HANDLE_HIT_AREA, MINIMAP_HEIGHT, MIN_RANGE_FRAC } from "./trace-timeline-types"
import { formatDuration } from "../../lib/format"
import { getValueHue } from "../../lib/colors"
import { resolveColorValue, isStatusCodePreset, type ColorByField } from "./color-by"
import { viewportBounds } from "./clamp-viewport"
import type { ViewportController } from "./use-viewport-controller"

interface TraceTimelineMinimapProps {
	rootSpans: SpanNode[]
	colorBy: ColorByField
	controller: ViewportController
}

interface MinimapSpan {
	spanId: string
	depth: number
	leftPercent: number
	widthPercent: number
	bgColor: string
	isError: boolean
}

const NEUTRAL_MINIMAP_BG = "oklch(0.50 0.02 0)"
/** Errors pop in the minimap so a trace-scale error scan works (Honeycomb pattern). */
const ERROR_MINIMAP_BG = "oklch(0.62 0.22 25)"
/** Movement (px) before a press outside the viewport rect becomes a reframe drag instead of a jump. */
const REFRAME_THRESHOLD_PX = 3

function collectMinimapSpans(
	rootSpans: SpanNode[],
	domainStartMs: number,
	domainDurationMs: number,
	colorBy: ColorByField,
): { spans: MinimapSpan[]; maxDepth: number } {
	const spans: MinimapSpan[] = []
	let maxDepth = 0
	const statusPreset = isStatusCodePreset(colorBy)

	function visit(node: SpanNode) {
		const startMs = spanStartMs(node)
		// Positioned against the padded viewport bounds, the same space the ruler and the span
		// bars use, so a given instant lands at the same x in the strip and in the column.
		const leftPercent = ((startMs - domainStartMs) / domainDurationMs) * 100
		const widthPercent = (node.durationMs / domainDurationMs) * 100
		maxDepth = Math.max(maxDepth, node.depth)

		const isError = node.statusCode === "Error"
		let bgColor: string
		if (isError && !statusPreset) {
			bgColor = ERROR_MINIMAP_BG
		} else {
			const value = resolveColorValue(node, colorBy)
			const hue = getValueHue(value)
			bgColor = hue === null ? NEUTRAL_MINIMAP_BG : `oklch(0.50 0.14 ${hue})`
		}

		const clampedLeft = Math.max(0, leftPercent)
		spans.push({
			spanId: node.spanId,
			depth: node.depth,
			leftPercent: clampedLeft,
			widthPercent: Math.min(widthPercent, 100 - clampedLeft),
			bgColor,
			isError,
		})

		node.children.forEach(visit)
	}

	rootSpans.forEach(visit)
	// Errors last → painted on top of same-position siblings.
	spans.sort((a, b) => Number(a.isError) - Number(b.isError))
	return { spans, maxDepth }
}

/**
 * The span silhouette. One node per span and no virtualization, so on a 2000-span trace this is
 * 2000 elements — which is exactly why it is split out and memoized: it depends on the tree and
 * the colour scheme, never on the viewport, so a pan or zoom must not re-render it.
 */
const MinimapBars = React.memo(function MinimapBars({
	rootSpans,
	domainStartMs,
	domainDurationMs,
	colorBy,
}: {
	rootSpans: SpanNode[]
	domainStartMs: number
	domainDurationMs: number
	colorBy: ColorByField
}) {
	const { spans, maxDepth } = React.useMemo(
		() => collectMinimapSpans(rootSpans, domainStartMs, domainDurationMs, colorBy),
		[rootSpans, domainStartMs, domainDurationMs, colorBy],
	)

	// Fit every depth level inside the strip: deep traces compress the row pitch evenly
	// instead of piling everything past a fixed depth onto the bottom row.
	const pitch = Math.max(1, Math.min(4, Math.floor((MINIMAP_HEIGHT - 4) / (maxDepth + 1))))
	const rowH = Math.max(1, pitch - 1)

	return (
		<div className="pointer-events-none absolute inset-0" style={{ paddingTop: 2, paddingBottom: 2 }}>
			{spans.map((s) => (
				<div
					key={s.spanId}
					className="absolute"
					style={{
						top: Math.min(2 + s.depth * pitch, MINIMAP_HEIGHT - rowH - 2),
						left: `${s.leftPercent}%`,
						width: `${Math.max(s.widthPercent, 0.2)}%`,
						height: rowH,
						backgroundColor: s.bgColor,
					}}
				/>
			))}
		</div>
	)
})

type DragType = "pan" | "resize-left" | "resize-right" | "reframe"

/** Pointer x as a 0–100 percentage of the strip, clamped to it. */
function pctInStrip(clientX: number, rect: DOMRect): number {
	return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
}

export function TraceTimelineMinimap({ rootSpans, colorBy, controller }: TraceTimelineMinimapProps) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const guideRef = React.useRef<HTMLDivElement>(null)
	// The viewport rect and the two dimming masks, driven imperatively by the controller
	// subscription below — the whole point is that a gesture re-renders nothing here either.
	const rectRef = React.useRef<HTMLDivElement>(null)
	const dimLeftRef = React.useRef<HTMLDivElement>(null)
	const dimRightRef = React.useRef<HTMLDivElement>(null)
	const brushRef = React.useRef<HTMLDivElement>(null)

	const dragRef = React.useRef<{
		type: DragType
		startX: number
		moved: boolean
		startStartMs: number
		startEndMs: number
		rect: DOMRect
	} | null>(null)

	const traceStartMs = controller.traceStartMs

	// The strip spans the padded viewport bounds, not the bare trace — identical to the space the
	// ruler and the span bars are drawn in, so trace-zero lands at the same x in both. It also
	// means the viewport can never exceed the strip, so the clamp in `fracs` is a guard rather
	// than the thing holding the rect inside its container.
	const { loMs: domainStartMs, durationMs: domainDuration } = React.useMemo(
		() => viewportBounds(controller.traceStartMs, controller.traceEndMs),
		[controller.traceStartMs, controller.traceEndMs],
	)

	/** Current viewport as [0,1] fractions of the strip. */
	const fracs = React.useCallback(
		(vp: { startMs: number; endMs: number }) => {
			const start = (vp.startMs - domainStartMs) / domainDuration
			const end = (vp.endMs - domainStartMs) / domainDuration
			return { start: Math.max(0, Math.min(1, start)), end: Math.max(0, Math.min(1, end)) }
		},
		[domainStartMs, domainDuration],
	)

	React.useEffect(() => {
		const paint = (vp: { startMs: number; endMs: number }) => {
			const { start, end } = fracs(vp)
			const leftPct = start * 100
			// Keep a hairline visible at extreme zoom, but never let it push past the right edge.
			const widthPct = Math.min(Math.max((end - start) * 100, 0.5), 100 - leftPct)
			const rect = rectRef.current
			if (rect) {
				rect.style.left = `${leftPct}%`
				rect.style.width = `${widthPct}%`
			}
			if (dimLeftRef.current) dimLeftRef.current.style.width = `${leftPct}%`
			if (dimRightRef.current) dimRightRef.current.style.left = `${leftPct + widthPct}%`
		}
		return controller.subscribe(paint)
	}, [controller, fracs])

	const setCursor = React.useCallback((cursor: string) => {
		if (containerRef.current) containerRef.current.style.cursor = cursor
	}, [])

	const handlePointerDown = React.useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return
			const el = containerRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			if (rect.width === 0) return
			controller.cancelAnimation()

			const vp = controller.get()
			const { start, end } = fracs(vp)
			const x = (e.clientX - rect.left) / rect.width
			// Hit-test in px, not percent. A percent threshold that looks right at a 50% viewport
			// swallows the whole rect at 3%, which is exactly when you most want to resize it.
			const handleFrac = HANDLE_HIT_AREA / rect.width

			let type: DragType
			if (Math.abs(x - start) <= handleFrac) type = "resize-left"
			else if (Math.abs(x - end) <= handleFrac) type = "resize-right"
			else if (x > start && x < end) type = "pan"
			else type = "reframe"

			dragRef.current = {
				type,
				startX: e.clientX,
				moved: false,
				// Seed from the *clamped* window, matching where the handle is actually drawn.
				// Seeding from the raw window makes a handle grabbed at a strip edge sit up to
				// 5% of the trace away from the value it's dragging, so the first slice of the
				// drag reads as a dead zone. Identical to `vp` for any mid-trace window.
				startStartMs: domainStartMs + start * domainDuration,
				startEndMs: domainStartMs + end * domainDuration,
				rect,
			}
			el.setPointerCapture(e.pointerId)
			setCursor(type === "pan" ? "grabbing" : type === "reframe" ? "crosshair" : "col-resize")
			if (guideRef.current) guideRef.current.style.display = "none"
			e.preventDefault()
		},
		[controller, fracs, setCursor, domainStartMs, domainDuration],
	)

	const handlePointerMove = React.useCallback(
		(e: React.PointerEvent) => {
			const d = dragRef.current
			const el = containerRef.current
			if (!el) return

			if (!d) {
				// Idle: hover guide (line + readout), written imperatively — no re-render per pixel.
				const rect = el.getBoundingClientRect()
				if (rect.width === 0) return
				const x = e.clientX - rect.left
				const frac = x / rect.width
				const vp = controller.get()
				const { start, end } = fracs(vp)
				const handleFrac = HANDLE_HIT_AREA / rect.width
				setCursor(
					Math.abs(frac - start) <= handleFrac || Math.abs(frac - end) <= handleFrac
						? "col-resize"
						: frac > start && frac < end
							? "grab"
							: "crosshair",
				)
				const node = guideRef.current
				if (node) {
					node.style.display = "block"
					node.style.transform = `translateX(${x}px)`
					const label = node.firstElementChild as HTMLElement | null
					if (label) {
						// Readout stays relative to the *trace* start, matching the ruler's "+Nms" —
						// the strip's own origin sits 5% before it and would report negative time.
						const offsetMs = domainStartMs + frac * domainDuration - traceStartMs
						label.textContent = `+${formatDuration(offsetMs)}`
						label.style.transform =
							x > rect.width - 70 ? "translateX(calc(-100% - 5px))" : "translateX(5px)"
					}
				}
				return
			}

			const deltaMs = ((e.clientX - d.startX) / d.rect.width) * domainDuration
			// The smallest window the minimap will hand over. Matched to what clampViewport will
			// accept, so a resize handle can't be dragged into a range the clamp then widens —
			// which reads as the handle fighting the cursor.
			const minRangeMs = Math.max(domainDuration * MIN_RANGE_FRAC, 0)

			switch (d.type) {
				case "pan":
					controller.set({ startMs: d.startStartMs + deltaMs, endMs: d.startEndMs + deltaMs })
					break
				case "resize-left":
					controller.set({
						startMs: Math.min(d.startStartMs + deltaMs, d.startEndMs - minRangeMs),
						endMs: d.startEndMs,
					})
					break
				case "resize-right":
					controller.set({
						startMs: d.startStartMs,
						endMs: Math.max(d.startEndMs + deltaMs, d.startStartMs + minRangeMs),
					})
					break
				case "reframe": {
					if (!d.moved && Math.abs(e.clientX - d.startX) <= REFRAME_THRESHOLD_PX) return
					d.moved = true
					// Clamped: a brush dragged off the end of the strip would otherwise paint a
					// preview wider than its container and push the page sideways.
					const a = pctInStrip(d.startX, d.rect)
					const b = pctInStrip(e.clientX, d.rect)
					const brush = brushRef.current
					if (brush) {
						brush.style.display = "block"
						brush.style.left = `${Math.min(a, b)}%`
						brush.style.width = `${Math.abs(b - a)}%`
					}
					break
				}
			}
		},
		[controller, fracs, setCursor, domainStartMs, domainDuration, traceStartMs],
	)

	const handlePointerUp = React.useCallback(
		(e: React.PointerEvent) => {
			const d = dragRef.current
			dragRef.current = null
			containerRef.current?.releasePointerCapture?.(e.pointerId)
			setCursor("crosshair")
			if (brushRef.current) brushRef.current.style.display = "none"
			if (!d || d.type !== "reframe") return

			const frac = (clientX: number) => (clientX - d.rect.left) / d.rect.width
			if (d.moved) {
				// Commit the brushed range (either drag direction).
				const a = frac(d.startX)
				const b = frac(e.clientX)
				controller.zoomToRange(
					domainStartMs + Math.min(a, b) * domainDuration,
					domainStartMs + Math.max(a, b) * domainDuration,
				)
			} else {
				// Plain click: jump the viewport centre to the clicked position, same width.
				const clickMs = domainStartMs + frac(e.clientX) * domainDuration
				const width = d.startEndMs - d.startStartMs
				controller.set({ startMs: clickMs - width / 2, endMs: clickMs + width / 2 })
			}
		},
		[controller, setCursor, domainStartMs, domainDuration],
	)

	const handlePointerLeave = React.useCallback(() => {
		if (!dragRef.current && guideRef.current) guideRef.current.style.display = "none"
	}, [])

	return (
		<div
			ref={containerRef}
			// overflow-hidden: the strip is the trace, and nothing positioned against it — rect,
			// masks, brush, hover guide — has any business painting outside. Without it an
			// out-of-range child widens the flex row and the whole page gains a scrollbar.
			className="relative overflow-hidden border-b border-border bg-muted/10 cursor-crosshair select-none touch-none"
			style={{ height: MINIMAP_HEIGHT }}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onPointerLeave={handlePointerLeave}
			onDoubleClick={() => controller.fit()}
			title="Drag to select a range · click to jump · drag the edges to resize · double-click to fit"
		>
			<MinimapBars
				rootSpans={rootSpans}
				domainStartMs={domainStartMs}
				domainDurationMs={domainDuration}
				colorBy={colorBy}
			/>

			{/* Dimmed areas outside the viewport */}
			<div
				ref={dimLeftRef}
				className="pointer-events-none absolute inset-y-0 left-0 bg-background/60"
				style={{ width: 0 }}
			/>
			<div
				ref={dimRightRef}
				className="pointer-events-none absolute inset-y-0 right-0 bg-background/60"
				style={{ left: "100%" }}
			/>

			{/* Brush preview while reframing */}
			<div
				ref={brushRef}
				className="pointer-events-none absolute inset-y-0 border-x border-primary/70 bg-primary/15"
				style={{ display: "none" }}
			/>

			{/* Hover guide: line + time readout (imperative) */}
			<div
				ref={guideRef}
				className="pointer-events-none absolute inset-y-0 left-0 w-px bg-foreground/40"
				style={{ display: "none" }}
			>
				<span className="absolute top-0 whitespace-nowrap bg-background/90 px-1 font-mono text-[9px] leading-3 text-muted-foreground" />
			</div>

			{/* Viewport rect. Pointer-transparent: hit-testing happens against the container so the
			    8px edge zones straddle the border instead of being split by it. */}
			<div
				ref={rectRef}
				className="pointer-events-none absolute inset-y-0 border-x-2 border-primary/60"
				style={{ left: 0, width: "100%" }}
			/>
		</div>
	)
}
