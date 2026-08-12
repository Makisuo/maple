import * as React from "react"

import { formatDuration } from "../../lib/format"
import { DRAG_ZOOM_THRESHOLD_PX } from "./trace-timeline-types"
import type { ViewportController } from "./use-viewport-controller"

interface UseTimelineInteractionsOptions {
	/**
	 * The vertical-scroll container gestures are measured against. We use its `clientWidth`
	 * (scrollbar excluded) so px↔time math lines up with the `%`-positioned bars. The timeline
	 * column starts at x = `sidebarWidth`; the overlay divs share this element's left edge.
	 */
	bodyRef: React.RefObject<HTMLElement | null>
	sidebarWidth: number
	controller: ViewportController
}

/** A marquee rectangle, in px relative to `bodyRef`'s left edge. */
export interface MarqueeRect {
	x: number
	width: number
}

export interface TimelineInteractions {
	/** Active drag-to-zoom selection rectangle, or null. */
	marquee: MarqueeRect | null
	/**
	 * Attach to an always-mounted crosshair div; its position/visibility is driven
	 * imperatively (rAF-coalesced) so mousemove never re-renders the timeline.
	 */
	crosshairRef: React.RefObject<HTMLDivElement | null>
	/** The drag currently in flight ("zoom" marquee or "pan"), or null. */
	dragMode: DragMode | null
	/** True while a pan or zoom-marquee drag is in flight (callers can suppress hover, etc.). */
	isDragging: boolean
	/** Trace time (ms) under the cursor, or null when the cursor is outside the timeline column. */
	getCursorTimeMs: () => number | null
	/** Spread onto `bodyRef`'s element. */
	handlers: {
		onPointerDown: (e: React.PointerEvent) => void
		onPointerMove: (e: React.PointerEvent) => void
		onPointerLeave: () => void
	}
	/**
	 * Set by a completed drag-zoom so the row's `onClick` (select span) is swallowed.
	 * Read-and-reset it from an `onClickCapture` on the body.
	 */
	suppressClickRef: React.RefObject<boolean>
}

export type DragMode = "zoom" | "pan"

interface DragState {
	mode: DragMode
	startX: number
	lastX: number
	moved: boolean
	timelineLeft: number
	timelineWidth: number
	bodyLeft: number
	startStartMs: number
	startEndMs: number
}

/**
 * Pointer + wheel gestures for the timeline:
 * - drag across the timeline → marquee → zoom to range (a tap stays a span click)
 * - shift-drag / middle-button drag → pan
 * - ctrl/⌘ + wheel → cursor-anchored zoom
 * - shift + wheel / horizontal wheel → pan; plain vertical wheel → native row scroll
 *
 * Every gesture writes straight through the `ViewportController`, which clamps, updates the CSS
 * custom properties the bars read, and notifies the minimap and ruler — no `setState`, so a
 * drag or a wheel-zoom produces no React commits at all. Only the marquee rectangle, which has
 * no CSS-var representation, is React state.
 */
