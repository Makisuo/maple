import * as React from "react"

import type { BarRect, TimelineBar, ViewportState } from "./trace-timeline-types"
import { OVERSCAN } from "./trace-timeline-types"
import { useCanvasSetup } from "./use-canvas-setup"
import { drawMain, drawOverlay } from "./use-canvas-draw"

interface TraceTimelineCanvasProps {
	bars: TimelineBar[]
	totalRows: number
	parentIndexById: Map<string, number>
	viewport: ViewportState
	traceStartMs: number
	timeAxisTicks: number[]
	scrollTop: number
	selectedSpanId?: string
	focusedIndex: number | null
	searchMatches: Set<string>
	isSearchActive: boolean
	barRectsRef: React.MutableRefObject<BarRect[]>
	cursorXRef: React.MutableRefObject<number | null>
	hoveredSpanId: string | null
	onSizeChange?: (cssW: number, cssH: number) => void
}

export interface TraceTimelineCanvasHandle {
	requestDraw: (kind?: "main" | "overlay" | "both") => void
	cssWidth: number
}

export const TraceTimelineCanvas = React.forwardRef<TraceTimelineCanvasHandle, TraceTimelineCanvasProps>(
	function TraceTimelineCanvas(
		{
			bars,
			totalRows,
			parentIndexById,
			viewport,
			traceStartMs,
			timeAxisTicks,
			scrollTop,
			selectedSpanId,
			focusedIndex,
			searchMatches,
			isSearchActive,
			barRectsRef,
			cursorXRef,
			hoveredSpanId,
			onSizeChange,
		},
		ref,
	) {
		const containerRef = React.useRef<HTMLDivElement>(null)
		const mainCanvasRef = React.useRef<HTMLCanvasElement>(null)
		const overlayCanvasRef = React.useRef<HTMLCanvasElement>(null)

		const mainSize = useCanvasSetup(mainCanvasRef, containerRef)
		const overlaySize = useCanvasSetup(overlayCanvasRef, containerRef)

		const rafId = React.useRef(0)
		const needsMain = React.useRef(false)
		const needsOverlay = React.useRef(false)

		// Latest props captured for the rAF callback so we always paint with fresh state.
		const latest = React.useRef({
			bars,
			totalRows,
			parentIndexById,
			viewport,
			traceStartMs,
			timeAxisTicks,
			scrollTop,
			selectedSpanId,
			focusedIndex,
			searchMatches,
			isSearchActive,
			hoveredSpanId,
			mainSize,
		})
		latest.current = {
			bars,
			totalRows,
			parentIndexById,
			viewport,
			traceStartMs,
			timeAxisTicks,
			scrollTop,
			selectedSpanId,
			focusedIndex,
			searchMatches,
			isSearchActive,
			hoveredSpanId,
			mainSize,
		}

		const performDraw = React.useCallback(() => {
			rafId.current = 0
			const state = latest.current
			if (needsMain.current) {
				needsMain.current = false
				const canvas = mainCanvasRef.current
				if (canvas) {
					const ctx = canvas.getContext("2d")
					if (ctx) {
						const dpr = state.mainSize.dpr
						ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
						const { barRects } = drawMain({
							ctx,
							cssW: state.mainSize.width,
							cssH: state.mainSize.height,
							bars: state.bars,
							totalRows: state.totalRows,
							parentIndexById: state.parentIndexById,
							viewport: state.viewport,
							scrollTop: state.scrollTop,
							traceStartMs: state.traceStartMs,
							timeAxisTicks: state.timeAxisTicks,
							overscan: OVERSCAN,
							selectedSpanId: state.selectedSpanId,
							focusedIndex: state.focusedIndex,
							searchMatches: state.searchMatches,
							isSearchActive: state.isSearchActive,
							hoveredSpanId: state.hoveredSpanId,
						})
						barRectsRef.current = barRects
					}
				}
			}
			if (needsOverlay.current) {
				needsOverlay.current = false
				const canvas = overlayCanvasRef.current
				if (canvas) {
					const ctx = canvas.getContext("2d")
					if (ctx) {
						const dpr = state.mainSize.dpr
						ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
						drawOverlay(
							ctx,
							state.mainSize.width,
							state.mainSize.height,
							cursorXRef.current,
							state.viewport,
							state.traceStartMs,
						)
					}
				}
			}
		}, [barRectsRef, cursorXRef])

		const requestDraw = React.useCallback(
			(kind: "main" | "overlay" | "both" = "both") => {
				if (kind !== "overlay") needsMain.current = true
				if (kind !== "main") needsOverlay.current = true
				if (rafId.current) cancelAnimationFrame(rafId.current)
				rafId.current = requestAnimationFrame(performDraw)
			},
			[performDraw],
		)

		React.useImperativeHandle(
			ref,
			() => ({ requestDraw, cssWidth: mainSize.width }),
			[requestDraw, mainSize.width],
		)

		// Trigger redraw whenever any drawing input changes.
		React.useEffect(() => {
			requestDraw("main")
		}, [
			bars,
			totalRows,
			viewport,
			scrollTop,
			selectedSpanId,
			focusedIndex,
			searchMatches,
			isSearchActive,
			hoveredSpanId,
			timeAxisTicks,
			traceStartMs,
			parentIndexById,
			mainSize.width,
			mainSize.height,
			mainSize.dpr,
			requestDraw,
		])

		React.useEffect(() => {
			requestDraw("overlay")
		}, [overlaySize.width, overlaySize.height, overlaySize.dpr, requestDraw])

		// Notify parent of size changes for layout decisions.
		React.useEffect(() => {
			onSizeChange?.(mainSize.width, mainSize.height)
		}, [mainSize.width, mainSize.height, onSizeChange])

		React.useEffect(() => {
			return () => {
				if (rafId.current) {
					cancelAnimationFrame(rafId.current)
					rafId.current = 0
				}
			}
		}, [])

		return (
			<div ref={containerRef} className="absolute inset-0">
				<canvas ref={mainCanvasRef} className="absolute inset-0 block" />
				<canvas
					ref={overlayCanvasRef}
					className="absolute inset-0 block pointer-events-none"
				/>
			</div>
		)
	},
)
