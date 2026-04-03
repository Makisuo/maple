import * as React from "react"

import { SpanRow } from "./span-row"
import { useTraceView } from "./trace-view-context"
import type { SpanNode } from "@/api/tinybird/traces"

interface SpanHierarchyProps {
  defaultExpandDepth?: number
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
  defaultExpandDepth = Infinity,
}: SpanHierarchyProps) {
  const { rootSpans, totalDurationMs, traceStartTime, services, selectedSpanId, onSelectSpan } = useTraceView()

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
            services={services}
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
          <div className="w-6 shrink-0" />
          <span className="flex-1">Span</span>
        </div>
        {/* Right section header (fixed widths matching rows) */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="w-48 text-center">Duration</span>
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