export function useTimelineInteractions({
	bodyRef,
	sidebarWidth,
	controller,
}: UseTimelineInteractionsOptions): TimelineInteractions {
	const [marquee, setMarquee] = React.useState<MarqueeRect | null>(null)
	const [dragMode, setDragMode] = React.useState<DragMode | null>(null)
	const suppressClickRef = React.useRef(false)
	const dragRef = React.useRef<DragState | null>(null)

	// Live refs so imperative handlers (crosshair label, cursor-time queries) never go stale.
	const sidebarWidthRef = React.useRef(sidebarWidth)
	sidebarWidthRef.current = sidebarWidth

	const pxToTimeMs = React.useCallback(
		(x: number): number | null => {
			const el = bodyRef.current
			if (!el) return null
			const sw = sidebarWidthRef.current
			const width = el.clientWidth - sw
			if (width <= 0 || x < sw) return null
			const vp = controller.get()
			return vp.startMs + ((x - sw) / width) * (vp.endMs - vp.startMs)
		},
		[bodyRef, controller],
	)

	// Crosshair is positioned imperatively — mousemove must not re-render the component.
	const crosshairRef = React.useRef<HTMLDivElement | null>(null)
	const crosshairXRef = React.useRef<number | null>(null)
	const crosshairRafRef = React.useRef(0)

	const applyCrosshair = React.useCallback(() => {
		const node = crosshairRef.current
		if (!node) return
		const x = crosshairXRef.current
		if (x === null) {
			node.style.display = "none"
			return
		}
		node.style.display = "block"
		node.style.transform = `translateX(${x}px)`
		// Time readout riding the crosshair (child span, written imperatively).
		const label = node.firstElementChild as HTMLElement | null
		if (label) {
			const timeMs = pxToTimeMs(x)
			if (timeMs === null) {
				label.style.display = "none"
			} else {
				label.style.display = "block"
				label.textContent = `+${formatDuration(timeMs - controller.traceStartMs)}`
				// Flip to the left side of the line near the right edge so it stays readable.
				const el = bodyRef.current
				const nearRightEdge = el ? x > el.clientWidth - 80 : false
				label.style.transform = nearRightEdge ? "translateX(calc(-100% - 6px))" : "translateX(6px)"
			}
		}
	}, [bodyRef, controller, pxToTimeMs])

	const setCrosshairX = React.useCallback(
		(x: number | null) => {
			crosshairXRef.current = x
			cancelAnimationFrame(crosshairRafRef.current)
			if (x === null) {
				applyCrosshair() // hide immediately; a stale frame must not resurface it
			} else {
				crosshairRafRef.current = requestAnimationFrame(applyCrosshair)
			}
		},
		[applyCrosshair],
	)

	React.useEffect(() => () => cancelAnimationFrame(crosshairRafRef.current), [])

	// The crosshair readout is relative to the window, so it goes stale when the viewport moves
	// under a parked cursor (keyboard zoom, minimap drag). Repaint it with everything else.
	React.useEffect(
		() => controller.subscribe(() => (crosshairXRef.current === null ? undefined : applyCrosshair())),
		[controller, applyCrosshair],
	)

	const onPointerDown = React.useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) return
			const el = bodyRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const x = e.clientX - rect.left
			// Gestures only originate in the timeline column.
			if (x < sidebarWidth) return
			suppressClickRef.current = false
			controller.cancelAnimation()

			const vp = controller.get()
			const mode: DragMode = e.shiftKey || e.button === 1 ? "pan" : "zoom"
			dragRef.current = {
				mode,
				startX: x,
				lastX: x,
				moved: false,
				timelineLeft: sidebarWidth,
				timelineWidth: el.clientWidth - sidebarWidth,
				bodyLeft: rect.left,
				startStartMs: vp.startMs,
				startEndMs: vp.endMs,
			}

			const handleMove = (ev: PointerEvent) => {
				const d = dragRef.current
				if (!d) return
				const px = ev.clientX - d.bodyLeft
				if (!d.moved && Math.abs(px - d.startX) > DRAG_ZOOM_THRESHOLD_PX) {
					d.moved = true
					setDragMode(d.mode)
				}
				if (!d.moved) return
				if (d.mode === "pan") {
					const deltaPx = px - d.lastX
					d.lastX = px
					// Against the *live* window, not the one captured at pointer-down: a pan that
					// hits the clamp must not accumulate phantom offset the cursor has to undo.
					const live = controller.get()
					const deltaMs = -(deltaPx / d.timelineWidth) * (live.endMs - live.startMs)
					controller.panBy(deltaMs)
				} else {
					const lo = Math.max(d.timelineLeft, Math.min(d.startX, px))
					const hi = Math.min(d.timelineLeft + d.timelineWidth, Math.max(d.startX, px))
					setMarquee({ x: lo, width: Math.max(0, hi - lo) })
				}
			}

			const handleUp = (ev: PointerEvent) => {
				const d = dragRef.current
				dragRef.current = null
				window.removeEventListener("pointermove", handleMove)
				window.removeEventListener("pointerup", handleUp)
				setDragMode(null)
				setMarquee(null)
				if (!d || !d.moved) return
				if (d.mode === "zoom") {
					// The marquee was drawn against the window as it stood at pointer-down, which
					// hasn't moved during the drag, so resolve both edges against that snapshot.
					const start = { startMs: d.startStartMs, endMs: d.startEndMs }
					const px = ev.clientX - d.bodyLeft
					const a = pxToMsStatic(d.startX, d.timelineLeft, d.timelineWidth, start)
					const b = pxToMsStatic(px, d.timelineLeft, d.timelineWidth, start)
					suppressClickRef.current = true
					controller.zoomToRange(a, b)
				} else {
					// A pan still ends on a row; swallow the trailing click.
					suppressClickRef.current = true
				}
			}

			window.addEventListener("pointermove", handleMove)
			window.addEventListener("pointerup", handleUp)
			// No preventDefault here — a plain press must still reach the row's onClick. Text
			// selection during a drag is suppressed via `select-none` on the container.
		},
		[bodyRef, controller, sidebarWidth],
	)

	const onPointerMove = React.useCallback(
		(e: React.PointerEvent) => {
			if (dragRef.current) return // crosshair is steady while dragging
			const el = bodyRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const x = e.clientX - rect.left
			setCrosshairX(x >= sidebarWidth ? x : null)
		},
		[bodyRef, sidebarWidth, setCrosshairX],
	)

	const onPointerLeave = React.useCallback(() => {
		if (!dragRef.current) setCrosshairX(null)
	}, [setCrosshairX])

	const handleWheel = React.useEffectEvent((e: WheelEvent) => {
		const el = bodyRef.current
		if (!el) return
		const sw = sidebarWidth
		const rect = el.getBoundingClientRect()
		const x = e.clientX - rect.left
		if (x < sw) return // over the sidebar → let rows scroll natively
		const timelineWidth = el.clientWidth - sw
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault()
			controller.cancelAnimation()
			const centerMs = pxToMsStatic(x, sw, timelineWidth, controller.get())
			controller.zoomAt(centerMs, e.deltaY < 0 ? 1.15 : 1 / 1.15)
		} else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			e.preventDefault()
			controller.cancelAnimation()
			const vp = controller.get()
			const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
			controller.panBy((delta / Math.max(1, timelineWidth)) * (vp.endMs - vp.startMs))
		}
		// else: plain vertical wheel → native scroll (don't preventDefault)
	})

	// Native wheel listener (passive:false) so ctrl-wheel zoom / horizontal pan can preventDefault.
	React.useEffect(() => {
		const el = bodyRef.current
		if (!el) return
		el.addEventListener("wheel", handleWheel, { passive: false })
		return () => el.removeEventListener("wheel", handleWheel)
	}, [bodyRef])

	const getCursorTimeMs = React.useCallback(
		() => (crosshairXRef.current === null ? null : pxToTimeMs(crosshairXRef.current)),
		[pxToTimeMs],
	)

	return {
		marquee,
		crosshairRef,
		dragMode,
		isDragging: dragMode !== null,
		getCursorTimeMs,
		handlers: { onPointerDown, onPointerMove, onPointerLeave },
		suppressClickRef,
	}
}

function pxToMsStatic(
	px: number,
	left: number,
	width: number,
	vp: { startMs: number; endMs: number },
): number {
	const visible = vp.endMs - vp.startMs
	const frac = width > 0 ? (px - left) / width : 0
	return vp.startMs + frac * visible
}
