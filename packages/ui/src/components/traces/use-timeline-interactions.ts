import * as React from "react"

import type { TimelineAction, ViewportState } from "./trace-timeline-types"
import { DRAG_ZOOM_THRESHOLD_PX } from "./trace-timeline-types"

interface UseTimelineInteractionsOptions {
	/**
	 * The vertical-scroll container gestures are measured against. We use its `clientWidth`
	 * (scrollbar excluded) so px↔time math lines up with the `%`-positioned bars. The timeline
	 * column starts at x = `sidebarWidth`; the overlay divs share this element's left edge.
	 */
	bodyRef: React.RefObject<HTMLElement | null>
	sidebarWidth: number
	viewport: ViewportState
	traceStartMs: number
	traceEndMs: number
	dispatch: (action: TimelineAction) => void
}

/** A marquee rectangle, in px relative to `bodyRef`'s left edge. */
export interface MarqueeRect {
	x: number
	width: number
}

export interface TimelineInteractions {
	/** Active drag-to-zoom selection rectangle, or null. */
	marquee: MarqueeRect | null
	/** Cursor x within the timeline column (px from bodyRef left), or null when outside. */
	crosshairX: number | null
	/** True while a pan or zoom-marquee drag is in flight (callers can suppress hover, etc.). */
	isDragging: boolean
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

type DragMode = "zoom" | "pan"

interface DragState {
	mode: DragMode
	startX: number
	lastX: number
	moved: boolean
	timelineLeft: number
	timelineWidth: number
	bodyLeft: number
	startViewport: ViewportState
}

/**
 * Pointer + wheel gestures for the DOM timeline:
 * - drag across the timeline → marquee → ZOOM_TO_RANGE (a tap stays a span click)
 * - shift-drag / middle-button drag → PAN
 * - ctrl/⌘ + wheel → cursor-anchored ZOOM
 * - shift + wheel / horizontal wheel → PAN; plain vertical wheel → native row scroll
 *
 * The visible window is captured at pointer-down: a marquee dispatches nothing until release,
 * and a pan dispatches *relative* deltas, so neither needs the live viewport mid-drag — which
 * keeps the window listeners free of stale-closure bugs.
 */
export function useTimelineInteractions({
	bodyRef,
	sidebarWidth,
	viewport,
	traceStartMs,
	traceEndMs,
	dispatch,
}: UseTimelineInteractionsOptions): TimelineInteractions {
	const [marquee, setMarquee] = React.useState<MarqueeRect | null>(null)
	const [crosshairX, setCrosshairX] = React.useState<number | null>(null)
	const [isDragging, setIsDragging] = React.useState(false)
	const suppressClickRef = React.useRef(false)
	const dragRef = React.useRef<DragState | null>(null)

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

			const mode: DragMode = e.shiftKey || e.button === 1 ? "pan" : "zoom"
			dragRef.current = {
				mode,
				startX: x,
				lastX: x,
				moved: false,
				timelineLeft: sidebarWidth,
				timelineWidth: el.clientWidth - sidebarWidth,
				bodyLeft: rect.left,
				startViewport: viewport,
			}

			const handleMove = (ev: PointerEvent) => {
				const d = dragRef.current
				if (!d) return
				const px = ev.clientX - d.bodyLeft
				if (!d.moved && Math.abs(px - d.startX) > DRAG_ZOOM_THRESHOLD_PX) {
					d.moved = true
					setIsDragging(true)
				}
				if (!d.moved) return
				if (d.mode === "pan") {
					const deltaPx = px - d.lastX
					d.lastX = px
					const visible = d.startViewport.endMs - d.startViewport.startMs
					const deltaMs = -(deltaPx / d.timelineWidth) * visible
					dispatch({ type: "PAN", deltaMs, traceStartMs, traceEndMs })
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
				setIsDragging(false)
				setMarquee(null)
				if (!d || !d.moved) return
				if (d.mode === "zoom") {
					const px = ev.clientX - d.bodyLeft
					const a = pxToMsStatic(d.startX, d.timelineLeft, d.timelineWidth, d.startViewport)
					const b = pxToMsStatic(px, d.timelineLeft, d.timelineWidth, d.startViewport)
					suppressClickRef.current = true
					dispatch({
						type: "ZOOM_TO_RANGE",
						startMs: a,
						endMs: b,
						traceStartMs,
						traceEndMs,
					})
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
		[bodyRef, dispatch, sidebarWidth, viewport, traceStartMs, traceEndMs],
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
		[bodyRef, sidebarWidth],
	)

	const onPointerLeave = React.useCallback(() => {
		if (!dragRef.current) setCrosshairX(null)
	}, [])

	const handleWheel = React.useEffectEvent((e: WheelEvent) => {
		const el = bodyRef.current
		if (!el) return
		const sw = sidebarWidth
		const vp = viewport
		const rect = el.getBoundingClientRect()
		const x = e.clientX - rect.left
		if (x < sw) return // over the sidebar → let rows scroll natively
		const timelineLeft = sw
		const timelineWidth = el.clientWidth - sw
		const visible = vp.endMs - vp.startMs
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault()
			const centerMs = pxToMsStatic(x, timelineLeft, timelineWidth, vp)
			const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
			dispatch({ type: "ZOOM", centerMs, factor, traceStartMs, traceEndMs })
		} else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			e.preventDefault()
			const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
			const deltaMs = (delta / Math.max(1, timelineWidth)) * visible
			dispatch({ type: "PAN", deltaMs, traceStartMs, traceEndMs })
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

	return {
		marquee,
		crosshairX,
		isDragging,
		handlers: { onPointerDown, onPointerMove, onPointerLeave },
		suppressClickRef,
	}
}

function pxToMsStatic(px: number, left: number, width: number, vp: ViewportState): number {
	const visible = vp.endMs - vp.startMs
	const frac = width > 0 ? (px - left) / width : 0
	return vp.startMs + frac * visible
}
