import { Link } from "@tanstack/react-router"
import { XmarkIcon, ClockIcon, PulseIcon } from "@/components/icons"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetClose,
} from "@maple/ui/components/ui/sheet"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { SeverityBadge } from "./severity-badge"
import { cn } from "@maple/ui/utils"
import type { Log } from "@/api/tinybird/logs"

interface LogDetailSheetProps {
  log: Log | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })
}

function CopyableValue({
  value,
  children,
  className,
}: {
  value: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
        className
      )}
      onClick={() => {
        navigator.clipboard.writeText(value)
        toast.success("Copied to clipboard")
      }}
      title="Click to copy"
    >
      {children ?? value}
    </span>
  )
}

function AttributesTable({ attributes, title }: { attributes: Record<string, string>; title: string }) {
  const entries = Object.entries(attributes)

  if (entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-2">
        No {title.toLowerCase()} available
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="rounded-md border">
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b last:border-b-0">
                <td className="px-2 py-1.5 font-mono text-muted-foreground bg-muted/30 w-1/3 break-all">
                  <CopyableValue value={key}>{key}</CopyableValue>
                </td>
                <td className="px-2 py-1.5 font-mono break-all">
                  <CopyableValue value={value}>{value}</CopyableValue>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
  if (!log) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-0 sm:max-w-lg" showCloseButton={false}>
        {/* Header */}
        <div className="flex items-center justify-between border-b px-3 py-2 shrink-0">
          <div className="flex-1 min-w-0 mr-2">
            <SheetTitle className="text-sm font-semibold">Log Details</SheetTitle>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="outline" className="font-mono text-[10px]">
                <CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
              </Badge>
              <SeverityBadge severity={log.severityText} />
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
              <CopyableValue value={log.timestamp}>
                {formatTimestamp(log.timestamp)}
              </CopyableValue>
            </span>
          </div>
          <span className="text-muted-foreground">
            Severity {log.severityNumber}
          </span>
        </div>

        {/* Trace link banner */}
        {log.traceId && (
          <div className="border-b px-3 py-2 shrink-0">
            <Link
              to="/traces/$traceId"
              params={{ traceId: log.traceId }}
              className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs hover:bg-primary/10 transition-colors"
            >
              <PulseIcon size={14} className="text-primary shrink-0" />
              <span className="font-medium">View Trace</span>
              <span className="font-mono text-muted-foreground truncate ml-auto">
                {log.traceId.slice(0, 16)}...
              </span>
            </Link>
          </div>
        )}

        {/* Scrollable content */}
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-3">
            {/* Message */}
            <div className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">Message</h4>
              <div className="rounded-md border p-2">
                <CopyableValue value={log.body}>
                  <p className="font-mono text-[11px] whitespace-pre-wrap break-all">
                    {log.body}
                  </p>
                </CopyableValue>
              </div>
            </div>

            {/* Identifiers */}
            {(log.traceId || log.spanId) && (
              <div className="space-y-1">
                <h4 className="text-xs font-medium text-muted-foreground">Identifiers</h4>
                <div className="rounded-md border p-2 space-y-1 text-xs">
                  {log.traceId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trace ID</span>
                      <span className="font-mono">
                        <CopyableValue value={log.traceId}>{log.traceId}</CopyableValue>
                      </span>
                    </div>
                  )}
                  {log.spanId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Span ID</span>
                      <span className="font-mono">
                        <CopyableValue value={log.spanId}>{log.spanId}</CopyableValue>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Log Attributes */}
            <AttributesTable
              attributes={log.logAttributes}
              title="Log Attributes"
            />

            {/* Resource Attributes */}
            <AttributesTable
              attributes={log.resourceAttributes}
              title="Resource Attributes"
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
