import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useState } from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Log } from "@/api/tinybird/logs"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { SeverityBadge } from "./severity-badge"
import { LogDetailSheet } from "./log-detail-sheet"
import type { LogsSearchParams } from "@/routes/logs"
import { listLogsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

function truncateBody(body: string, maxLength = 100): string {
  if (body.length <= maxLength) return body
  return body.slice(0, maxLength) + "..."
}

interface LogsTableProps {
  filters?: LogsSearchParams
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">Timestamp</TableHead>
              <TableHead className="w-[120px]">Service</TableHead>
              <TableHead className="w-[80px]">Severity</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 10 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                <TableCell><Skeleton className="h-4 w-full" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function LogsTable({ filters }: LogsTableProps) {
  const [selectedLog, setSelectedLog] = useState<Log | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const { effectiveTimezone } = useTimezonePreference()

  const { startTime: effectiveStartTime, endTime: effectiveEndTime } =
    useEffectiveTimeRange(filters?.startTime, filters?.endTime)

  const logsResult = useAtomValue(
    listLogsResultAtom({
      data: {
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        service: filters?.services?.[0],
        severity: filters?.severities?.[0],
        search: filters?.search,
      },
    }),
  )

  const handleRowClick = (log: Log) => {
    setSelectedLog(log)
    setSheetOpen(true)
  }

  return Result.builder(logsResult)
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-red-500/50 bg-red-500/10 p-8">
        <p className="font-medium text-red-600">Failed to load logs</p>
        <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess((response, result) => (
      <>
        <div className={`space-y-4 transition-opacity ${result.waiting ? "opacity-60" : ""}`}>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">Timestamp</TableHead>
                  <TableHead className="w-[120px]">Service</TableHead>
                  <TableHead className="w-[80px]">Severity</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {response.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center">
                      No logs found
                    </TableCell>
                  </TableRow>
                ) : (
                  response.data.map((log: Log) => (
                    <TableRow
                      key={`${log.timestamp}-${log.traceId}-${log.spanId}`}
                      className="cursor-pointer"
                      onClick={() => handleRowClick(log)}
                    >
                      <TableCell className="font-mono text-muted-foreground">
                        {formatTimestampInTimezone(log.timestamp, {
                          timeZone: effectiveTimezone,
                        })}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{log.serviceName}</span>
                      </TableCell>
                      <TableCell>
                        <SeverityBadge severity={log.severityText} />
                      </TableCell>
                      <TableCell className="max-w-md">
                        <span className="font-mono text-xs">{truncateBody(log.body)}</span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="text-sm text-muted-foreground">
            Showing {response.data.length} of {response.meta.total} logs
          </div>
        </div>

        <LogDetailSheet
          log={selectedLog}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
        />
      </>
    ))
    .render()
}
