import { useState } from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { XmarkIcon, ClockIcon, CircleWarningIcon, CircleInfoIcon, SquareTerminalIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from "@/components/icons"
import { toast } from "sonner"

import { Button } from "@maple/ui/components/ui/button"
import { Alert, AlertTitle, AlertDescription } from "@maple/ui/components/ui/alert"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { type Log, type LogsResponse } from "@/api/tinybird/logs"
import { formatDuration } from "@/lib/format"
import { cn } from "@maple/ui/utils"
import { getCacheInfo, cacheResultStyles } from "@/lib/cache"
import type { SpanNode } from "@/api/tinybird/traces"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { listLogsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { CopyableValue, AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

interface SpanDetailPanelProps {
  span: SpanNode
  onClose: () => void
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

const severityStyles: Record<string, string> = {
  TRACE: "text-gray-500",
  DEBUG: "text-gray-500",
  INFO: "text-blue-500",
  WARN: "text-yellow-500",
  ERROR: "text-red-500",
  FATAL: "text-red-700",
}

function LogEntry({ log, timeZone }: { log: Log; timeZone: string }) {
  const severityStyle = severityStyles[log.severityText] ?? "text-gray-500"

  return (
    <div className="border-b py-2 px-2 last:border-b-0 hover:bg-muted/30">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-1">
        <span>{formatTimestampInTimezone(log.timestamp, { timeZone })}</span>
        <Badge variant="outline" className={cn("text-[10px] px-1 py-0", severityStyle)}>
          {log.severityText}
        </Badge>
      </div>
      <p className="font-mono text-xs whitespace-pre-wrap break-all">
        <CopyableValue value={log.body}>{log.body}</CopyableValue>
      </p>
    </div>
  )
}

interface ErrorSectionProps {
  message: string
  serviceName: string
  spanName: string
  attributes?: Record<string, string>
}

function formatErrorPrompt({ message, serviceName, spanName, attributes }: ErrorSectionProps): string {
  const relevantKeys = [
    "http.method",
    "http.url",
    "http.route",
    "http.status_code",
    "db.system",
    "db.statement",
    "rpc.method",
    "rpc.service",
    "messaging.system",
    "messaging.operation",
  ]

  const contextLines: string[] = []
  if (attributes) {
    for (const key of relevantKeys) {
      if (attributes[key]) {
        contextLines.push(`- ${key}: ${attributes[key]}`)
      }
    }
  }

  return `I'm debugging an error in my distributed system. Please help me understand and fix this issue.

**Service:** ${serviceName}
**Operation:** ${spanName}

**Error:**
\`\`\`
${message}
\`\`\`
${contextLines.length > 0 ? `
**Context:**
${contextLines.join("\n")}
` : ""}
What could be causing this error and how can I fix it?`
}

function ErrorSection({ message, serviceName, spanName, attributes }: ErrorSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const isLong = message.length > 120 || message.includes('\n')

  const handleCopyPrompt = async () => {
    const prompt = formatErrorPrompt({ message, serviceName, spanName, attributes })
    await navigator.clipboard.writeText(prompt)
    toast.success("Copied error prompt to clipboard")
  }

  return (
    <Alert variant="destructive" className="mx-3 my-2 rounded-md border-red-500/30">
      <CircleWarningIcon size={14} />
      <AlertTitle className="flex items-center justify-between">
        <span>Error</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10"
          onClick={handleCopyPrompt}
        >
          <CopyIcon size={10} className="mr-1" />
          Copy as prompt
        </Button>
      </AlertTitle>
      <AlertDescription>
        {isLong ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            {!expanded && (
              <p className="font-mono text-[11px] line-clamp-2">{message}</p>
            )}
            <CollapsibleTrigger className="text-[10px] text-red-400 hover:text-red-300 mt-1 flex items-center gap-1">
              {expanded ? "Show less" : "Show full error"}
              {expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-all mt-2 p-2 bg-red-500/5 rounded max-h-48 overflow-auto">
                {message}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <p className="font-mono text-[11px]">{message}</p>
        )}
      </AlertDescription>
    </Alert>
  )
}

function SpanLogs({
  traceId,
  spanId,
  timeZone,
}: {
  traceId: string
  spanId: string
  timeZone: string
}) {
  const logsResult = useAtomValue(
    traceId && spanId
      ? listLogsResultAtom({ data: { traceId, spanId, limit: 100 } })
      : disabledResultAtom<LogsResponse>(),
  )

  return Result.builder(logsResult)
    .onInitial(() => (
      <div className="space-y-2 p-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    ))
    .onError(() => (
      <div className="p-4 text-center text-sm text-red-500">
        Failed to load logs
      </div>
    ))
    .onSuccess((data) => {
      const logs = data.data

      if (logs.length === 0) {
        return (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No logs found for this span
          </div>
        )
      }

      return (
        <div className="divide-y">
          {logs.map((log, i) => (
            <LogEntry key={`${log.timestamp}-${i}`} log={log} timeZone={timeZone} />
          ))}
        </div>
      )
    })
    .render()
}

export function SpanDetailPanel({ span, onClose }: SpanDetailPanelProps) {
  const { effectiveTimezone } = useTimezonePreference()
  const cacheInfo = getCacheInfo(span.spanAttributes)
  const statusStyle = statusStyles[span.statusCode] ?? statusStyles.Unset
  const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"
  const logsResult = useAtomValue(
    span.traceId && span.spanId
      ? listLogsResultAtom({ data: { traceId: span.traceId, spanId: span.spanId, limit: 100 } })
      : disabledResultAtom<LogsResponse>(),
  )
  const logCount = Result.isSuccess(logsResult) ? logsResult.value.data.length : null

  return (
    <div className="flex flex-col h-full border-l bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2 shrink-0 overflow-hidden">
        <div className="flex-1 min-w-0 mr-2">
          <CopyableValue value={span.spanName} className="block min-w-0 overflow-hidden">
            <h2 className="font-semibold text-sm truncate" title={span.spanName}>
              {span.spanName}
            </h2>
          </CopyableValue>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge variant="outline" className="font-mono text-[10px]">
              <CopyableValue value={span.serviceName}>{span.serviceName}</CopyableValue>
            </Badge>
            <span className="text-[10px] text-muted-foreground">{kindLabel}</span>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0">
          <XmarkIcon size={16} />
        </Button>
      </div>

      {/* Summary stats */}
      <div className="flex items-center gap-4 border-b px-3 py-1.5 text-xs shrink-0">
        <div className="flex items-center gap-1.5">
          <ClockIcon size={12} className="text-muted-foreground" />
          <span className="font-mono">
            <CopyableValue value={formatDuration(span.durationMs)}>
              {formatDuration(span.durationMs)}
            </CopyableValue>
          </span>
        </div>
        {cacheInfo?.result ? (
          <Badge variant="outline" className={cn("text-[10px] font-medium", cacheResultStyles[cacheInfo.result])}>
            {cacheInfo.result === "hit" ? "HIT" : "MISS"}
          </Badge>
        ) : (
          <Badge variant="outline" className={cn("text-[10px] font-medium", statusStyle)}>
            {span.statusCode || "Unset"}
          </Badge>
        )}
      </div>

      {/* Cache summary */}
      {cacheInfo && (
        <div className="flex items-center gap-3 border-b px-3 py-1.5 text-xs shrink-0">
          {cacheInfo.system && (
            <Badge variant="outline" className="text-[10px] font-mono">
              {cacheInfo.system}
            </Badge>
          )}
          {cacheInfo.operation && (
            <span className="font-mono text-muted-foreground uppercase">{cacheInfo.operation}</span>
          )}
          {cacheInfo.name && (
            <span className="font-mono text-muted-foreground truncate" title={cacheInfo.name}>
              {cacheInfo.name}
            </span>
          )}
        </div>
      )}

      {/* Error section */}
      {span.statusCode === "Error" && span.statusMessage && (
        <ErrorSection
          message={span.statusMessage}
          serviceName={span.serviceName}
          spanName={span.spanName}
          attributes={span.spanAttributes}
        />
      )}

      {/* Tabs content */}
      <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
        <TabsList variant="line" className="shrink-0 px-4">
          <TabsTrigger value="details"><CircleInfoIcon size={14} /> Details</TabsTrigger>
          <TabsTrigger value="logs">
            <SquareTerminalIcon size={14} /> Logs
            {logCount !== null && logCount > 0 && (
              <Badge variant="secondary" className="text-[10px] ml-1 px-1.5 py-0">
                {logCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="flex-1 min-h-0 mt-0">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
              {/* Timing info */}
              <div className="space-y-1">
                <h4 className="text-xs font-medium text-muted-foreground">Timing</h4>
                <div className="rounded-md border p-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Start Time</span>
                    <span className="font-mono">
                      <CopyableValue value={span.startTime}>
                        {formatTimestampInTimezone(span.startTime, {
                          timeZone: effectiveTimezone,
                          withMilliseconds: true,
                        })}
                      </CopyableValue>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-mono">
                      <CopyableValue value={formatDuration(span.durationMs)}>
                        {formatDuration(span.durationMs)}
                      </CopyableValue>
                    </span>
                  </div>
                </div>
              </div>

              {/* IDs */}
              <div className="space-y-1">
                <h4 className="text-xs font-medium text-muted-foreground">Identifiers</h4>
                <div className="rounded-md border p-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Span ID</span>
                    <span className="font-mono">
                      <CopyableValue value={span.spanId}>{span.spanId}</CopyableValue>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Trace ID</span>
                    <span className="font-mono">
                      <CopyableValue value={span.traceId}>{span.traceId}</CopyableValue>
                    </span>
                  </div>
                  {span.parentSpanId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Parent Span ID</span>
                      <span className="font-mono">
                        <CopyableValue value={span.parentSpanId}>{span.parentSpanId}</CopyableValue>
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Span Attributes */}
              <AttributesTable
                attributes={span.spanAttributes ?? {}}
                title="Span Attributes"
              />

              {/* Resource Attributes */}
              <ResourceAttributesSection attributes={span.resourceAttributes ?? {}} />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="logs" className="flex-1 min-h-0 mt-0">
          <ScrollArea className="h-full">
            <SpanLogs
              traceId={span.traceId}
              spanId={span.spanId}
              timeZone={effectiveTimezone}
            />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
