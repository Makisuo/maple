import { formatDuration } from "../../lib/format"
import { getServiceLegendColor, calculateSelfTime } from "../../lib/colors"
import type { SpanNode } from "../../lib/types"

interface FlamegraphTooltipProps {
  span: SpanNode
  services?: string[]
  totalDurationMs?: number
  traceStartTime?: string
}

const kindLabels: Record<string, string> = {
  SPAN_KIND_SERVER: "Server",
  SPAN_KIND_CLIENT: "Client",
  SPAN_KIND_PRODUCER: "Producer",
  SPAN_KIND_CONSUMER: "Consumer",
  SPAN_KIND_INTERNAL: "Internal",
}

export function FlamegraphTooltipContent({
  span,
  services,
  totalDurationMs,
  traceStartTime
}: FlamegraphTooltipProps) {
  const kindLabel =
    kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"

  const serviceColor = services ? getServiceLegendColor(span.serviceName, services) : null
  const selfTime = calculateSelfTime(span, span.children)
  const selfTimePercent = span.durationMs > 0 ? (selfTime / span.durationMs) * 100 : 0
  const durationPercent = totalDurationMs ? (span.durationMs / totalDurationMs) * 100 : null

  const startOffset = traceStartTime
    ? new Date(span.startTime).getTime() - new Date(traceStartTime).getTime()
    : null

  const httpMethod = span.spanAttributes["http.method"] || span.spanAttributes["http.request.method"]
  const httpStatus = span.spanAttributes["http.status_code"] || span.spanAttributes["http.response.status_code"]
  const httpRoute = span.spanAttributes["http.route"] || span.spanAttributes["http.target"] || span.spanAttributes["url.path"]

  return (
    <div className="space-y-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        {serviceColor && (
          <div className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: serviceColor }} />
        )}
        <span className="font-medium truncate">{span.spanName}</span>
      </div>

      {durationPercent !== null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Duration</span>
            <span>{formatDuration(span.durationMs)} ({durationPercent.toFixed(1)}%)</span>
          </div>
          <div className="h-1.5 w-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary/70"
              style={{ width: `${Math.max(durationPercent, 1)}%` }}
            />
          </div>
        </div>
      )}

      {span.children.length > 0 && (
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted-foreground">Self time</span>
          <span>{formatDuration(selfTime)} ({selfTimePercent.toFixed(0)}%)</span>
        </div>
      )}

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        <span className="text-muted-foreground">Service</span>
        <span>{span.serviceName}</span>
        <span className="text-muted-foreground">Kind</span>
        <span>{kindLabel}</span>
        {startOffset !== null && (
          <>
            <span className="text-muted-foreground">Start offset</span>
            <span>+{formatDuration(startOffset)}</span>
          </>
        )}
        {durationPercent === null && (
          <>
            <span className="text-muted-foreground">Duration</span>
            <span>{formatDuration(span.durationMs)}</span>
          </>
        )}
        <span className="text-muted-foreground">Status</span>
        <span className={span.statusCode === "Error" ? "text-red-500" : span.statusCode === "Ok" ? "text-green-500" : ""}>
          {span.statusCode || "Unset"}
        </span>
      </div>

      {(httpMethod || httpStatus || httpRoute) && (
        <div className="border-t border-border pt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
          {httpMethod && (
            <>
              <span className="text-muted-foreground">Method</span>
              <span className="font-medium">{httpMethod}</span>
            </>
          )}
          {httpStatus && (
            <>
              <span className="text-muted-foreground">HTTP</span>
              <span className={Number(httpStatus) >= 400 ? "text-red-500" : Number(httpStatus) >= 300 ? "text-yellow-500" : "text-green-500"}>
                {httpStatus}
              </span>
            </>
          )}
          {httpRoute && (
            <>
              <span className="text-muted-foreground">Route</span>
              <span className="truncate max-w-[180px]">{httpRoute}</span>
            </>
          )}
        </div>
      )}

      {span.statusMessage && (
        <div className="border-t border-border pt-1.5 text-[10px]">
          <span className="text-muted-foreground">Message: </span>
          {span.statusMessage}
        </div>
      )}
    </div>
  )
}
