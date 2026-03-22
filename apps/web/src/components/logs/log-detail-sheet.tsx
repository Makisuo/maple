import { useState, useEffect, useRef } from "react"
import { Link } from "@tanstack/react-router"
import { XmarkIcon, ClockIcon, PulseIcon } from "@/components/icons"
import { Result, useAtomValue } from "@/lib/effect-atom"

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetClose,
} from "@maple/ui/components/ui/sheet"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"
import { SeverityBadge } from "./severity-badge"
import { getSeverityColor } from "@/lib/severity"
import type { Log, LogsResponse } from "@/api/tinybird/logs"
import type { SpanHierarchyResponse } from "@/api/tinybird/traces"
import { CopyableValue, AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import { listLogsResultAtom, getSpanHierarchyResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

function formatRelativeMs(ms: number): string {
  if (ms < 1) return "+0ms"
  if (ms < 1000) return `+${Math.round(ms)}ms`
  if (ms < 10000) return `+${(ms / 1000).toFixed(1)}s`
  return `+${Math.round(ms / 1000)}s`
}

function isCurrentLog(log: Log, currentLog: Log): boolean {
  return log.timestamp === currentLog.timestamp && log.spanId === currentLog.spanId && log.body === currentLog.body
}

function TraceTimeline({
  currentLog,
  onLogSelect,
}: {
  currentLog: Log
  onLogSelect: (log: Log) => void
}) {
  const logsResult = useAtomValue(
    currentLog.traceId
      ? listLogsResultAtom({ data: { traceId: currentLog.traceId, limit: 200 } })
      : disabledResultAtom<LogsResponse>(),
  )
  const spansResult = useAtomValue(
    currentLog.traceId
      ? getSpanHierarchyResultAtom({ data: { traceId: currentLog.traceId } })
      : disabledResultAtom<SpanHierarchyResponse>(),
  )
  const currentLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (currentLogRef.current) {
      currentLogRef.current.scrollIntoView({ block: "nearest" })
    }
  }, [currentLog])

  if (!currentLog.traceId) return null

  return (
    <div className="space-y-1.5">
      {Result.builder(logsResult)
        .onInitial(() => (
          <>
            <h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
            <div className="rounded-md border overflow-hidden">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 border-b last:border-b-0">
                  <Skeleton className="h-3 w-10 shrink-0" />
                  <Skeleton className="h-3 w-16 shrink-0" />
                  <Skeleton className="h-3 flex-1" />
                </div>
              ))}
            </div>
          </>
        ))
        .onError(() => (
          <>
            <h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
            <div className="p-3 text-center text-xs text-destructive">
              Failed to load trace logs
            </div>
          </>
        ))
        .onSuccess((data) => {
          const logs = [...data.data].sort((a, b) => a.timestamp.localeCompare(b.timestamp))

          if (logs.length <= 1) {
            return (
              <>
                <h4 className="text-xs font-medium text-muted-foreground">Trace Timeline</h4>
                <div className="p-3 text-center text-xs text-muted-foreground">
                  No other logs in this trace
                </div>
              </>
            )
          }

          const traceStart = new Date(logs[0].timestamp).getTime()

          // Build spanId → spanName lookup from span hierarchy data
          const spanNameMap = new Map<string, string>()
          if (Result.isSuccess(spansResult)) {
            for (const span of spansResult.value.spans) {
              spanNameMap.set(span.spanId, span.spanName)
            }
          }

          return (
            <>
              <h4 className="text-xs font-medium text-muted-foreground">
                Trace Timeline
                <span className="ml-1 text-muted-foreground/60">{logs.length}</span>
              </h4>
              <div className="rounded-md border overflow-hidden">
                {logs.map((log, i) => {
                  const isCurrent = isCurrentLog(log, currentLog)
                  const relativeMs = new Date(log.timestamp).getTime() - traceStart
                  const prevLog = i > 0 ? logs[i - 1] : null
                  const spanChanged = prevLog && prevLog.spanId !== log.spanId && log.spanId

                  return (
                    <div key={`${log.timestamp}-${log.spanId}-${i}`}>
                      {spanChanged && (
                        <div className="flex items-center gap-2 px-2 py-0.5 bg-muted/30">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-[9px] font-mono text-muted-foreground/60 shrink-0 truncate max-w-[200px]">
                            {spanNameMap.get(log.spanId) ?? log.spanId.slice(0, 8)}
                          </span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <div
                        ref={isCurrent ? currentLogRef : undefined}
                        style={{ borderLeftColor: getSeverityColor(log.severityText) }}
                        className={cn(
                          "border-l-2 flex items-center gap-1.5 px-2 py-1 text-xs font-mono cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors",
                          isCurrent && "bg-primary/8",
                        )}
                        onClick={() => {
                          if (!isCurrent) onLogSelect(log)
                        }}
                      >
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-[52px] text-right">
                          {formatRelativeMs(relativeMs)}
                        </span>
                        {log.serviceName !== currentLog.serviceName && (
                          <span className="text-[10px] text-muted-foreground/60 truncate max-w-[72px] shrink-0">
                            {log.serviceName}
                          </span>
                        )}
                        <span className={cn(
                          "min-w-0 flex-1 truncate text-[11px]",
                          isCurrent ? "text-foreground" : "text-foreground/80",
                        )}>
                          {log.body}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )
        })
        .render()}
    </div>
  )
}

interface LogDetailSheetProps {
  log: Log | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
  const { effectiveTimezone } = useTimezonePreference()
  const [viewedLog, setViewedLog] = useState<Log | null>(log)

  useEffect(() => {
    if (log) setViewedLog(log)
  }, [log])

  if (!viewedLog) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-0 sm:max-w-lg" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
          <div className="flex-1 min-w-0 mr-2">
            <SheetTitle className="text-sm font-semibold">Log Details</SheetTitle>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="outline" className="font-mono text-[10px]">
                <CopyableValue value={viewedLog.serviceName}>{viewedLog.serviceName}</CopyableValue>
              </Badge>
              <SeverityBadge severity={viewedLog.severityText} />
            </div>
          </div>
          <SheetClose
            render={
              <Button variant="ghost" size="icon" className="shrink-0" />
            }
          >
            <XmarkIcon size={16} />
          </SheetClose>
        </div>

        {/* Summary stats */}
        <div className="flex items-center gap-4 border-b px-3 py-1.5 text-xs shrink-0">
          <div className="flex items-center gap-1.5">
            <ClockIcon size={12} className="text-muted-foreground" />
            <span className="font-mono">
              <CopyableValue value={viewedLog.timestamp}>
                {formatTimestampInTimezone(viewedLog.timestamp, {
                  timeZone: effectiveTimezone,
                  withMilliseconds: true,
                })}
              </CopyableValue>
            </span>
          </div>
          <span className="text-muted-foreground">
            Severity {viewedLog.severityNumber}
          </span>
        </div>

        {/* Trace link banner */}
        {viewedLog.traceId && (
          <div className="border-b px-3 py-2 shrink-0">
            <Link
              to="/traces/$traceId"
              params={{ traceId: viewedLog.traceId }}
              className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs hover:bg-primary/10 transition-colors"
            >
              <PulseIcon size={14} className="text-primary shrink-0" />
              <span className="font-medium">View Trace</span>
              <span className="font-mono text-muted-foreground truncate ml-auto">
                {viewedLog.traceId.slice(0, 16)}...
              </span>
            </Link>
          </div>
        )}

        {/* Scrollable content */}
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="p-3 space-y-3">
            {/* Message */}
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">Message</h4>
              <div className="rounded-md border p-2">
                <CopyableValue value={viewedLog.body}>
                  <p className="font-mono text-[11px] whitespace-pre-wrap break-all">
                    {viewedLog.body}
                  </p>
                </CopyableValue>
              </div>
            </div>

            {/* Identifiers */}
            {(viewedLog.traceId || viewedLog.spanId) && (
              <div className="space-y-1">
                <h4 className="text-xs font-medium text-muted-foreground">Identifiers</h4>
                <div className="rounded-md border p-2 space-y-1 text-xs">
                  {viewedLog.traceId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trace ID</span>
                      <span className="font-mono">
                        <CopyableValue value={viewedLog.traceId}>{viewedLog.traceId}</CopyableValue>
                      </span>
                    </div>
                  )}
                  {viewedLog.spanId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Span ID</span>
                      <span className="font-mono">
                        <CopyableValue value={viewedLog.spanId}>{viewedLog.spanId}</CopyableValue>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Log Attributes */}
            <AttributesTable
              attributes={viewedLog.logAttributes}
              title="Log Attributes"
            />

            {/* Resource Attributes */}
            <ResourceAttributesSection attributes={viewedLog.resourceAttributes} />

            {/* Trace Timeline */}
            <TraceTimeline
              currentLog={viewedLog}
              onLogSelect={setViewedLog}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
