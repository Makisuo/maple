import * as React from "react"

import { XmarkIcon } from "../icons"

import { Button } from "../ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip"
import { FlamegraphTooltipContent } from "./flamegraph-tooltip"
import { FlamegraphMinimap } from "./flamegraph-minimap"
import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { getSpanColorStyle, getServiceLegendColor } from "../../lib/colors"
import type { SpanNode } from "../../lib/types"

interface FlamegraphProps {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

interface FlamegraphBar {
  span: SpanNode
  depth: number
  lane: number
  leftPercent: number
  widthPercent: number
}

function calculateBars(
  rootSpans: SpanNode[],
  totalDurationMs: number,
  traceStartTime: string,
  focusedSpan?: SpanNode
): FlamegraphBar[] {
  const barsByDepth = new Map<number, FlamegraphBar[]>()

  const refStartMs = focusedSpan
    ? new Date(focusedSpan.startTime).getTime()
    : new Date(traceStartTime).getTime()
  const refDurationMs = focusedSpan ? focusedSpan.durationMs : totalDurationMs

  function traverse(node: SpanNode, baseDepth: number = 0) {
    const spanStartMs = new Date(node.startTime).getTime()
    const leftPercent = ((spanStartMs - refStartMs) / refDurationMs) * 100
    const widthPercent = (node.durationMs / refDurationMs) * 100

    if (leftPercent + widthPercent < 0 || leftPercent > 100) return

    const depth = focusedSpan ? node.depth - focusedSpan.depth : node.depth

    const bars = barsByDepth.get(depth) || []
    bars.push({
      span: node,
      depth,
      lane: depth,
      leftPercent: Math.max(0, leftPercent),
      widthPercent: Math.min(widthPercent, 100 - Math.max(0, leftPercent)),
    })
    barsByDepth.set(depth, bars)

    node.children.forEach((child) => traverse(child, baseDepth))
  }

  if (focusedSpan) {
    traverse(focusedSpan)
  } else {
    rootSpans.forEach((root) => traverse(root))
  }

  return Array.from(barsByDepth.entries())
    .sort(([a], [b]) => a - b)
    .flatMap(([, bars]) => bars)
}

function assignLanes(bars: FlamegraphBar[]): { bars: FlamegraphBar[]; totalLanes: number } {
  if (bars.length === 0) return { bars, totalLanes: 0 }

  const byDepth = new Map<number, FlamegraphBar[]>()
  for (const bar of bars) {
    const group = byDepth.get(bar.depth) ?? []
    group.push(bar)
    byDepth.set(bar.depth, group)
  }

  let laneOffset = 0
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b)

  for (const depth of depths) {
    const group = byDepth.get(depth)!
    group.sort((a, b) => a.leftPercent - b.leftPercent)
    const lanes: number[] = []

    for (const bar of group) {
      let placed = false
      for (let i = 0; i < lanes.length; i++) {
        if (bar.leftPercent >= lanes[i]) {
          lanes[i] = bar.leftPercent + bar.widthPercent
          bar.lane = laneOffset + i
          placed = true
          break
        }
      }
      if (!placed) {
        bar.lane = laneOffset + lanes.length
        lanes.push(bar.leftPercent + bar.widthPercent)
      }
    }

    laneOffset += lanes.length
  }

  return { bars, totalLanes: laneOffset }
}

