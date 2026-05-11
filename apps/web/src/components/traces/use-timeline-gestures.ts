import * as React from "react"
import { clampViewport } from "./use-trace-timeline"

interface Viewport {
	startMs: number
	endMs: number
}

type TimelineAction =
	| { type: "PAN"; deltaMs: number; traceStartMs: number; traceEndMs: number }
	| { type: "ZOOM"; centerMs: number; factor: number; traceStartMs: number; traceEndMs: number }
	| { type: "SET_VIEWPORT"; viewport: Viewport }

interface UseTimelineGesturesOptions {
	scrollRef: React.RefObject<HTMLElement | null>
	containerRef: React.RefObject<HTMLElement | null>
	viewport: Viewport
	containerWidth: number
	traceStartMs: number
	traceEndMs: number
	dispatch: (action: TimelineAction) => void
	/**
	 * Returns true when the cursor is over a bar — used to decide whether
	 * mousedown starts a pan or is treated as a click on a bar.
	 */
	isOnBar?: (cssX: number, cssY: number) => boolean
}

/**
 * Encapsulates wheel-zoom and mouse-drag-pan gestures for the trace timeline.
 * Returns event handler props to attach to the canvas container.
 */
export function useTimelineGestures({
	scrollRef,
	containerRef,
	viewport,
	containerWidth,
	traceStartMs,
	traceEndMs,
	dispatch,
	isOnBar,
}: UseTimelineGesturesOptions) {
	const isPanning = React.useRef(false)
	const panStart = React.useRef<{ x: number; viewportStartMs: number; viewportEndMs: number } | null>(null)

	// Scroll-wheel zoom — use native listener to avoid passive event issue
	const wheelHandlerRef = React.useRef<(e: WheelEvent) => void>(undefined)
	wheelHandlerRef.current = (e: WheelEvent) => {
		// Horizontal scroll = pan
		if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && containerWidth > 0) {
			const visibleDuration = viewport.endMs - viewport.startMs
			const deltaMs = (e.deltaX / containerWidth) * visibleDuration
			dispatch({ type: "PAN", deltaMs, traceStartMs, traceEndMs })
			e.preventDefault()
			return
		}

		// Ctrl/Cmd + scroll = zoom
		if (e.deltaY !== 0 && (e.ctrlKey || e.metaKey)) {
			e.preventDefault()
			const el = scrollRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const mouseX = e.clientX - rect.left
			const mousePercent = mouseX / rect.width
			const visibleDuration = viewport.endMs - viewport.startMs
			const centerMs = viewport.startMs + mousePercent * visibleDuration

			const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
			dispatch({ type: "ZOOM", centerMs, factor, traceStartMs, traceEndMs })
		}
	}

	React.useEffect(() => {
		const el = scrollRef.current
		if (!el) return
		const handler = (e: WheelEvent) => wheelHandlerRef.current?.(e)
		el.addEventListener("wheel", handler, { passive: false })
		return () => el.removeEventListener("wheel", handler)
	}, [scrollRef])

	// Panning via mouse drag (only when not on a bar)
	const handleMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			const el = containerRef.current
			if (el && isOnBar) {
				const rect = el.getBoundingClientRect()
				const cssX = e.clientX - rect.left
				const cssY = e.clientY - rect.top
				if (isOnBar(cssX, cssY)) return
			}

			isPanning.current = true
			panStart.current = {
				x: e.clientX,
				viewportStartMs: viewport.startMs,
				viewportEndMs: viewport.endMs,
			}
			e.preventDefault()
		},
		[viewport, containerRef, isOnBar],
	)

	React.useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isPanning.current || !panStart.current || !containerRef.current) return
			const rect = containerRef.current.getBoundingClientRect()
			const deltaPercent = (e.clientX - panStart.current.x) / rect.width
			const visibleDuration = panStart.current.viewportEndMs - panStart.current.viewportStartMs
			const deltaMs = -deltaPercent * visibleDuration
			dispatch({
				type: "SET_VIEWPORT",
				viewport: clampViewport(
					{
						startMs: panStart.current.viewportStartMs + deltaMs,
						endMs: panStart.current.viewportEndMs + deltaMs,
					},
					traceStartMs,
					traceEndMs,
				),
			})
		}

		const handleMouseUp = () => {
			isPanning.current = false
			panStart.current = null
		}

		window.addEventListener("mousemove", handleMouseMove)
		window.addEventListener("mouseup", handleMouseUp)
		return () => {
			window.removeEventListener("mousemove", handleMouseMove)
			window.removeEventListener("mouseup", handleMouseUp)
		}
	}, [containerRef, dispatch, traceStartMs, traceEndMs])

	return {
		isPanning,
		handleMouseDown,
	}
}
