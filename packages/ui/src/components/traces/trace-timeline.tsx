import * as React from "react"
import * as ReactDOM from "react-dom"
import { useVirtualizer } from "@tanstack/react-virtual"

import { ChevronExpandYIcon } from "../icons"
import { Button } from "../ui/button"
import { getServiceColor } from "../../lib/colors"
import { useContainerSize } from "../../hooks/use-container-size"
import { useTraceView } from "./trace-view-context"
import { useTraceTimeline } from "./use-trace-timeline"
import { collectAllCollapsibleIds } from "./auto-collapse"
import { useTimelineInteractions } from "./use-timeline-interactions"
import { TraceTimelineSearch } from "./trace-timeline-search"
import { TraceTimelineMinimap } from "./trace-timeline-minimap"
import { TraceTimelineTimeAxis } from "./trace-timeline-time-axis"
import { TraceTimelineTooltipContent } from "./trace-timeline-tooltip"
import { SidebarResizeHandle } from "./trace-timeline-sidebar"
import { TraceTimelineRow } from "./trace-timeline-row"
import { ColorByPicker } from "./color-by-picker"
import {
	OVERSCAN,
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
	const searchInputRef = React.useRef<HTMLInputElement>(null)
	const [hoveredSpanId, setHoveredSpanId] = React.useState<string | null>(null)
	const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null)
	const [sidebarWidth, setSidebarWidth] = React.useState<number>(() => readSidebarWidth())

	React.useEffect(() => {
		if (typeof window === "undefined") return
		window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
	}, [sidebarWidth])

	const {
		bars,
		barIndexBySpanId,
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
		colorBy,
		keepVisibleSpanId: selectedSpanId,
	})

	const containerSize = useContainerSize(scrollRef)
	const timelineWidthPx = Math.max(0, containerSize.width - sidebarWidth)

	const rowVirtualizer = useVirtualizer({
		count: bars.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT + ROW_GAP,
		overscan: OVERSCAN,
	})

	const interactions = useTimelineInteractions({
		bodyRef: scrollRef,
		sidebarWidth,
		viewport: state.viewport,
		traceStartMs,
		traceEndMs,
		dispatch,
	})

	const handleSelect = React.useCallback(
		(spanId: string) => {
			const idx = barIndexBySpanId.get(spanId)
			if (idx === undefined || !onSelectSpan) return
			onSelectSpan(bars[idx].span)
		},
		[bars, barIndexBySpanId, onSelectSpan],
	)

	const handleZoomSpan = React.useCallback(
		(spanId: string) => {
			const idx = barIndexBySpanId.get(spanId)
			if (idx === undefined) return
			const bar = bars[idx]
			dispatch({
				type: "ZOOM_TO_SPAN",
				startMs: bar.startMs,
				endMs: bar.endMs,
				traceStartMs,
				traceEndMs,
			})
		},
		[bars, barIndexBySpanId, dispatch, traceStartMs, traceEndMs],
	)

	const handleToggleCollapse = React.useCallback(
		(spanId: string) => dispatch({ type: "TOGGLE_COLLAPSE", spanId }),
		[dispatch],
	)

	const isDragging = interactions.isDragging
	const handleHover = React.useCallback(
		(spanId: string | null, pos: { x: number; y: number } | null) => {
			if (isDragging) return
			setHoveredSpanId(spanId)
			setTooltipPos(pos)
		},
		[isDragging],
	)

	const handleMinimapViewportChange = React.useCallback(
		(viewport: { startMs: number; endMs: number }) => dispatch({ type: "SET_VIEWPORT", viewport }),
		[dispatch],
	)

	const handleZoomToFit = React.useCallback(
		() => dispatch({ type: "ZOOM_TO_FIT", traceStartMs, traceEndMs }),
		[dispatch, traceStartMs, traceEndMs],
	)

	const handleExpandAll = React.useCallback(
		() => dispatch({ type: "EXPAND_ALL", spanIds: [...collectAllCollapsibleIds(rootSpans)] }),
		[dispatch, rootSpans],
	)

	const handleCollapseAll = React.useCallback(() => dispatch({ type: "COLLAPSE_ALL" }), [dispatch])

	const handleSidebarResize = React.useCallback((delta: number) => {
		setSidebarWidth((w) => Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w + delta)))
	}, [])

	// Bring the selected (e.g. deep-linked) span into view. `align: "auto"` is a no-op when it's
	// already visible, so clicking a visible span never jumps the scroll.
	const prevSelectedRef = React.useRef<string | undefined>(undefined)
	React.useEffect(() => {
		if (!selectedSpanId || selectedSpanId === prevSelectedRef.current) return
		prevSelectedRef.current = selectedSpanId
		const idx = barIndexBySpanId.get(selectedSpanId)
		if (idx !== undefined) rowVirtualizer.scrollToIndex(idx, { align: "auto" })
	}, [selectedSpanId, barIndexBySpanId, rowVirtualizer])

	// Keep the keyboard-focused row visible.
	React.useEffect(() => {
		if (state.focusedIndex !== null) rowVirtualizer.scrollToIndex(state.focusedIndex, { align: "auto" })
	}, [state.focusedIndex, rowVirtualizer])

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
				case "=": {
					e.preventDefault()
					const bar = state.focusedIndex !== null ? bars[state.focusedIndex] : null
					const centerMs = bar
						? (bar.startMs + bar.endMs) / 2
						: (state.viewport.startMs + state.viewport.endMs) / 2
					dispatch({ type: "ZOOM", centerMs, factor: 1.3, traceStartMs, traceEndMs })
					break
				}
				case "-": {
					e.preventDefault()
					const centerMs = (state.viewport.startMs + state.viewport.endMs) / 2
					dispatch({ type: "ZOOM", centerMs, factor: 1 / 1.3, traceStartMs, traceEndMs })
					break
				}
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

	const hoveredSpan = React.useMemo(() => {
		if (!hoveredSpanId) return null
		const idx = barIndexBySpanId.get(hoveredSpanId)
		return idx === undefined ? null : bars[idx].span
	}, [bars, barIndexBySpanId, hoveredSpanId])

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
	const virtualItems = rowVirtualizer.getVirtualItems()

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
					<Button
						variant="ghost"
						size="sm"
						onClick={handleExpandAll}
						className="h-5 text-[10px] px-2"
					>
						Expand all
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleCollapseAll}
						className="h-5 text-[10px] px-2"
					>
						Collapse all
					</Button>
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

			{/* Minimap, aligned under the timeline column via a sidebar-width spacer. */}
			<div className="flex shrink-0">
				<div
					style={{ width: sidebarWidth }}
					className="shrink-0 border-b border-r border-border bg-muted/10"
				/>
				<div className="flex-1 min-w-0">
					<TraceTimelineMinimap
						rootSpans={rootSpans}
						traceStartMs={traceStartMs}
						traceEndMs={traceEndMs}
						colorBy={colorBy}
						viewport={state.viewport}
						onViewportChange={handleMinimapViewportChange}
					/>
				</div>
			</div>

			{/* Time-axis ruler, aligned the same way. */}
			<div className="flex border-b border-border shrink-0">
				<div style={{ width: sidebarWidth }} className="shrink-0 border-r border-border" />
				<div className="flex-1 min-w-0 relative">
					<TraceTimelineTimeAxis
						viewport={state.viewport}
						ticks={timeAxisTicks}
						traceStartMs={traceStartMs}
					/>
				</div>
			</div>

			{/* Body: one vertical scroll, two cells per row, gesture overlays on top. */}
			<div className="relative flex flex-1 min-h-0">
				<div
					ref={scrollRef}
					className="flex-1 overflow-auto select-none"
					style={{ scrollbarGutter: "stable" }}
					onPointerDown={interactions.handlers.onPointerDown}
					onPointerMove={interactions.handlers.onPointerMove}
					onPointerLeave={interactions.handlers.onPointerLeave}
					onClickCapture={(e) => {
						if (interactions.suppressClickRef.current) {
							e.stopPropagation()
							interactions.suppressClickRef.current = false
						}
					}}
				>
					<div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
						{virtualItems.map((vi) => {
							const bar = bars[vi.index]
							if (!bar) return null
							const id = bar.span.spanId
							const matched = isSearchActive && searchMatches.has(id)
							return (
								<TraceTimelineRow
									key={id}
									bar={bar}
									top={vi.start}
									sidebarWidth={sidebarWidth}
									timelineWidthPx={timelineWidthPx}
									viewport={state.viewport}
									selected={selectedSpanId === id}
									focused={state.focusedIndex === vi.index}
									hovered={hoveredSpanId === id}
									dimmed={isSearchActive && !matched}
									matched={matched}
									onSelect={handleSelect}
									onToggleCollapse={handleToggleCollapse}
									onZoomSpan={handleZoomSpan}
									onHover={handleHover}
								/>
							)
						})}
					</div>
				</div>

				<SidebarResizeHandle left={sidebarWidth} onResize={handleSidebarResize} />

				{/* Crosshair + drag-zoom marquee (px relative to the scroll container's left edge). */}
				{interactions.crosshairX != null && (
					<div
						className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-foreground/40"
						style={{ left: interactions.crosshairX }}
					/>
				)}
				{interactions.marquee && (
					<div
						className="pointer-events-none absolute top-0 bottom-0 z-20 border-x border-primary/70 bg-primary/15"
						style={{ left: interactions.marquee.x, width: interactions.marquee.width }}
					/>
				)}
			</div>

			<div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground shrink-0">
				<div className="flex items-center gap-3 text-foreground/30">
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Drag
						</kbd>{" "}
						zoom
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Dbl-click
						</kbd>{" "}
						zoom span
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							⌘+Scroll
						</kbd>{" "}
						zoom
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							Shift+Drag
						</kbd>{" "}
						pan
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
								style={{ backgroundColor: getServiceColor(service) }}
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
				!isDragging &&
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
