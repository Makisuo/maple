import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import {
  CircleXmarkIcon,
  NetworkNodesIcon,
  PulseIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  CodeIcon,
  type IconComponent,
} from "../icons"

import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { getSpanColorStyle, extractClassName } from "../../lib/colors"
import type { FlowNodeData, AggregatedDuration } from "./flow-utils"

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
    case "SPAN_KIND_SERVER": return PulseIcon
    case "SPAN_KIND_CLIENT": return ChevronRightIcon
    case "SPAN_KIND_PRODUCER": return ChevronRightIcon
    case "SPAN_KIND_CONSUMER": return ChevronLeftIcon
    case "SPAN_KIND_INTERNAL": return CodeIcon
    default: return CodeIcon
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

interface FlowSpanNodeProps {
  data: FlowNodeData
}

export const FlowSpanNode = memo(function FlowSpanNode({ data }: FlowSpanNodeProps) {
  const { span, services, isSelected, count, aggregatedDuration } = data
  const isCombined = count > 1
  const kindLabel = SPAN_KIND_LABELS[span.spanKind] || span.spanKind.replace("SPAN_KIND_", "")

  let httpMethod = span.spanAttributes["http.method"] as string | undefined
  let httpRoute = (span.spanAttributes["http.route"] || span.spanAttributes["http.target"]) as string | undefined
  const httpStatusCode = span.spanAttributes["http.status_code"] as string | number | undefined

  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
  const spanNameParts = span.spanName.split(" ")
  if (!httpMethod && spanNameParts.length >= 2 && HTTP_METHODS.includes(spanNameParts[0].toUpperCase())) {
    httpMethod = spanNameParts[0].toUpperCase()
    httpRoute = spanNameParts.slice(1).join(" ")
  }

  const isHttpRequest = !!httpMethod

  const httpStatusNum = httpStatusCode !== undefined
    ? (typeof httpStatusCode === "string" ? parseInt(httpStatusCode) : httpStatusCode)
    : undefined
  const isError = span.statusCode === "Error" || (httpStatusNum !== undefined && httpStatusNum >= 400)

  const colorStyle = isError ? {} : getSpanColorStyle(span.spanName, span.serviceName, services)
  const SpanIcon = getSpanIcon(span.spanKind, isHttpRequest, isError)

  const className = extractClassName(span.spanName)
  const functionName = className
    ? span.spanName.slice(className.length + 1)
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
          "relative w-[280px] shadow-sm transition-all duration-200",
          "flex flex-col overflow-hidden hover:shadow-md",
          isError && "shadow-red-500/10",
          isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md"
        )}
      >
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
          <span className="opacity-75 shrink-0">{isHttpRequest ? "HTTP" : kindLabel}</span>
        </div>

        <div className={cn(
          "border border-dashed border-t-0",
          isError ? "border-red-500/40" : "border-foreground/20"
        )}>
          <div className="flex-1 px-3 py-2.5 bg-card">
            {isHttpRequest && httpMethod ? (
              <>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "px-2 py-0.5 font-mono text-[11px] font-bold text-white shrink-0",
                    HTTP_METHOD_COLORS[httpMethod.toUpperCase()] || "bg-gray-500"
                  )}>
                    {httpMethod.toUpperCase()}
                  </span>
                  <span className="font-mono text-xs text-foreground truncate" title={httpRoute || span.spanName}>
                    {httpRoute || span.spanName}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                  {(() => {
                    const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)
                    return <span title={tooltip}>{main}</span>
                  })()}
                  {httpStatusCode !== undefined && (
                    <span className={cn(
                      "px-1.5 py-0.5 font-mono font-bold",
                      httpStatusNum !== undefined && httpStatusNum >= 200 && httpStatusNum < 300 && "bg-emerald-500/15 text-emerald-400",
                      httpStatusNum !== undefined && httpStatusNum >= 300 && httpStatusNum < 400 && "bg-blue-500/15 text-blue-400",
                      httpStatusNum !== undefined && httpStatusNum >= 400 && httpStatusNum < 500 && "bg-amber-500/15 text-amber-400",
                      httpStatusNum !== undefined && httpStatusNum >= 500 && "bg-red-500/15 text-red-400",
                      (httpStatusNum === undefined || httpStatusNum < 200) && "text-muted-foreground"
                    )}>
                      {httpStatusCode}
                    </span>
                  )}
                </div>
              </>
            ) : className ? (
              <>
                <div
                  className="inline-block px-1.5 py-0.5 text-[10px] font-semibold mb-1"
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

          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-t border-dashed border-foreground/10 text-[10px]">
            {isError ? (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400">Error</span>
            ) : span.statusCode === "Ok" || (httpStatusNum !== undefined && httpStatusNum >= 200 && httpStatusNum < 400) ? (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">OK</span>
            ) : (
              <span className="px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{span.statusCode}</span>
            )}
            {isCombined ? (
              <span className="font-mono text-muted-foreground/60 truncate ml-2">{count} spans</span>
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
