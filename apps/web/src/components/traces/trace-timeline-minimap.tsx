import * as React from "react"
import type { SpanNode } from "@/api/tinybird/traces"
import type { ViewportState } from "./trace-timeline-types"
import { MINIMAP_HEIGHT } from "./trace-timeline-types"

interface TraceTimelineMinimapProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartMs: number
  traceEndMs: number
  services: string[]
  viewport: ViewportState
  onViewportChange: (viewport: ViewportState) => void
}

interface MinimapSpan {
  spanId: string
  depth: number
  leftPercent: number
  widthPercent: number
  bgColor: string
}

const SERVICE_HUES = [210, 160, 280, 340, 30, 100, 50, 190]

function collectMinimapSpans(
  rootSpans: SpanNode[],
  traceStartMs: number,
  totalDurationMs: number,
  services: string[]
): { spans: MinimapSpan[]; maxDepth: number } {
  const spans: MinimapSpan[] = []
  let maxDepth = 0

  function visit(node: SpanNode) {
    const startMs = new Date(node.startTime).getTime()
    const leftPercent = ((startMs - traceStartMs) / totalDurationMs) * 100
    const widthPercent = (node.durationMs / totalDurationMs) * 100
    maxDepth = Math.max(maxDepth, node.depth)

    const serviceIndex = services.indexOf(node.serviceName)
    const hue = SERVICE_HUES[serviceIndex % SERVICE_HUES.length]

    spans.push({
      spanId: node.spanId,
      depth: node.depth,
      leftPercent: Math.max(0, leftPercent),
      widthPercent: Math.min(widthPercent, 100 - Math.max(0, leftPercent)),
      bgColor: node.statusCode === "Error"
        ? "oklch(0.45 0.15 25)"
        : `oklch(0.45 0.12 ${hue})`,
    })

    node.children.forEach(visit)
  }

  rootSpans.forEach(visit)
  return { spans, maxDepth }
}

export function TraceTimelineMinimap({
  rootSpans,
  totalDurationMs,
  traceStartMs,
  traceEndMs,
  services,
  viewport,
  onViewportChange,
}: TraceTimelineMinimapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dragRef = React.useRef<{
    type: "pan" | "resize-left" | "resize-right"
    startX: number
    startViewport: ViewportState
  } | null>(null)

  const { spans } = React.useMemo(
    () => collectMinimapSpans(rootSpans, traceStartMs, totalDurationMs, services),
    [rootSpans, traceStartMs, totalDurationMs, services]
  )

  const ROW_H = 3

  // Viewport rectangle position
  const traceDuration = traceEndMs - traceStartMs
  const vpLeftPercent = ((viewport.startMs - traceStartMs) / traceDuration) * 100
  const vpWidthPercent = ((viewport.endMs - viewport.startMs) / traceDuration) * 100

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const clickPercent = ((e.clientX - rect.left) / rect.width) * 100

      // Check if clicking on viewport edges (resize) or inside viewport (pan)
      const edgeThreshold = 2 // percent
      if (
        clickPercent >= vpLeftPercent - edgeThreshold &&
        clickPercent <= vpLeftPercent + edgeThreshold
      ) {
        dragRef.current = {
          type: "resize-left",
          startX: e.clientX,
          startViewport: { ...viewport },
        }
      } else if (
        clickPercent >= vpLeftPercent + vpWidthPercent - edgeThreshold &&
        clickPercent <= vpLeftPercent + vpWidthPercent + edgeThreshold
      ) {
        dragRef.current = {
          type: "resize-right",
          startX: e.clientX,
          startViewport: { ...viewport },
        }
      } else if (
        clickPercent >= vpLeftPercent &&
        clickPercent <= vpLeftPercent + vpWidthPercent
      ) {
        dragRef.current = {
          type: "pan",
          startX: e.clientX,
          startViewport: { ...viewport },
        }
      } else {
        // Click outside viewport: jump viewport center to click position
        const clickMs = traceStartMs + (clickPercent / 100) * traceDuration
        const vpDuration = viewport.endMs - viewport.startMs
        onViewportChange({
          startMs: clickMs - vpDuration / 2,
          endMs: clickMs + vpDuration / 2,
        })
      }

      e.preventDefault()
    },
    [viewport, vpLeftPercent, vpWidthPercent, traceStartMs, traceDuration, onViewportChange]
  )

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const deltaPercent = ((e.clientX - dragRef.current.startX) / rect.width) * 100
      const deltaMs = (deltaPercent / 100) * traceDuration
      const sv = dragRef.current.startViewport

      switch (dragRef.current.type) {
        case "pan":
          onViewportChange({
            startMs: sv.startMs + deltaMs,
            endMs: sv.endMs + deltaMs,
          })
          break
        case "resize-left":
          onViewportChange({
            startMs: Math.min(sv.startMs + deltaMs, sv.endMs - traceDuration * 0.01),
            endMs: sv.endMs,
          })
          break
        case "resize-right":
          onViewportChange({
            startMs: sv.startMs,
            endMs: Math.max(sv.endMs + deltaMs, sv.startMs + traceDuration * 0.01),
          })
          break
      }
    }

    const handleMouseUp = () => {
      dragRef.current = null
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [traceDuration, onViewportChange])

  return (
    <div
      ref={containerRef}
      className="relative border-b border-border bg-muted/10 cursor-crosshair select-none"
      style={{ height: MINIMAP_HEIGHT }}
      onMouseDown={handleMouseDown}
    >
      {/* Minimap bars */}
      <div className="absolute inset-x-0 inset-y-0 px-0" style={{ paddingTop: 2, paddingBottom: 2 }}>
        {spans.map((s) => (
          <div
            key={s.spanId}
            className="absolute"
            style={{
              top: Math.min(s.depth * (ROW_H + 1) + 2, MINIMAP_HEIGHT - ROW_H - 2),
              left: `${s.leftPercent}%`,
              width: `${Math.max(s.widthPercent, 0.2)}%`,
              height: ROW_H,
              backgroundColor: s.bgColor,
            }}
          />
        ))}
      </div>

      {/* Dimmed areas outside viewport */}
      <div
        className="absolute inset-y-0 bg-background/60"
        style={{ left: 0, width: `${Math.max(0, vpLeftPercent)}%` }}
      />
      <div
        className="absolute inset-y-0 bg-background/60"
        style={{ left: `${vpLeftPercent + vpWidthPercent}%`, right: 0 }}
      />

      {/* Viewport indicator */}
      <div
        className="absolute inset-y-0 border-x-2 border-primary/60 cursor-grab active:cursor-grabbing"
        style={{
          left: `${vpLeftPercent}%`,
          width: `${Math.max(vpWidthPercent, 1)}%`,
        }}
      />
    </div>
  )
}
