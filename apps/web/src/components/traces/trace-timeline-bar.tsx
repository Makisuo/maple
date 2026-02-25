import * as React from "react"

import { ChevronRightIcon, ChevronDownIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"
import { getServiceBorderColor } from "@maple/ui/colors"
import { getCacheInfo } from "@/lib/cache"
import type { TimelineBar } from "./trace-timeline-types"
import { ROW_HEIGHT, ROW_GAP, DEPTH_INDENT } from "./trace-timeline-types"

interface TraceTimelineBarProps {
  bar: TimelineBar
  leftPercent: number
  widthPercent: number
  services: string[]
  isSelected: boolean
  isFocused: boolean
  isSearchMatch: boolean
  isSearchActive: boolean
  containerWidth: number
}

function getBarBackground(serviceName: string, services: string[]): string {
  const SERVICE_HUES = [210, 160, 280, 340, 30, 100, 50, 190]
  const index = services.indexOf(serviceName)
  const hue = SERVICE_HUES[index % SERVICE_HUES.length]
  return `oklch(0.22 0.015 ${hue})`
}

function getBarHoverBackground(serviceName: string, services: string[]): string {
  const SERVICE_HUES = [210, 160, 280, 340, 30, 100, 50, 190]
  const index = services.indexOf(serviceName)
  const hue = SERVICE_HUES[index % SERVICE_HUES.length]
  return `oklch(0.28 0.025 ${hue})`
}

function TraceTimelineBarInner({
  bar,
  leftPercent,
  widthPercent,
  services,
  isSelected,
  isFocused,
  isSearchMatch,
  isSearchActive,
  containerWidth,
}: TraceTimelineBarProps) {
  const borderColor = bar.isError
    ? "var(--destructive)"
    : getServiceBorderColor(bar.span.serviceName, services)

  const bgColor = bar.isError
    ? "oklch(0.20 0.04 25)"
    : getBarBackground(bar.span.serviceName, services)

  const hoverBgColor = bar.isError
    ? "oklch(0.24 0.05 25)"
    : getBarHoverBackground(bar.span.serviceName, services)

  const cacheInfo = getCacheInfo(bar.span.spanAttributes)

  // Pixel-based label visibility
  const barPx = (widthPercent / 100) * containerWidth
  const showName = barPx > 60
  const showService = barPx > 150
  const showDuration = barPx > 200

  const leftOffset = bar.depth * DEPTH_INDENT

  // CSS custom properties for hover effect
  const barStyle: React.CSSProperties = {
    position: "absolute",
    transform: `translateY(${bar.row * (ROW_HEIGHT + ROW_GAP)}px)`,
    left: `calc(${leftPercent}% + ${leftOffset}px)`,
    width: `calc(${Math.max(widthPercent, 0.3)}% - ${leftOffset}px)`,
    height: ROW_HEIGHT,
    borderLeft: `3px solid ${borderColor}`,
    backgroundColor: bgColor,
    "--hover-bg": hoverBgColor,
  } as React.CSSProperties

  return (
    <div
      data-span-id={bar.span.spanId}
      data-row={bar.row}
      className={cn(
        "trace-timeline-bar flex items-center overflow-hidden text-left font-mono text-[11px] font-medium cursor-pointer",
        "transition-[background-color,box-shadow] duration-75",
        isSelected && "ring-1 ring-primary bg-primary/10 z-20",
        isFocused && "outline-2 outline-dashed outline-primary outline-offset-[-2px] z-10",
        isSearchActive && !isSearchMatch && "opacity-25",
        isSearchActive && isSearchMatch && "ring-1 ring-amber-500/50 z-10",
        bar.span.isMissing && "border-dashed italic text-muted-foreground",
      )}
      style={barStyle}
    >
      {/* Collapse toggle */}
      {bar.span.children.length > 0 && (
        <button
          data-collapse-toggle={bar.span.spanId}
          className="flex items-center justify-center w-4 h-4 shrink-0 ml-1 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
        >
          {bar.isCollapsed ? (
            <ChevronRightIcon size={12} />
          ) : (
            <ChevronDownIcon size={12} />
          )}
        </button>
      )}
      {bar.span.children.length === 0 && <div className="w-4 shrink-0 ml-1" />}

      {/* Labels */}
      {showName ? (
        <div className="flex items-center min-w-0 flex-1 gap-1 px-1">
          <span className="truncate text-foreground/90">
            {bar.span.spanName}
          </span>
          {showService && (
            <span className="truncate text-[10px] text-muted-foreground shrink-0">
              {bar.span.serviceName}
            </span>
          )}
          {cacheInfo?.result && (
            <span
              className={cn(
                "text-[9px] font-semibold px-1 shrink-0",
                cacheInfo.result === "hit"
                  ? "text-amber-400"
                  : "text-sky-400"
              )}
            >
              {cacheInfo.result === "hit" ? "HIT" : "MISS"}
            </span>
          )}
          {bar.isCollapsed && bar.childCount > 0 && (
            <span className="text-[9px] text-muted-foreground/60 shrink-0">
              +{bar.childCount}
            </span>
          )}
          {showDuration && (
            <span className="ml-auto shrink-0 pl-1 text-[10px] tabular-nums text-muted-foreground">
              {formatDuration(bar.span.durationMs)}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center min-w-0 flex-1 px-1">
          {bar.isCollapsed && bar.childCount > 0 && (
            <span className="text-[9px] text-muted-foreground/60">
              +{bar.childCount}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export const TraceTimelineBar = React.memo(TraceTimelineBarInner, (prev, next) => {
  return (
    prev.bar.span.spanId === next.bar.span.spanId &&
    prev.bar.row === next.bar.row &&
    prev.bar.isCollapsed === next.bar.isCollapsed &&
    prev.leftPercent === next.leftPercent &&
    prev.widthPercent === next.widthPercent &&
    prev.isSelected === next.isSelected &&
    prev.isFocused === next.isFocused &&
    prev.isSearchMatch === next.isSearchMatch &&
    prev.isSearchActive === next.isSearchActive &&
    prev.containerWidth === next.containerWidth
  )
})
