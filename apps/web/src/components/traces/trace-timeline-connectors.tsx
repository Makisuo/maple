import * as React from "react"
import type { TimelineBar } from "./trace-timeline-types"
import { ROW_HEIGHT, ROW_GAP, DEPTH_INDENT } from "./trace-timeline-types"

interface TraceTimelineConnectorsProps {
  bars: TimelineBar[]
  totalRows: number
  scrollTop: number
  containerHeight: number
}

export function TraceTimelineConnectors({
  bars,
  totalRows,
  scrollTop,
  containerHeight,
}: TraceTimelineConnectorsProps) {
  const rowSize = ROW_HEIGHT + ROW_GAP
  const totalHeight = totalRows * rowSize

  // Build parent row lookup
  const parentRowMap = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const bar of bars) {
      map.set(bar.span.spanId, bar.row)
    }
    return map
  }, [bars])

  // Only draw connectors for visible rows (with overscan)
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - 2)
  const lastVisible = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + containerHeight) / rowSize) + 2
  )

  const lines: React.ReactNode[] = []

  for (const bar of bars) {
    if (bar.row < firstVisible || bar.row > lastVisible) continue
    if (!bar.parentSpanId) continue

    const parentRow = parentRowMap.get(bar.parentSpanId)
    if (parentRow === undefined) continue

    // Parent's connector point: bottom of parent at the child's depth indent
    const parentY = parentRow * rowSize + ROW_HEIGHT
    const childY = bar.row * rowSize + ROW_HEIGHT / 2

    // X position: left edge of the bar at its depth level
    const xIndent = bar.depth * DEPTH_INDENT

    // Vertical line from parent down to child
    // Horizontal line from indent to bar left edge
    const verticalX = xIndent - DEPTH_INDENT / 2

    lines.push(
      <React.Fragment key={`conn-${bar.span.spanId}`}>
        {/* Vertical line */}
        <line
          x1={verticalX}
          y1={parentY}
          x2={verticalX}
          y2={childY}
          className="stroke-foreground/[0.08]"
          strokeWidth={1}
        />
        {/* Horizontal line */}
        <line
          x1={verticalX}
          y1={childY}
          x2={xIndent - 2}
          y2={childY}
          className="stroke-foreground/[0.08]"
          strokeWidth={1}
        />
      </React.Fragment>
    )
  }

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-0"
      style={{ height: totalHeight, width: "100%" }}
      preserveAspectRatio="none"
    >
      {lines}
    </svg>
  )
}
