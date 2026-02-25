import * as React from "react"
import * as ReactDOM from "react-dom"

import { ChevronExpandYIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { getServiceLegendColor } from "@maple/ui/colors"
import type { SpanNode } from "@/api/tinybird/traces"
import { useTraceTimeline, clampViewport } from "./use-trace-timeline"
import { TraceTimelineSearch } from "./trace-timeline-search"
import { TraceTimelineMinimap } from "./trace-timeline-minimap"
import { TraceTimelineTimeAxis } from "./trace-timeline-time-axis"
import { TraceTimelineRows } from "./trace-timeline-rows"
import { TraceTimelineConnectors } from "./trace-timeline-connectors"
import { TraceTimelineTooltipContent } from "./trace-timeline-tooltip"
import { ROW_HEIGHT, ROW_GAP } from "./trace-timeline-types"

interface TraceTimelineProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

export function TraceTimeline({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  services,
  selectedSpanId,
  onSelectSpan,
}: TraceTimelineProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const tooltipRef = React.useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [containerSize, setContainerSize] = React.useState({ width: 0, height: 0 })
  const [hoveredSpan, setHoveredSpan] = React.useState<SpanNode | null>(null)
  const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null)
  const isPanning = React.useRef(false)
  const panStart = React.useRef<{ x: number; viewportStartMs: number; viewportEndMs: number } | null>(null)

  const {
    bars,
    totalRows,
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
    defaultExpandDepth: Infinity,
  })

  // Observe container size
  React.useEffect(() => {
    if (!scrollRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    observer.observe(scrollRef.current)
    return () => observer.disconnect()
  }, [])

  // Handle scroll
  const handleScroll = React.useCallback(() => {
    if (scrollRef.current) {
      setScrollTop(scrollRef.current.scrollTop)
    }
  }, [])

  // Scroll-wheel zoom — use native listener to avoid passive event issue
  const wheelHandlerRef = React.useRef<(e: WheelEvent) => void>(undefined)
  wheelHandlerRef.current = (e: WheelEvent) => {
    // Horizontal scroll = pan
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && containerSize.width > 0) {
      const visibleDuration = state.viewport.endMs - state.viewport.startMs
      const deltaMs = (e.deltaX / containerSize.width) * visibleDuration
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
      const visibleDuration = state.viewport.endMs - state.viewport.startMs
      const centerMs = state.viewport.startMs + mousePercent * visibleDuration

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
  }, [])

  // Panning via mouse drag
  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      // Only start pan if clicking on empty area (not on a bar)
      const target = e.target as HTMLElement
      if (target.closest("[data-span-id]")) return

      isPanning.current = true
      panStart.current = {
        x: e.clientX,
        viewportStartMs: state.viewport.startMs,
        viewportEndMs: state.viewport.endMs,
      }
      e.preventDefault()
    },
    [state.viewport]
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
          traceEndMs
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
  }, [dispatch])

  // Hover tooltip (ref-based for performance)
  const handleMouseMoveForTooltip = React.useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const barEl = target.closest("[data-span-id]") as HTMLElement | null
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        const span = bars.find((b) => b.span.spanId === spanId)?.span ?? null
        setHoveredSpan(span)
        if (span) {
          setTooltipPos({
            x: e.clientX,
            y: e.clientY,
          })
        }
      } else {
        setHoveredSpan(null)
        setTooltipPos(null)
      }
    },
    [bars]
  )

  const handleMouseLeaveContainer = React.useCallback(() => {
    setHoveredSpan(null)
    setTooltipPos(null)
  }, [])

  // Bar click handlers
  const handleBarClick = React.useCallback(
    (spanId: string) => {
      const bar = bars.find((b) => b.span.spanId === spanId)
      if (bar && onSelectSpan) {
        onSelectSpan(bar.span)
      }
    },
    [bars, onSelectSpan]
  )

  const handleBarDoubleClick = React.useCallback(
    (spanId: string) => {
      const bar = bars.find((b) => b.span.spanId === spanId)
      if (bar) {
        dispatch({
          type: "ZOOM_TO_SPAN",
          startMs: bar.startMs,
          endMs: bar.endMs,
          traceStartMs,
          traceEndMs,
        })
      }
    },
    [bars, dispatch, traceStartMs, traceEndMs]
  )

  const handleCollapseToggle = React.useCallback(
    (spanId: string) => {
      dispatch({ type: "TOGGLE_COLLAPSE", spanId })
    },
    [dispatch]
  )

  // Minimap viewport change
  const handleMinimapViewportChange = React.useCallback(
    (viewport: { startMs: number; endMs: number }) => {
      dispatch({
        type: "SET_VIEWPORT",
        viewport: clampViewport(viewport, traceStartMs, traceEndMs),
      })
    },
    [dispatch, traceStartMs, traceEndMs]
  )

  // Zoom to fit
  const handleZoomToFit = React.useCallback(() => {
    dispatch({ type: "ZOOM_TO_FIT", traceStartMs, traceEndMs })
  }, [dispatch, traceStartMs, traceEndMs])

  // Keyboard navigation
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
            if (bar?.span.children.length > 0 && bar.isCollapsed) {
              dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
            }
          }
          break
        case "ArrowLeft":
          if (state.focusedIndex !== null) {
            const bar = bars[state.focusedIndex]
            if (bar?.span.children.length > 0 && !bar.isCollapsed) {
              dispatch({ type: "TOGGLE_COLLAPSE", spanId: bar.span.spanId })
            }
          }
          break
        case "Enter":
        case " ":
          if (state.focusedIndex !== null) {
            e.preventDefault()
            const bar = bars[state.focusedIndex]
            if (bar && onSelectSpan) {
              onSelectSpan(bar.span)
            }
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
    [state.focusedIndex, state.searchQuery, state.viewport, bars, dispatch, onSelectSpan, traceStartMs, traceEndMs]
  )

  // Grid lines from time axis ticks
  const visibleDuration = state.viewport.endMs - state.viewport.startMs
  const rowSize = ROW_HEIGHT + ROW_GAP

  if (rootSpans.length === 0) {
    return (
      <div className="border p-8 text-center">
        <p className="text-muted-foreground">No spans found for this trace</p>
      </div>
    )
  }

  // Check if zoomed (viewport is narrower than full trace)
  const fullDuration = traceEndMs - traceStartMs
  const isZoomed = visibleDuration < fullDuration * 0.95

  return (
    <div
      ref={containerRef}
      className="border flex flex-col h-full outline-none relative"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseMove={handleMouseMoveForTooltip}
      onMouseLeave={handleMouseLeaveContainer}
    >
      {/* Search bar */}
      <TraceTimelineSearch
        query={state.searchQuery}
        onQueryChange={(q) => dispatch({ type: "SET_SEARCH", query: q })}
        matchCount={searchMatches.size}
        totalCount={bars.length}
        inputRef={searchInputRef}
      />

      {/* Header with controls */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium">Timeline</span>
          <span className="tabular-nums">{bars.length} spans</span>
        </div>
        <div className="flex items-center gap-1">
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

      {/* Minimap */}
      <TraceTimelineMinimap
        rootSpans={rootSpans}
        totalDurationMs={totalDurationMs}
        traceStartMs={traceStartMs}
        traceEndMs={traceEndMs}
        services={services}
        viewport={state.viewport}
        onViewportChange={handleMinimapViewportChange}
      />

      {/* Time axis */}
      <TraceTimelineTimeAxis
        viewport={state.viewport}
        ticks={timeAxisTicks}
        traceStartMs={traceStartMs}
      />

      {/* Scrollable rows area */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto relative"
        style={{ cursor: isPanning.current ? "grabbing" : undefined }}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
      >
        {/* Grid lines */}
        <div
          className="absolute inset-0 pointer-events-none z-0"
          style={{ height: totalRows * rowSize }}
        >
          {timeAxisTicks.map((offsetMs) => {
            const absMs = traceStartMs + offsetMs
            const leftPercent = ((absMs - state.viewport.startMs) / visibleDuration) * 100
            if (leftPercent < -1 || leftPercent > 101) return null
            return (
              <div
                key={`grid-${offsetMs}`}
                className="absolute top-0 bottom-0 border-l border-dashed border-foreground/[0.04]"
                style={{ left: `${leftPercent}%` }}
              />
            )
          })}
        </div>

        {/* Connectors */}
        <TraceTimelineConnectors
          bars={bars}
          totalRows={totalRows}
          scrollTop={scrollTop}
          containerHeight={containerSize.height}
        />

        {/* Span bars */}
        <TraceTimelineRows
          bars={bars}
          totalRows={totalRows}
          viewport={state.viewport}
          services={services}
          selectedSpanId={selectedSpanId}
          focusedIndex={state.focusedIndex}
          searchMatches={searchMatches}
          isSearchActive={isSearchActive}
          scrollTop={scrollTop}
          containerHeight={containerSize.height}
          containerWidth={containerSize.width}
          onBarClick={handleBarClick}
          onBarDoubleClick={handleBarDoubleClick}
          onCollapseToggle={handleCollapseToggle}
        />
      </div>

      {/* Legend */}
      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground shrink-0">
        <div className="flex items-center gap-3 text-foreground/30">
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Click</kbd> select
          </span>
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Dbl-click</kbd> zoom
          </span>
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">Ctrl+Scroll</kbd> zoom
          </span>
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[9px]">/</kbd> search
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          {services.map((service) => (
            <div key={service} className="flex items-center gap-1">
              <div
                className="h-2 w-2 shrink-0"
                style={{ backgroundColor: getServiceLegendColor(service, services) }}
              />
              <span className="font-medium">{service}</span>
            </div>
          ))}
          <div className="flex items-center gap-1">
            <div className="h-2 w-2 bg-destructive shrink-0" />
            <span className="font-medium">Error</span>
          </div>
        </div>
      </div>

      {/* Floating tooltip — uses fixed positioning to escape overflow clipping */}
      {hoveredSpan && tooltipPos && ReactDOM.createPortal(
        <div
          ref={tooltipRef}
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
        document.body
      )}
    </div>
  )
}
