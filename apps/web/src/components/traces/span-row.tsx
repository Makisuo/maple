import { ChevronRightIcon, ChevronDownIcon } from "@/components/icons"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"
import { getCacheInfo, cacheResultStyles } from "@/lib/cache"
import type { SpanNode } from "@/api/tinybird/traces"

interface SpanRowProps {
  span: SpanNode
  totalDurationMs: number
  traceStartTime: string
  expanded: boolean
  onToggle: () => void
  isSelected?: boolean
  onSelect?: (span: SpanNode) => void
  defaultExpandDepth?: number
}

const statusStyles: Record<string, string> = {
  Ok: "bg-green-500/20 text-green-700 dark:bg-green-400/20 dark:text-green-400 border-green-500/30",
  Error: "bg-red-500/20 text-red-700 dark:bg-red-400/20 dark:text-red-400 border-red-500/30",
  Unset: "bg-gray-500/20 text-gray-600 dark:bg-gray-400/20 dark:text-gray-400 border-gray-500/30",
}

const kindLabels: Record<string, string> = {
  SPAN_KIND_SERVER: "Server",
  SPAN_KIND_CLIENT: "Client",
  SPAN_KIND_PRODUCER: "Producer",
  SPAN_KIND_CONSUMER: "Consumer",
  SPAN_KIND_INTERNAL: "Internal",
}

export function SpanRow({
  span,
  totalDurationMs,
  traceStartTime,
  expanded,
  onToggle,
  isSelected,
  onSelect,
}: SpanRowProps) {
  const hasChildren = span.children.length > 0

  if (span.isMissing) {
    return (
      <div
        className={cn(
          "group flex items-center border-b border-dashed py-1.5 px-2 bg-muted/30",
          isSelected && "bg-primary/5 border-l-2 border-l-primary"
        )}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {span.depth > 0 && <div style={{ width: `${span.depth * 24}px` }} className="shrink-0" />}

          {hasChildren ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5 shrink-0"
              onClick={(e) => {
                e.stopPropagation()
                onToggle()
              }}
            >
              {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            </Button>
          ) : (
            <div className="w-5 shrink-0" />
          )}

          <Badge
            variant="outline"
            className="shrink-0 font-mono text-[10px] px-1.5 border-dashed text-muted-foreground"
          >
            missing
          </Badge>

          <span className="flex-1 truncate font-mono text-xs italic text-muted-foreground" title={`Missing span: ${span.spanId}`}>
            Missing Span
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="w-32" />
          <span className="w-16 text-right font-mono text-[10px] text-muted-foreground/50 truncate" title={span.spanId}>
            {span.spanId.slice(0, 8)}
          </span>
          <div className="w-14" />
        </div>
      </div>
    )
  }

  // Calculate waterfall bar position and width
  const traceStartMs = new Date(traceStartTime).getTime()
  const spanStartMs = new Date(span.startTime).getTime()

  const leftPercent = totalDurationMs > 0
    ? ((spanStartMs - traceStartMs) / totalDurationMs) * 100
    : 0

  const widthPercent = totalDurationMs > 0
    ? (span.durationMs / totalDurationMs) * 100
    : 0

  const cacheInfo = getCacheInfo(span.spanAttributes)
  const statusStyle = statusStyles[span.statusCode] ?? statusStyles.Unset
  const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"

  return (
    <div
      className={cn(
        "group flex items-center border-b py-1.5 hover:bg-muted/50 cursor-pointer px-2",
        span.statusCode === "Error" && "bg-red-500/5",
        isSelected && "bg-primary/5 border-l-2 border-l-primary"
      )}
      onClick={() => onSelect?.(span)}
    >
      {/* Left section: Toggle + Service + Kind + Span Name (variable width) */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {/* Indentation spacer based on depth */}
        {span.depth > 0 && <div style={{ width: `${span.depth * 24}px` }} className="shrink-0" />}

        {hasChildren ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-5 w-5 shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </Button>
        ) : (
          <div className="w-5 shrink-0" />
        )}

        <Badge
          variant="outline"
          className="shrink-0 font-mono text-[10px] px-1.5"
        >
          {span.serviceName}
        </Badge>

        <span className="shrink-0 text-[10px] text-muted-foreground w-14">
          {kindLabel}
        </span>

        <span className="flex-1 truncate font-mono text-xs" title={span.spanName}>
          {span.spanName}
        </span>
      </div>

      {/* Right section: Duration bar + Duration text + Status (fixed widths, anchored right) */}
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <div className="w-32 h-2 bg-muted rounded-full overflow-hidden relative">
          <div
            className={cn(
              "h-full rounded-full absolute",
              span.statusCode === "Error"
                ? "bg-red-500"
                : cacheInfo?.result === "hit"
                  ? "bg-amber-500"
                  : cacheInfo?.result === "miss"
                    ? "bg-sky-500"
                    : "bg-primary"
            )}
            style={{
              left: `${leftPercent}%`,
              width: `${Math.max(widthPercent, 1)}%`
            }}
          />
        </div>

        <span className="w-16 text-right font-mono text-xs text-muted-foreground">
          {formatDuration(span.durationMs)}
        </span>

        {cacheInfo?.result ? (
          <Badge
            variant="outline"
            className={cn("text-[10px] w-14 justify-center font-medium", cacheResultStyles[cacheInfo.result])}
          >
            {cacheInfo.result === "hit" ? "HIT" : "MISS"}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className={cn("text-[10px] w-14 justify-center font-medium", statusStyle)}
          >
            {span.statusCode || "Unset"}
          </Badge>
        )}
      </div>
    </div>
  )
}