export function Flamegraph({
  rootSpans,
  totalDurationMs,
  traceStartTime,
  services,
  selectedSpanId,
  onSelectSpan,
}: FlamegraphProps) {
  const [focusedSpan, setFocusedSpan] = React.useState<SpanNode | null>(null)
  const [hoveredSpan, setHoveredSpan] = React.useState<SpanNode | null>(null)

  const { bars: allBars, totalLanes } = React.useMemo(
    () => assignLanes(calculateBars(rootSpans, totalDurationMs, traceStartTime, focusedSpan ?? undefined)),
    [rootSpans, totalDurationMs, traceStartTime, focusedSpan]
  )

  const handleBarClick = (span: SpanNode, e: React.MouseEvent) => {
    if (e.shiftKey) {
      if (focusedSpan?.spanId === span.spanId) {
        setFocusedSpan(null)
      } else {
        setFocusedSpan(span)
      }
    } else {
      onSelectSpan?.(span)
    }
  }

  const handleReset = () => setFocusedSpan(null)

  if (rootSpans.length === 0) {
    return (
      <div className="border p-8 text-center">
        <p className="text-muted-foreground">No spans found for this trace</p>
      </div>
    )
  }

  const ROW_HEIGHT = 32
  const ROW_GAP = 2
  const headerHeight = 40

  return (
    <div className="border">
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span>Flamegraph</span>
          {focusedSpan && (
            <>
              <span className="text-foreground/40">/</span>
              <span className="font-mono text-foreground">{focusedSpan.spanName}</span>
              <span className="text-foreground/40">({formatDuration(focusedSpan.durationMs)})</span>
            </>
          )}
        </div>
        {focusedSpan && (
          <Button variant="ghost" size="sm" onClick={handleReset} className="h-6 gap-1 text-xs">
            <XmarkIcon size={12} />
            Reset
          </Button>
        )}
      </div>

      {focusedSpan && (
        <FlamegraphMinimap
          rootSpans={rootSpans}
          totalDurationMs={totalDurationMs}
          traceStartTime={traceStartTime}
          services={services}
          focusedSpan={focusedSpan}
          onNavigate={(span) => setFocusedSpan(span)}
        />
      )}

      <div
        className="relative overflow-x-auto"
        style={{ height: totalLanes * (ROW_HEIGHT + ROW_GAP) + headerHeight + 8 }}
      >
        <div className="sticky top-0 z-10 flex h-10 items-end border-b bg-background/95 px-3 pb-2">
          {[0, 25, 50, 75, 100].map((pct) => (
            <div
              key={pct}
              className="absolute text-[11px] font-medium text-muted-foreground"
              style={{ left: `calc(${pct}% + 12px)`, transform: "translateX(-50%)" }}
            >
              {formatDuration(
                ((focusedSpan?.durationMs ?? totalDurationMs) * pct) / 100
              )}
            </div>
          ))}
        </div>

        <div className="relative px-3 pt-2" style={{ height: totalLanes * (ROW_HEIGHT + ROW_GAP) + 8 }}>
          {[0, 25, 50, 75, 100].map((pct) => (
            <div
              key={`grid-${pct}`}
              className="absolute top-0 bottom-0 border-l border-dashed border-foreground/[0.06] pointer-events-none"
              style={{ left: `${pct}%` }}
            />
          ))}

          {allBars.map((bar) => {
            const colorStyle = bar.span.statusCode === "Error"
              ? {}
              : getSpanColorStyle(bar.span.spanName, bar.span.serviceName, services)

            return (
              <Tooltip key={bar.span.spanId}>
                <TooltipTrigger
                  className={cn(
                    "absolute flex items-center overflow-hidden px-2 text-left font-mono text-[11px] font-medium cursor-pointer transition-[filter,box-shadow] duration-100",
                    "hover:brightness-125 hover:z-10",
                    bar.span.statusCode === "Error" && "bg-destructive text-destructive-foreground",
                    hoveredSpan?.spanId === bar.span.spanId && "brightness-125 z-10",
                    focusedSpan?.spanId === bar.span.spanId && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                    selectedSpanId === bar.span.spanId && "ring-2 ring-primary ring-offset-1 ring-offset-background z-20"
                  )}
                  style={{
                    top: bar.lane * (ROW_HEIGHT + ROW_GAP),
                    left: `${bar.leftPercent}%`,
                    width: `${Math.max(bar.widthPercent, 0.5)}%`,
                    height: ROW_HEIGHT,
                    opacity: Math.max(1 - bar.depth * 0.06, 0.5),
                    ...colorStyle,
                  }}
                  onClick={(e) => handleBarClick(bar.span, e)}
                  onMouseEnter={() => setHoveredSpan(bar.span)}
                  onMouseLeave={() => setHoveredSpan(null)}
                >
                  {bar.widthPercent > 3 && (
                    <>
                      <span className="truncate">{bar.span.spanName}</span>
                      {bar.widthPercent > 12 && (
                        <span className="ml-1 truncate text-[10px] opacity-60">
                          {bar.span.serviceName}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 pl-2 text-[10px] opacity-70">
                        {formatDuration(bar.span.durationMs)}
                      </span>
                    </>
                  )}
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-sm">
                  <FlamegraphTooltipContent
                    span={bar.span}
                    services={services}
                    totalDurationMs={totalDurationMs}
                    traceStartTime={traceStartTime}
                  />
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3 text-foreground/30">
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[10px]">Click</kbd> select
          </span>
          <span>
            <kbd className="border border-foreground/10 bg-muted px-1 py-0.5 font-mono text-[10px]">Shift+Click</kbd> zoom
          </span>
        </div>
        <div className="flex items-center gap-3">
          {services.map((service) => (
            <div key={service} className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5" style={{ backgroundColor: getServiceLegendColor(service, services) }} />
              <span className="font-medium">{service}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 bg-destructive" />
            <span className="font-medium">Error</span>
          </div>
        </div>
      </div>
    </div>
  )
}
