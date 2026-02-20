import * as React from "react"
import { getSpanColorStyle } from "../../lib/colors"
import type { SpanNode } from "../../lib/types"

interface FlamegraphMinimapProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  focusedSpan: SpanNode | null
  onNavigate: (span: SpanNode) => void
}

interface MinimapBar {
  span: SpanNode
  depth: number
  leftPercent: number
  widthPercent: number
}

function calculateMinimapBars(
  rootSpans: SpanNode[],
  totalDurationMs: number,
  traceStartTime: string
): { bars: MinimapBar[]; maxDepth: number } {
  const bars: MinimapBar[] = []
  let maxDepth = 0
  const traceStartMs = new Date(traceStartTime).getTime()

  function traverse(node: SpanNode) {
    const spanStartMs = new Date(node.startTime).getTime()
    const leftPercent = ((spanStartMs - traceStartMs) / totalDurationMs) * 100
    const widthPercent = (node.durationMs / totalDurationMs) * 100

    maxDepth = Math.max(maxDepth, node.depth)

    bars.push({
      span: node,
      depth: node.depth,
      leftPercent: Math.max(0, leftPercent),
      widthPercent: Math.min(widthPercent, 100 - Math.max(0, leftPercent)),
    })

    node.children.forEach(traverse)
  }

  rootSpans.forEach(traverse)
  return { bars, maxDepth }
}

export function FlamegraphMinimap({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  services,
  focusedSpan,
  onNavigate,
}: FlamegraphMinimapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = React.useState(false)

  const { bars, maxDepth } = React.useMemo(
    () => calculateMinimapBars(rootSpans, totalDurationMs, traceStartTime),
    [rootSpans, totalDurationMs, traceStartTime]
  )

  const viewportStyle = React.useMemo(() => {
    if (!focusedSpan) return null
    const traceStartMs = new Date(traceStartTime).getTime()
    const spanStartMs = new Date(focusedSpan.startTime).getTime()
    const leftPercent = ((spanStartMs - traceStartMs) / totalDurationMs) * 100
    const widthPercent = (focusedSpan.durationMs / totalDurationMs) * 100
    return { left: `${leftPercent}%`, width: `${Math.max(widthPercent, 2)}%` }
  }, [focusedSpan, traceStartTime, totalDurationMs])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickPercent = (clickX / rect.width) * 100

    const clickedBars = bars
      .filter(bar => clickPercent >= bar.leftPercent && clickPercent <= bar.leftPercent + bar.widthPercent)
      .sort((a, b) => b.depth - a.depth)

    if (clickedBars.length > 0) {
      onNavigate(clickedBars[0].span)
    }
  }

  const handleMouseDown = () => setIsDragging(true)
  const handleMouseUp = () => setIsDragging(false)
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !containerRef.current) return
    handleClick(e)
  }

  React.useEffect(() => {
    const handleGlobalMouseUp = () => setIsDragging(false)
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [])

  const ROW_HEIGHT = 4
  const MINIMAP_HEIGHT = Math.min((maxDepth + 1) * ROW_HEIGHT + 8, 60)

  return (
    <div
      ref={containerRef}
      className="relative border-b bg-muted/20 cursor-crosshair select-none"
      style={{ height: MINIMAP_HEIGHT }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
    >
      <div className="absolute inset-x-3 inset-y-1">
        {bars.map((bar) => {
          const isError = bar.span.statusCode === "Error"
          const colorStyle = isError
            ? { backgroundColor: 'var(--destructive)' }
            : getSpanColorStyle(bar.span.spanName, bar.span.serviceName, services)

          return (
            <div
              key={bar.span.spanId}
              className="absolute opacity-80"
              style={{
                top: bar.depth * ROW_HEIGHT,
                left: `${bar.leftPercent}%`,
                width: `${Math.max(bar.widthPercent, 0.3)}%`,
                height: ROW_HEIGHT - 1,
                ...colorStyle,
              }}
            />
          )
        })}
      </div>

      {viewportStyle && (
        <div
          className="absolute inset-y-0 border-2 border-primary bg-primary/20 cursor-grab active:cursor-grabbing"
          style={viewportStyle}
        />
      )}

      <div className="absolute right-3 top-1 text-[9px] font-medium text-muted-foreground/60">
        Minimap
      </div>
    </div>
  )
}
