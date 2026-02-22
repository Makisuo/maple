import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import {
  CircleXmarkIcon,
  NetworkNodesIcon,
  PulseIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  CodeIcon,
  DatabaseIcon,
} from "@/components/icons"
import type { IconComponent } from "@/components/icons"

import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"
import { getSpanColorStyle, extractClassName } from "@maple/ui/colors"
import { getCacheInfo, cacheResultStyles, CACHE_OPERATION_COLORS } from "@/lib/cache"
import type { CacheInfo } from "@/lib/cache"
import type { FlowNodeData, AggregatedDuration } from "./flow-utils"

/**
 * Format duration display for combined spans
 * Shows "avg (min - max)" format for combined, simple duration for single
 */
function formatCombinedDuration(
  isCombined: boolean,
  singleDuration: number,
  aggregatedDuration: AggregatedDuration
): { main: string; tooltip: string } {
  if (!isCombined) {
    const formatted = formatDuration(singleDuration)
    return { main: formatted, tooltip: formatted }
  }

  const avg = formatDuration(aggregatedDuration.avg)
  const min = formatDuration(aggregatedDuration.min)
  const max = formatDuration(aggregatedDuration.max)
  const total = formatDuration(aggregatedDuration.total)

  return {
    main: `avg ${avg}`,
    tooltip: `Avg: ${avg} | Min: ${min} | Max: ${max} | Total: ${total}`,
  }
}

function getSpanIcon(spanKind: string, isHttpRequest: boolean, isError: boolean): IconComponent {
  if (isError) return CircleXmarkIcon
  if (isHttpRequest) return NetworkNodesIcon

  switch (spanKind) {
    case "SPAN_KIND_SERVER":
      return PulseIcon
    case "SPAN_KIND_CLIENT":
      return ChevronRightIcon
    case "SPAN_KIND_PRODUCER":
      return ChevronRightIcon
    case "SPAN_KIND_CONSUMER":
      return ChevronLeftIcon
    case "SPAN_KIND_INTERNAL":
      return CodeIcon
    default:
      return CodeIcon
  }
}

const SPAN_KIND_LABELS: Record<string, string> = {
  SPAN_KIND_SERVER: "Server",
  SPAN_KIND_CLIENT: "Client",
  SPAN_KIND_PRODUCER: "Producer",
  SPAN_KIND_CONSUMER: "Consumer",
  SPAN_KIND_INTERNAL: "Internal",
}

const HTTP_METHOD_COLORS: Record<string, string> = {
  GET: "bg-emerald-500",
  POST: "bg-blue-500",
  PUT: "bg-amber-500",
  PATCH: "bg-amber-500",
  DELETE: "bg-red-500",
  HEAD: "bg-purple-500",
  OPTIONS: "bg-gray-500",
}

function CacheSystemIcon({ system, size = 12 }: { system: CacheInfo["system"]; size?: number }) {
  const name = system?.toLowerCase()

  if (name === "redis") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
        <path
          d="M22.5 13.7c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 14.9 1.6 14.2 1.5 13.7v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V13.7z"
          fill="currentColor" opacity="0.4"
        />
        <path
          d="M22.5 9.2c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 10.4 1.6 9.7 1.5 9.2v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V9.2z"
          fill="currentColor" opacity="0.6"
        />
        <path
          d="M22.5 4.7c0 .6-1.5 1.3-4.6 2.3C16.2 7.7 14.1 8.3 12 8.7 9.9 8.3 7.8 7.7 6.1 7 3.1 6 1.5 5.3 1.5 4.7S3.1 3.4 6.1 2.4C7.8 1.7 9.9 1.1 12 .7c2.1.4 4.2 1 5.9 1.7 3 1 4.6 1.7 4.6 2.3z"
          fill="currentColor" opacity="0.9"
        />
      </svg>
    )
  }

  if (name === "memcached" || name === "memcache") {
    return <DatabaseIcon size={size} className="shrink-0 text-current" />
  }

  // Generic fallback — small database icon
  return <DatabaseIcon size={size} className="shrink-0 text-current" />
}

interface FlowSpanNodeProps {
  data: FlowNodeData
}

