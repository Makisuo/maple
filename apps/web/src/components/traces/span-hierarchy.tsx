import * as React from "react"

import { SpanRow } from "./span-row"
import type { SpanNode } from "@/api/tinybird/traces"

interface SpanHierarchyProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  defaultExpandDepth?: number
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

function collectSpanIds(nodes: SpanNode[], depth: number, maxDepth: number): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (depth < maxDepth) {
      ids.add(node.spanId)
      const childIds = collectSpanIds(node.children, depth + 1, maxDepth)
      childIds.forEach(id => ids.add(id))
    }
  }
  return ids
}

export function SpanHierarchy({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  defaultExpandDepth = Infinity,
  selectedSpanId,
  onSelectSpan,
}: SpanHierarchyProps) {
  const [expandedSpans, setExpandedSpans] = React.useState<Set<string>>(() => {
    return collectSpanIds(rootSpans, 0, defaultExpandDepth)
  })

  const toggleSpan = (spanId: string) => {
    setExpandedSpans((prev) => {
      const next = new Set(prev)
      if (next.has(spanId)) {
        next.delete(spanId)
      } else {
        next.add(spanId)
      }
      return next
    })
  }

  const renderSpanTree = (nodes: SpanNode[]): React.ReactNode => {
    return nodes.map((node) => {
      const isExpanded = expandedSpans.has(node.spanId)
      return (
        <React.Fragment key={node.spanId}>
          <SpanRow
            span={node}
            totalDurationMs={totalDurationMs}
            traceStartTime={traceStartTime}
            expanded={isExpanded}
            onToggle={() => toggleSpan(node.spanId)}
            isSelected={selectedSpanId === node.spanId}
            onSelect={onSelectSpan}
          />
          {isExpanded && node.children.length > 0 && renderSpanTree(node.children)}
        </React.Fragment>
      )
    })
  }

  if (rootSpans.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center">
        <p className="text-muted-foreground">No spans found for this trace</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center border-b bg-muted/30 px-2 py-1.5 text-xs font-medium text-muted-foreground">
        {/* Left section header */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-5 shrink-0" />
          <span className="shrink-0">Service</span>
          <span className="shrink-0 w-14">Kind</span>
          <span className="flex-1">Span Name</span>
        </div>
        {/* Right section header (fixed widths matching rows) */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="w-32 text-center">Duration</span>
          <span className="w-16 text-right">Time</span>
          <span className="w-14 text-center">Status</span>
        </div>
      </div>
      <div className="divide-y-0">
        {renderSpanTree(rootSpans)}
      </div>
    </div>
  )
}
