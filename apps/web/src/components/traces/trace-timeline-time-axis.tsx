import { formatDuration } from "@/lib/format"
import type { ViewportState } from "./trace-timeline-types"
import { TIME_AXIS_HEIGHT } from "./trace-timeline-types"

interface TraceTimelineTimeAxisProps {
  viewport: ViewportState
  ticks: number[]
  traceStartMs: number
}

export function TraceTimelineTimeAxis({
  viewport,
  ticks,
  traceStartMs,
}: TraceTimelineTimeAxisProps) {
  const visibleDuration = viewport.endMs - viewport.startMs

  return (
    <div
      className="sticky top-0 z-20 flex items-end border-b border-border bg-background/95 backdrop-blur-sm px-0"
      style={{ height: TIME_AXIS_HEIGHT }}
    >
      {ticks.map((offsetMs) => {
        const absMs = traceStartMs + offsetMs
        const leftPercent = ((absMs - viewport.startMs) / visibleDuration) * 100

        if (leftPercent < -5 || leftPercent > 105) return null

        return (
          <div
            key={offsetMs}
            className="absolute flex flex-col items-center pointer-events-none"
            style={{ left: `${leftPercent}%`, bottom: 4 }}
          >
            <span className="text-[10px] font-mono font-medium text-muted-foreground whitespace-nowrap -translate-x-1/2">
              {formatDuration(offsetMs)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
