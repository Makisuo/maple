import * as React from "react"
import * as ReactDOM from "react-dom"

import { ChevronExpandYIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { getServiceLegendColor } from "@maple/ui/colors"
import { useContainerSize } from "@maple/ui/hooks/use-container-size"
import { useTraceView } from "./trace-view-context"
import { useTraceTimeline } from "./use-trace-timeline"
import { useTimelineGestures } from "./use-timeline-gestures"
import { TraceTimelineSearch } from "./trace-timeline-search"
import { TraceTimelineMinimap } from "./trace-timeline-minimap"
import { TraceTimelineTimeAxis } from "./trace-timeline-time-axis"
import { TraceTimelineTooltipContent } from "./trace-timeline-tooltip"
import { TraceTimelineSidebar, SidebarResizeHandle } from "./trace-timeline-sidebar"
import { TraceTimelineCanvas, type TraceTimelineCanvasHandle } from "./trace-timeline-canvas"
import { useCanvasHitTest } from "./use-canvas-hit-test"
import { useCanvasCrosshair } from "./use-canvas-crosshair"
import { ColorByPicker } from "./color-by-picker"
import {
	ROW_GAP,
	ROW_HEIGHT,
	SIDEBAR_WIDTH_DEFAULT,
	SIDEBAR_WIDTH_MAX,
	SIDEBAR_WIDTH_MIN,
	SIDEBAR_WIDTH_STORAGE_KEY,
} from "./trace-timeline-types"

function readSidebarWidth(): number {
	if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT
	const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
	const n = raw ? Number(raw) : NaN
	if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, n))
}

