import * as React from "react"
import * as ReactDOM from "react-dom"
import { useVirtualizer } from "@tanstack/react-virtual"

import { ChevronExpandYIcon } from "../icons"
import { Button } from "../ui/button"
import { getServiceColor } from "../../lib/colors"
import { useContainerSize } from "../../hooks/use-container-size"
import { useTraceView } from "./trace-view-context"
import { clampViewport, useTraceTimeline } from "./use-trace-timeline"
import type { ViewportState } from "./trace-timeline-types"
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
	const [sidebarWidth, setSidebarWidth] = React.useState<number>(() => readSidebarWidth())

	// Tooltip position is driven imperatively (ref + rAF) so mousemoves inside one span
	// never re-render the timeline; React state only changes when the hovered span changes.
	const hoveredIdRef = React.useRef<string | null>(null)
	const tooltipNodeRef = React.useRef<HTMLDivElement | null>(null)
	const tooltipPosRef = React.useRef<{ x: number; y: number } | null>(null)
	const tooltipRafRef = React.useRef(0)

	const applyTooltipPos = React.useCallback(() => {
		const node = tooltipNodeRef.current
		const pos = tooltipPosRef.current
		if (!node || !pos) return
		node.style.transform = `translate3d(${pos.x}px, ${pos.y - 8}px, 0) translate(-50%, -100%)`
	}, [])

	React.useEffect(() => () => cancelAnimationFrame(tooltipRafRef.current), [])

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

	// --- Viewport animation (DevTools-style tween; Sentry-style eased zoom-to-span) ---
	// Direct gestures (wheel, drags) stay instant; keyboard and programmatic zooms animate.
	const viewportRef = React.useRef(state.viewport)
	viewportRef.current = state.viewport
	const viewportAnimRef = React.useRef(0)
	const cancelViewportAnimation = React.useCallback(
		() => cancelAnimationFrame(viewportAnimRef.current),
		[],
	)
	const animateViewportTo = React.useCallback(
		(target: ViewportState, durationMs = 160) => {
			cancelAnimationFrame(viewportAnimRef.current)
			const clamped = clampViewport(target, traceStartMs, traceEndMs)
			const from = { ...viewportRef.current }
			const t0 = performance.now()
			const step = (now: number) => {
				const t = Math.min(1, (now - t0) / durationMs)
				const k = Math.sin((t * Math.PI) / 2) // easeOutSine
				dispatch({
					type: "SET_VIEWPORT",
					viewport: {
						startMs: from.startMs + (clamped.startMs - from.startMs) * k,
						endMs: from.endMs + (clamped.endMs - from.endMs) * k,
					},
					traceStartMs,
					traceEndMs,
				})
				if (t < 1) viewportAnimRef.current = requestAnimationFrame(step)
			}
			viewportAnimRef.current = requestAnimationFrame(step)
		},
		[dispatch, traceStartMs, traceEndMs],
	)
	React.useEffect(() => () => cancelAnimationFrame(viewportAnimRef.current), [])

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
		onGestureStart: cancelViewportAnimation,
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
			const padding = Math.max((bar.endMs - bar.startMs) * 0.1, 0.001)
			animateViewportTo({ startMs: bar.startMs - padding, endMs: bar.endMs + padding }, 220)
		},
		[bars, barIndexBySpanId, animateViewportTo],
	)

	const handleToggleCollapse = React.useCallback(
		(spanId: string) => dispatch({ type: "TOGGLE_COLLAPSE", spanId }),
		[dispatch],
	)

	const isDragging = interactions.isDragging
	const handleHover = React.useCallback(
		(spanId: string | null, pos: { x: number; y: number } | null) => {
			if (isDragging) return
			tooltipPosRef.current = pos
			if (spanId !== hoveredIdRef.current) {
				hoveredIdRef.current = spanId
				setHoveredSpanId(spanId)
				return // the layout effect below positions the freshly mounted tooltip
			}
			if (spanId === null) return
			cancelAnimationFrame(tooltipRafRef.current)
			tooltipRafRef.current = requestAnimationFrame(applyTooltipPos)
		},
		[isDragging, applyTooltipPos],
	)

	// Position the tooltip synchronously when it mounts for a new span, so it never
	// flashes at a stale location before the first mousemove-driven rAF lands.
	React.useLayoutEffect(() => {
		if (hoveredSpanId) applyTooltipPos()
	}, [hoveredSpanId, applyTooltipPos])

	const handleMinimapViewportChange = React.useCallback(
		(viewport: { startMs: number; endMs: number }) =>
			dispatch({ type: "SET_VIEWPORT", viewport, traceStartMs, traceEndMs }),
		[dispatch, traceStartMs, traceEndMs],
	)

	const handleZoomToFit = React.useCallback(() => {
		const padding = (traceEndMs - traceStartMs) * 0.02
		animateViewportTo({ startMs: traceStartMs - padding, endMs: traceEndMs + padding }, 220)
	}, [animateViewportTo, traceStartMs, traceEndMs])

	const handleExpandAll = React.useCallback(
		() => dispatch({ type: "EXPAND_ALL", spanIds: [...collectAllCollapsibleIds(rootSpans)] }),
		[dispatch, rootSpans],
	)

	const handleCollapseAll = React.useCallback(() => dispatch({ type: "COLLAPSE_ALL" }), [dispatch])

	// --- Search match navigation (Enter/⇧Enter cycles; focused-row ring marks the current match) ---
	const matchRowIndices = React.useMemo(() => {
		const rows: number[] = []
		bars.forEach((b, i) => {
			if (searchMatches.has(b.span.spanId)) rows.push(i)
		})
		return rows
	}, [bars, searchMatches])
	const [matchCursor, setMatchCursor] = React.useState(0) // 1-based; 0 = none active
	React.useEffect(() => setMatchCursor(0), [state.searchQuery])
	const handleSearchNavigate = React.useCallback(
		(direction: 1 | -1) => {
			const n = matchRowIndices.length
			if (n === 0) return
			const next =
				matchCursor === 0
					? direction === 1
						? 1
						: n
					: ((matchCursor - 1 + direction + n) % n) + 1
			setMatchCursor(next)
			dispatch({ type: "SET_FOCUSED_INDEX", index: matchRowIndices[next - 1] })
		},
		[matchRowIndices, matchCursor, dispatch],
	)

	const [showShortcuts, setShowShortcuts] = React.useState(false)

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

	// Kill hover work while scrolling (Sentry pattern): rows ignore the pointer during a
	// scroll burst and for 150ms after it settles. Imperative — no state, no re-render.
	const rowsContainerRef = React.useRef<HTMLDivElement>(null)
	React.useEffect(() => {
		const el = scrollRef.current
		if (!el) return
		let timer = 0
		const onScroll = () => {
			const rows = rowsContainerRef.current
			if (!rows) return
			rows.style.pointerEvents = "none"
			window.clearTimeout(timer)
			timer = window.setTimeout(() => {
				rows.style.pointerEvents = ""
			}, 150)
		}
		el.addEventListener("scroll", onScroll, { passive: true })
		return () => {
			window.clearTimeout(timer)
			el.removeEventListener("scroll", onScroll)
		}
	}, [])

	const handleKeyDown = React.useCallback(
		(e: React.KeyboardEvent) => {
			// Keys typed into the search input (or any editable element) must not drive the
			// timeline — except Escape, which clears search/focus from anywhere.
			const target = e.target as HTMLElement
			const inEditable =
				target !== e.currentTarget &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			if (inEditable && e.key !== "Escape") return

			// Cursor-anchored zoom + pan (Perfetto/DevTools WASD cluster). Falls back to the
			// viewport center when the cursor isn't over the timeline.
			const zoomAtCursor = (factor: number) => {
				const vp = viewportRef.current
				const currentDuration = vp.endMs - vp.startMs
				const centerMs = interactions.getCursorTimeMs() ?? (vp.startMs + vp.endMs) / 2
				const newDuration = currentDuration / factor
				const ratio = (centerMs - vp.startMs) / currentDuration
				const newStart = centerMs - ratio * newDuration
				animateViewportTo({ startMs: newStart, endMs: newStart + newDuration }, 120)
			}
			const panBy = (frac: number) => {
				const vp = viewportRef.current
				const delta = (vp.endMs - vp.startMs) * frac
				animateViewportTo({ startMs: vp.startMs + delta, endMs: vp.endMs + delta }, 120)
			}

			// The timeline owns these keys while focused — consume them so app-global
			// hotkeys (D = time picker, F = advanced filter, ? = help, J/K lists) don't
			// also fire. stopPropagation keeps the event off the document listeners.
			const consume = () => {
				e.preventDefault()
				e.stopPropagation()
			}

			switch (e.key.toLowerCase()) {
				case "arrowdown":
					consume()
					dispatch({ type: "FOCUS_NEXT", maxIndex: bars.length - 1 })
					return
				case "arrowup":
					consume()
					dispatch({ type: "FOCUS_PREV" })
					return
				case "arrowright":
					e.stopPropagation()
					if (state.focusedIndex !== null) {
						const bar = bars[state.focusedIndex]
						if (bar?.hasChildren && bar.isCollapsed) {
							dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
						}
					}
					return
				case "arrowleft":
					e.stopPropagation()
					if (state.focusedIndex !== null) {
						const bar = bars[state.focusedIndex]
						if (bar?.hasChildren && !bar.isCollapsed) {
							dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
						}
					}
					return
				case "enter":
				case " ":
					if (state.focusedIndex !== null) {
						consume()
						const bar = bars[state.focusedIndex]
						if (bar && onSelectSpan) onSelectSpan(bar.span)
					}
					return
				case "w":
				case "+":
				case "=":
					consume()
					zoomAtCursor(e.shiftKey ? 2 : 1.4)
					return
				case "s":
				case "-":
				case "_":
					consume()
					zoomAtCursor(e.shiftKey ? 0.5 : 1 / 1.4)
					return
				case "a":
					consume()
					panBy(e.shiftKey ? -0.4 : -0.15)
					return
				case "d":
					consume()
					panBy(e.shiftKey ? 0.4 : 0.15)
					return
				case "f": {
					// Fit the focused/selected span; with neither, fit the whole trace.
					consume()
					const bar =
						state.focusedIndex !== null
							? bars[state.focusedIndex]
							: selectedSpanId !== undefined
								? bars[barIndexBySpanId.get(selectedSpanId) ?? -1]
								: undefined
					if (bar) {
						const padding = Math.max((bar.endMs - bar.startMs) * 0.1, 0.001)
						animateViewportTo({ startMs: bar.startMs - padding, endMs: bar.endMs + padding }, 220)
					} else {
						handleZoomToFit()
					}
					return
				}
				case "/":
					consume()
					searchInputRef.current?.focus()
					return
				case "?":
					consume()
					setShowShortcuts((v) => !v)
					return
				case "escape":
					if (showShortcuts) {
						consume()
						setShowShortcuts(false)
					} else if (state.searchQuery) {
						e.stopPropagation()
						dispatch({ type: "SET_SEARCH", query: "" })
					} else if (state.focusedIndex !== null) {
						e.stopPropagation()
						dispatch({ type: "SET_FOCUSED_INDEX", index: null })
					}
					return
			}
		},
		[
			state.focusedIndex,
			state.searchQuery,
			bars,
			barIndexBySpanId,
			selectedSpanId,
			dispatch,
			onSelectSpan,
			interactions,
			animateViewportTo,
			handleZoomToFit,
			showShortcuts,
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
				currentMatch={matchCursor}
				onNavigate={handleSearchNavigate}
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
					className={`flex-1 overflow-auto select-none ${
						interactions.dragMode === "pan"
							? "cursor-grabbing"
							: interactions.dragMode === "zoom"
								? "cursor-crosshair"
								: ""
					}`}
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
					<div
						ref={rowsContainerRef}
						className="relative w-full"
						style={{ height: rowVirtualizer.getTotalSize() }}
					>
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

				{/* Crosshair + drag-zoom marquee (px relative to the scroll container's left edge).
				    The crosshair stays mounted; the interactions hook drives it (and its time
				    readout child) imperatively. */}
				<div
					ref={interactions.crosshairRef}
					className="pointer-events-none absolute top-0 bottom-0 left-0 z-20 w-px bg-foreground/40"
					style={{ display: "none" }}
				>
					<span className="absolute top-1 whitespace-nowrap bg-background/90 px-1 font-mono text-[9px] leading-3 text-muted-foreground" />
				</div>
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
							W A S D
						</kbd>{" "}
						navigate
					</span>
					<span>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							/
						</kbd>{" "}
						search
					</span>
					<button
						type="button"
						onClick={() => setShowShortcuts((v) => !v)}
						className="hover:text-foreground/70"
					>
						<kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">
							?
						</kbd>{" "}
						all shortcuts
					</button>
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

			{showShortcuts && (
				<div
					className="absolute inset-0 z-30 flex items-center justify-center bg-background/60"
					onClick={() => setShowShortcuts(false)}
				>
					<div
						className="w-[420px] max-w-[90%] border border-border bg-popover p-4 shadow-lg"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="mb-3 flex items-center justify-between">
							<span className="text-xs font-medium">Timeline shortcuts</span>
							<button
								type="button"
								onClick={() => setShowShortcuts(false)}
								className="text-muted-foreground hover:text-foreground text-xs"
							>
								Esc
							</button>
						</div>
						<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
							{(
								[
									["W / S", "Zoom in / out at cursor (⇧ faster)"],
									["A / D", "Pan left / right (⇧ faster)"],
									["F", "Fit focused span — or whole trace"],
									["Drag", "Zoom to selection"],
									["⇧ Drag / middle-drag", "Pan"],
									["⌘ Scroll", "Zoom at cursor"],
									["Double-click", "Zoom to span"],
									["↑ ↓", "Move row focus"],
									["← →", "Collapse / expand span"],
									["Enter / Space", "Select focused span"],
									["/", "Search · Enter next · ⇧Enter previous"],
									["Esc", "Clear search / focus · close this"],
								] as const
							).map(([keys, desc]) => (
								<React.Fragment key={keys}>
									<kbd className="justify-self-start border border-foreground/10 bg-muted px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap">
										{keys}
									</kbd>
									<span className="text-muted-foreground self-center">{desc}</span>
								</React.Fragment>
							))}
						</div>
					</div>
				</div>
			)}

			{hoveredSpan &&
				!isDragging &&
				ReactDOM.createPortal(
					<div
						ref={tooltipNodeRef}
						className="fixed left-0 top-0 z-[9999] pointer-events-none"
						style={{ visibility: tooltipPosRef.current ? undefined : "hidden" }}
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
