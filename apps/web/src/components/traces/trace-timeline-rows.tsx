import * as React from "react"

import { TraceTimelineBar } from "./trace-timeline-bar"
import type { TimelineBar, ViewportState } from "./trace-timeline-types"
import { ROW_HEIGHT, ROW_GAP, OVERSCAN } from "./trace-timeline-types"

interface TraceTimelineRowsProps {
  bars: TimelineBar[]
  totalRows: number
  viewport: ViewportState
  services: string[]
  selectedSpanId?: string
  focusedIndex: number | null
  searchMatches: Set<string>
  isSearchActive: boolean
  scrollTop: number
  containerHeight: number
  containerWidth: number
  onBarClick: (spanId: string) => void
  onBarDoubleClick: (spanId: string) => void
  onCollapseToggle: (spanId: string) => void
}

export function TraceTimelineRows({
  bars,
  totalRows,
  viewport,
  services,
  selectedSpanId,
  focusedIndex,
  searchMatches,
  isSearchActive,
  scrollTop,
  containerHeight,
  containerWidth,
  onBarClick,
  onBarDoubleClick,
  onCollapseToggle,
}: TraceTimelineRowsProps) {
  const rowSize = ROW_HEIGHT + ROW_GAP
  const totalHeight = totalRows * rowSize
  const visibleDuration = viewport.endMs - viewport.startMs

  // Virtualization: only render visible rows
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - OVERSCAN)
  const lastVisible = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + containerHeight) / rowSize) + OVERSCAN
  )

  const visibleBars = React.useMemo(
    () => bars.filter((bar) => bar.row >= firstVisible && bar.row <= lastVisible),
    [bars, firstVisible, lastVisible]
  )

  // Event delegation handler
  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement

      // Check for collapse toggle
      const collapseBtn = target.closest("[data-collapse-toggle]") as HTMLElement | null
      if (collapseBtn) {
        const spanId = collapseBtn.getAttribute("data-collapse-toggle")
        if (spanId) {
          e.stopPropagation()
          onCollapseToggle(spanId)
          return
        }
      }

      // Check for bar click
      const barEl = target.closest("[data-span-id]") as HTMLElement | null
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        if (spanId) {
          onBarClick(spanId)
        }
      }
    },
    [onBarClick, onCollapseToggle]
  )

  const handleDoubleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const barEl = target.closest("[data-span-id]") as HTMLElement | null
      if (barEl) {
        const spanId = barEl.getAttribute("data-span-id")
        if (spanId) {
          onBarDoubleClick(spanId)
        }
      }
    },
    [onBarDoubleClick]
  )

  // Grid lines at tick positions (matching time axis)
  return (
    <div
      className="relative"
      style={{ height: totalHeight }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {visibleBars.map((bar) => {
        const leftPercent = ((bar.startMs - viewport.startMs) / visibleDuration) * 100
        const widthPercent = ((bar.endMs - bar.startMs) / visibleDuration) * 100

        return (
          <TraceTimelineBar
            key={bar.span.spanId}
            bar={bar}
            leftPercent={leftPercent}
            widthPercent={widthPercent}
            services={services}
            isSelected={selectedSpanId === bar.span.spanId}
            isFocused={focusedIndex !== null && bar.row === focusedIndex}
            isSearchMatch={searchMatches.has(bar.span.spanId)}
            isSearchActive={isSearchActive}
            containerWidth={containerWidth}
          />
        )
      })}
    </div>
  )
}