export function TraceTimeline() {
	const {
		rootSpans,
		totalDurationMs,
		traceStartTime,
		services,
		selectedSpanId,
		onSelectSpan,
		colorBy,
		setColorBy,
	} = useTraceView()
	const containerRef = React.useRef<HTMLDivElement>(null)
	const scrollRef = React.useRef<HTMLDivElement>(null)
	const canvasViewportRef = React.useRef<HTMLDivElement>(null)
	const searchInputRef = React.useRef<HTMLInputElement>(null)
	const canvasHandleRef = React.useRef<TraceTimelineCanvasHandle>(null)
	const [scrollTop, setScrollTop] = React.useState(0)
	const [hoveredSpanId, setHoveredSpanId] = React.useState<string | null>(null)
	const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null)
	const [sidebarWidth, setSidebarWidth] = React.useState<number>(() => readSidebarWidth())

	React.useEffect(() => {
		if (typeof window === "undefined") return
		window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
	}, [sidebarWidth])

	const containerSize = useContainerSize(scrollRef)

	const {
		bars,
		totalRows,
		parentIndexById,
		state,
		dispatch,
		traceStartMs,
		traceEndMs,
		timeAxisTicks,
		searchMatches,
		isSearchActive,
	} = useTraceTimeline({
		rootSpans,
		totalDurationMs,
		traceStartTime,
		services,
		colorBy,
		defaultExpandDepth: Infinity,
	})

	const { barRectsRef, findBarAt } = useCanvasHitTest()

	const requestDraw = React.useCallback((kind: "main" | "overlay" | "both" = "both") => {
		canvasHandleRef.current?.requestDraw(kind)
	}, [])

	const { cursorXRef, setCursorX } = useCanvasCrosshair(() => requestDraw("overlay"))

	const { handleMouseDown, isPanning } = useTimelineGestures({
		scrollRef: canvasViewportRef,
		containerRef: canvasViewportRef,
		viewport: state.viewport,
		containerWidth: Math.max(0, containerSize.width - sidebarWidth),
		traceStartMs,
		traceEndMs,
		dispatch,
		isOnBar: (x, y) => findBarAt(x, y) !== null,
	})

	const handleScroll = React.useCallback(() => {
		if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
	}, [])

	const handleCanvasMouseMove = React.useCallback(
		(e: React.MouseEvent) => {
			const el = canvasViewportRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const cssX = e.clientX - rect.left
			const cssY = e.clientY - rect.top
			setCursorX(cssX)
			const hit = findBarAt(cssX, cssY)
			if (hit) {
				if (hoveredSpanId !== hit.spanId) setHoveredSpanId(hit.spanId)
				setTooltipPos({ x: e.clientX, y: e.clientY })
			} else {
				if (hoveredSpanId !== null) setHoveredSpanId(null)
				setTooltipPos(null)
			}
		},
		[findBarAt, hoveredSpanId, setCursorX],
	)

	const handleCanvasMouseLeave = React.useCallback(() => {
		setCursorX(null)
		setHoveredSpanId(null)
		setTooltipPos(null)
	}, [setCursorX])

	const handleCanvasClick = React.useCallback(
		(e: React.MouseEvent) => {
			const el = canvasViewportRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const hit = findBarAt(e.clientX - rect.left, e.clientY - rect.top)
			if (hit && onSelectSpan) {
				const bar = bars.find((b) => b.span.spanId === hit.spanId)
				if (bar) onSelectSpan(bar.span)
			}
		},
		[bars, findBarAt, onSelectSpan],
	)

	const handleCanvasDoubleClick = React.useCallback(
		(e: React.MouseEvent) => {
			const el = canvasViewportRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const hit = findBarAt(e.clientX - rect.left, e.clientY - rect.top)
			if (!hit) return
			const bar = bars.find((b) => b.span.spanId === hit.spanId)
			if (!bar) return
			dispatch({
				type: "ZOOM_TO_SPAN",
				startMs: bar.startMs,
				endMs: bar.endMs,
				traceStartMs,
				traceEndMs,
			})
		},
		[bars, dispatch, findBarAt, traceEndMs, traceStartMs],
	)

	const handleSidebarBarClick = React.useCallback(
		(spanId: string) => {
			const bar = bars.find((b) => b.span.spanId === spanId)
			if (bar && onSelectSpan) onSelectSpan(bar.span)
		},
		[bars, onSelectSpan],
	)

	const handleSidebarBarDoubleClick = React.useCallback(
		(spanId: string) => {
			const bar = bars.find((b) => b.span.spanId === spanId)
			if (!bar) return
			dispatch({
				type: "ZOOM_TO_SPAN",
				startMs: bar.startMs,
				endMs: bar.endMs,
				traceStartMs,
				traceEndMs,
			})
		},
		[bars, dispatch, traceEndMs, traceStartMs],
	)

	const handleCollapseToggle = React.useCallback(
		(spanId: string) => {
			dispatch({ type: "TOGGLE_COLLAPSE", spanId })
		},
		[dispatch],
	)

	const handleMinimapViewportChange = React.useCallback(
		(viewport: { startMs: number; endMs: number }) => {
			dispatch({ type: "SET_VIEWPORT", viewport })
		},
		[dispatch],
	)

	const handleZoomToFit = React.useCallback(() => {
		dispatch({ type: "ZOOM_TO_FIT", traceStartMs, traceEndMs })
	}, [dispatch, traceStartMs, traceEndMs])

	const handleSidebarResize = React.useCallback((delta: number) => {
		setSidebarWidth((w) =>
			Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w + delta)),
		)
	}, [])

	// Scroll focused row into view when keyboard nav changes it.
	React.useEffect(() => {
		const el = scrollRef.current
		if (!el || state.focusedIndex === null) return
		const rowSize = ROW_HEIGHT + ROW_GAP
		const rowTop = state.focusedIndex * rowSize
		const rowBottom = rowTop + ROW_HEIGHT
		if (rowTop < el.scrollTop) {
			el.scrollTop = rowTop
		} else if (rowBottom > el.scrollTop + el.clientHeight) {
			el.scrollTop = rowBottom - el.clientHeight
		}
	}, [state.focusedIndex])

	const handleKeyDown = React.useCallback(
		(e: React.KeyboardEvent) => {
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault()
					dispatch({ type: "FOCUS_NEXT", maxIndex: bars.length - 1 })
					break
				case "ArrowUp":
					e.preventDefault()
					dispatch({ type: "FOCUS_PREV" })
					break
				case "ArrowRight":
					if (state.focusedIndex !== null) {
						const bar = bars[state.focusedIndex]
						if (bar?.hasChildren && bar.isCollapsed) {
							dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
						}
					}
					break
				case "ArrowLeft":
					if (state.focusedIndex !== null) {
						const bar = bars[state.focusedIndex]
						if (bar?.hasChildren && !bar.isCollapsed) {
							dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
						}
					}
					break
				case "Enter":
				case " ":
					if (state.focusedIndex !== null) {
						e.preventDefault()
						const bar = bars[state.focusedIndex]
						if (bar && onSelectSpan) onSelectSpan(bar.span)
					}
					break
				case "/":
					e.preventDefault()
					searchInputRef.current?.focus()
					break
				case "+":
				case "=":
					e.preventDefault()
					if (state.focusedIndex !== null) {
						const bar = bars[state.focusedIndex]
						if (bar) {
							const centerMs = (bar.startMs + bar.endMs) / 2
							dispatch({ type: "ZOOM", centerMs, factor: 1.3, traceStartMs, traceEndMs })
						}
					} else {
						const centerMs = (state.viewport.startMs + state.viewport.endMs) / 2
						dispatch({ type: "ZOOM", centerMs, factor: 1.3, traceStartMs, traceEndMs })
					}
					break
				case "-":
					e.preventDefault()
					{
						const centerMs = (state.viewport.startMs + state.viewport.endMs) / 2
						dispatch({ type: "ZOOM", centerMs, factor: 1 / 1.3, traceStartMs, traceEndMs })
					}
					break
				case "Escape":
					if (state.searchQuery) {
						dispatch({ type: "SET_SEARCH", query: "" })
					} else if (state.focusedIndex !== null) {
						dispatch({ type: "SET_FOCUSED_INDEX", index: null })
					}
					break
			}
		},
		[
			state.focusedIndex,
			state.searchQuery,
			state.viewport,
			bars,
			dispatch,
			onSelectSpan,
			traceStartMs,
			traceEndMs,
		],
	)

	const hoveredSpan = React.useMemo(
		() => (hoveredSpanId ? bars.find((b) => b.span.spanId === hoveredSpanId)?.span ?? null : null),
		[bars, hoveredSpanId],
	)

	if (rootSpans.length === 0) {
		return (
			<div className="border p-8 text-center">
				<p className="text-muted-foreground">No spans found for this trace</p>
			</div>
		)
	}

	const fullDuration = traceEndMs - traceStartMs
	const visibleDuration = state.viewport.endMs - state.viewport.startMs
	const isZoomed = visibleDuration < fullDuration * 0.95

	return (
		<div
			ref={containerRef}
			className="border flex flex-col h-full outline-none relative"
			tabIndex={0}
			onKeyDown={handleKeyDown}
		>
			<TraceTimelineSearch
				query={state.searchQuery}
				onQueryChange={(q) => dispatch({ type: "SET_SEARCH", query: q })}
				matchCount={searchMatches.size}
				totalCount={bars.length}
				inputRef={searchInputRef}
			/>

			<div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 shrink-0">
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="font-medium">Timeline</span>
					<span className="tabular-nums">{bars.length} spans</span>
				</div>
				<div className="flex items-center gap-1">
					<ColorByPicker value={colorBy} onChange={setColorBy} rootSpans={rootSpans} />
					{isZoomed && (
						<Button
							variant="ghost"
							size="sm"
							onClick={handleZoomToFit}
							className="h-5 gap-1 text-[10px] px-2"
						>
							<ChevronExpandYIcon size={11} />
							Fit
						</Button>
					)}
				</div>
			</div>

			<TraceTimelineMinimap
				rootSpans={rootSpans}
				totalDurationMs={totalDurationMs}
				traceStartMs={traceStartMs}
				traceEndMs={traceEndMs}
				services={services}
				colorBy={colorBy}
				viewport={state.viewport}
				onViewportChange={handleMinimapViewportChange}
			/>

			<div className="flex border-b border-border shrink-0">
				<div style={{ width: sidebarWidth }} className="shrink-0 border-r border-border" />
				<div className="flex-1 min-w-0">
					<TraceTimelineTimeAxis
						viewport={state.viewport}
						ticks={timeAxisTicks}
						traceStartMs={traceStartMs}
					/>
				</div>
			</div>

			<div className="flex flex-1 min-h-0 relative">
				<div
					ref={scrollRef}
					className="overflow-y-auto overflow-x-hidden shrink-0"
					style={{ width: sidebarWidth }}
					onScroll={handleScroll}
				>
					<TraceTimelineSidebar
						bars={bars}
						totalRows={totalRows}
						scrollTop={scrollTop}
						containerHeight={containerSize.height}
						selectedSpanId={selectedSpanId}
						focusedIndex={state.focusedIndex}
						searchMatches={searchMatches}
						isSearchActive={isSearchActive}
						hoveredSpanId={hoveredSpanId}
						width={sidebarWidth}
						services={services}
						onBarClick={handleSidebarBarClick}
						onBarDoubleClick={handleSidebarBarDoubleClick}
						onCollapseToggle={handleCollapseToggle}
						onHoverSpan={setHoveredSpanId}
					/>
				</div>
				<div className="relative flex-1 min-w-0">
					<SidebarResizeHandle onResize={handleSidebarResize} />
					<div
						ref={canvasViewportRef}
						className="absolute inset-0"
						style={{
							cursor: isPanning.current ? "grabbing" : "crosshair",
						}}
						onMouseMove={handleCanvasMouseMove}
						onMouseLeave={handleCanvasMouseLeave}
						onMouseDown={handleMouseDown}
						onClick={handleCanvasClick}
						onDoubleClick={handleCanvasDoubleClick}
						onWheel={(e) => {
							// Forward vertical wheel to the sidebar scroller so the canvas
							// stays in sync. Horizontal wheel is consumed by the gestures hook.
							if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.ctrlKey && !e.metaKey) {
								if (scrollRef.current) {
									scrollRef.current.scrollTop += e.deltaY
								}
							}
						}}
					>
						<TraceTimelineCanvas
							ref={canvasHandleRef}
							bars={bars}
							totalRows={totalRows}
							parentIndexById={parentIndexById}
							viewport={state.viewport}
							traceStartMs={traceStartMs}
							timeAxisTicks={timeAxisTicks}
							scrollTop={scrollTop}
							selectedSpanId={selectedSpanId}
							focusedIndex={state.focusedIndex}
							searchMatches={searchMatches}
							isSearchActive={isSearchActive}
							barRectsRef={barRectsRef}
							cursorXRef={cursorXRef}
							hoveredSpanId={hoveredSpanId}
						/>
					</div>
				</div>
			</div>

			<div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground shrink-0">
				<div className="flex items-center gap-3 text-foreground/30">
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Click
						</kbd>{" "}
						select
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Dbl-click
						</kbd>{" "}
						zoom
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Ctrl+Scroll
						</kbd>{" "}
						zoom
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							/
						</kbd>{" "}
						search
					</span>
				</div>
				<div className="flex items-center gap-2.5">
					{services.map((service) => (
						<div key={service} className="flex items-center gap-1">
							<div
								className="size-2 shrink-0"
								style={{ backgroundColor: getServiceLegendColor(service, services) }}
							/>
							<span className="font-medium">{service}</span>
						</div>
					))}
					<div className="flex items-center gap-1">
						<div className="size-2 bg-destructive shrink-0" />
						<span className="font-medium">Error</span>
					</div>
				</div>
			</div>

			{hoveredSpan &&
				tooltipPos &&
				ReactDOM.createPortal(
					<div
						className="fixed z-[9999] pointer-events-none"
						style={{
							left: tooltipPos.x,
							top: tooltipPos.y - 8,
							transform: "translate(-50%, -100%)",
						}}
					>
						<div className="bg-popover text-popover-foreground border border-border shadow-lg p-2.5 max-w-sm">
							<TraceTimelineTooltipContent
								span={hoveredSpan}
								services={services}
								totalDurationMs={totalDurationMs}
								traceStartTime={traceStartTime}
							/>
						</div>
					</div>,
					document.body,
				)}
		</div>
	)
}