export const FlowSpanNode = memo(function FlowSpanNode({
  data,
}: FlowSpanNodeProps) {
  const { span, services, isSelected, count, aggregatedDuration } = data

  if (span.isMissing) {
    return (
      <>
        <Handle
          type="target"
          position={Position.Top}
          className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
          isConnectable={false}
        />
        <div
          className={cn(
            "relative w-[280px] rounded-lg transition-all duration-200",
            "flex flex-col overflow-hidden border-2 border-dashed border-muted-foreground/30",
            isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background"
          )}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] bg-muted/50 text-muted-foreground">
            <span className="font-semibold">Missing Span</span>
          </div>
          <div className="px-3 py-2.5 bg-card/50">
            <p className="font-mono text-[11px] text-muted-foreground/70 truncate" title={span.spanId}>
              {span.spanId.slice(0, 16)}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground/50 italic">
              Not ingested or dropped
            </p>
          </div>
        </div>
        <Handle
          type="source"
          position={Position.Bottom}
          className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
          isConnectable={false}
        />
      </>
    )
  }

  const isCombined = count > 1

  const kindLabel = SPAN_KIND_LABELS[span.spanKind] || span.spanKind.replace("SPAN_KIND_", "")

  // Check for HTTP request span
  // First try standard OTel attributes
  let httpMethod = span.spanAttributes["http.method"] as string | undefined
  let httpRoute = (span.spanAttributes["http.route"] || span.spanAttributes["http.target"]) as string | undefined
  const httpStatusCode = span.spanAttributes["http.status_code"] as string | number | undefined

  // Also check if span name starts with HTTP method (e.g., "POST /api/users")
  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
  const spanNameParts = span.spanName.split(" ")
  if (!httpMethod && spanNameParts.length >= 2 && HTTP_METHODS.includes(spanNameParts[0].toUpperCase())) {
    httpMethod = spanNameParts[0].toUpperCase()
    httpRoute = spanNameParts.slice(1).join(" ")
  }

  const isHttpRequest = !!httpMethod

  // Detect cache span
  const cacheInfo = getCacheInfo(span.spanAttributes)
  const isCacheSpan = !!cacheInfo

  // Detect error state from statusCode OR HTTP status code >= 400
  // Note: OpenTelemetry uses "Error" (not "ERROR") for error status
  const httpStatusNum = httpStatusCode !== undefined
    ? (typeof httpStatusCode === "string" ? parseInt(httpStatusCode) : httpStatusCode)
    : undefined
  const isError = span.statusCode === "Error" || (httpStatusNum !== undefined && httpStatusNum >= 400)

  const colorStyle = isError
    ? {}
    : getSpanColorStyle(span.spanName, span.serviceName, services)

  // Get the appropriate icon for this span
  const SpanIcon = isCacheSpan ? DatabaseIcon : getSpanIcon(span.spanKind, isHttpRequest, isError)

  // Extract class and function from span name (for non-HTTP spans)
  const className = extractClassName(span.spanName)
  const functionName = className
    ? span.spanName.slice(className.length + 1) // +1 for the . or ::
    : span.spanName

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />

      <div
        className={cn(
          "relative w-[280px] rounded-lg shadow-sm transition-all duration-200",
          "flex flex-col overflow-hidden hover:shadow-md",
          isError && "shadow-red-500/10",
          isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md"
        )}
      >
        {/* Header with service and kind/type */}
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-3 py-2 text-[11px]",
            isError ? "bg-red-500 text-white" : ""
          )}
          style={!isError ? colorStyle : undefined}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <SpanIcon size={14} className="shrink-0" />
            <span className="font-semibold truncate">{span.serviceName}</span>
          </div>
          <span className="opacity-75 shrink-0">{isCacheSpan ? (cacheInfo.system ?? "cache") : isHttpRequest ? "HTTP" : kindLabel}</span>
        </div>

        {/* Body + Footer wrapper with dotted border */}
        <div
          className={cn(
            "border border-dashed border-t-0 rounded-b-lg",
            isError ? "border-red-500/40" : "border-foreground/20"
          )}
        >
          {/* Body - Cache, HTTP, or default */}
          <div className="flex-1 px-3 py-2.5 bg-card">
          {isCacheSpan ? (
            <>
              <div className="flex items-center gap-2">
                {cacheInfo.operation && (
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded font-mono text-[11px] font-bold text-white shrink-0",
                      CACHE_OPERATION_COLORS[cacheInfo.operation.toUpperCase()] || "bg-gray-500"
                    )}
                  >
                    {cacheInfo.operation.toUpperCase()}
                  </span>
                )}
                <span
                  className="font-mono text-xs text-foreground truncate"
                  title={cacheInfo.name || span.spanName}
                >
                  {cacheInfo.name || span.spanName}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                {(() => {
                  const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
                  return <span title={tooltip}>{main}</span>
                })()}
                {cacheInfo.result && (
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded font-mono font-bold text-[10px]",
                      cacheResultStyles[cacheInfo.result]
                    )}
                  >
                    {cacheInfo.result === "hit" ? "HIT" : "MISS"}
                  </span>
                )}
              </div>
            </>
          ) : isHttpRequest && httpMethod ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "px-2 py-0.5 rounded font-mono text-[11px] font-bold text-white shrink-0",
                    HTTP_METHOD_COLORS[httpMethod.toUpperCase()] || "bg-gray-500"
                  )}
                >
                  {httpMethod.toUpperCase()}
                </span>
                <span
                  className="font-mono text-xs text-foreground truncate"
                  title={httpRoute || span.spanName}
                >
                  {httpRoute || span.spanName}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                {(() => {
                  const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
                  return <span title={tooltip}>{main}</span>
                })()}
                {httpStatusCode !== undefined && (
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded font-mono font-bold",
                      httpStatusNum !== undefined && httpStatusNum >= 200 && httpStatusNum < 300 &&
                        "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                      httpStatusNum !== undefined && httpStatusNum >= 300 && httpStatusNum < 400 &&
                        "bg-blue-500/15 text-blue-600 dark:text-blue-400",
                      httpStatusNum !== undefined && httpStatusNum >= 400 && httpStatusNum < 500 &&
                        "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                      httpStatusNum !== undefined && httpStatusNum >= 500 &&
                        "bg-red-500/15 text-red-600 dark:text-red-400",
                      (httpStatusNum === undefined || httpStatusNum < 200) &&
                        "text-muted-foreground"
                    )}
                  >
                    {httpStatusCode}
                  </span>
                )}
              </div>
            </>
          ) : className ? (
            <>
              <div
                className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold mb-1"
                style={{
                  backgroundColor: `${colorStyle.backgroundColor}20`,
                  color: colorStyle.backgroundColor,
                }}
              >
                {className}
              </div>
              <div className="font-mono text-xs font-medium truncate text-foreground" title={functionName}>
                {functionName}
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground font-medium">
                {(() => {
                  const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
                  return <span title={tooltip}>{main}</span>
                })()}
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-xs font-medium truncate" title={span.spanName}>
                {span.spanName}
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground font-medium">
                {(() => {
                  const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
                  return <span title={tooltip}>{main}</span>
                })()}
              </div>
            </>
          )}
          </div>

          {/* Footer - span status */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 rounded-b-lg border-t border-dashed border-foreground/10 text-[10px]">
          {isCacheSpan && cacheInfo.result ? (
            <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", cacheResultStyles[cacheInfo.result])}>
              {cacheInfo.result === "hit" ? "HIT" : "MISS"}
            </span>
          ) : isError ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-600 dark:text-red-400">
              Error
            </span>
          ) : span.statusCode === "Ok" || (httpStatusNum !== undefined && httpStatusNum >= 200 && httpStatusNum < 400) ? (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              OK
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground">
              {span.statusCode}
            </span>
          )}
          {isCacheSpan && cacheInfo.system ? (
            <span className="flex items-center gap-1 text-muted-foreground/60 ml-2">
              <CacheSystemIcon system={cacheInfo.system} size={11} />
              <span className="font-mono truncate">{cacheInfo.system}</span>
            </span>
          ) : isCombined ? (
            <span className="font-mono text-muted-foreground/60 truncate ml-2">
              {count} spans
            </span>
          ) : (
            <span className="font-mono text-muted-foreground/60 truncate ml-2" title={span.spanId}>
              {span.spanId.slice(0, 8)}
            </span>
          )}
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
        isConnectable={false}
      />
    </>
  )
})
