import { Link, useNavigate } from "@tanstack/react-router"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import type { Trace } from "@/api/tinybird/traces"

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function truncateId(id: string, length = 8): string {
  if (id.length <= length) return id
  return id.slice(0, length)
}

function StatusBadge({ hasError }: { hasError: boolean }) {
  if (hasError) {
    return (
      <Badge
        variant="secondary"
        className="bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400"
      >
        Error
      </Badge>
    )
  }
  return (
    <Badge
      variant="secondary"
      className="bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400"
    >
      OK
    </Badge>
  )
}

interface EndpointRecentTracesProps {
  traces: Trace[]
  service: string
  endpoint: string
  method: string
  startTime?: string
  endTime?: string
}

export function EndpointRecentTraces({
  traces,
  service,
  endpoint,
  method,
  startTime,
  endTime,
}: EndpointRecentTracesProps) {
  const navigate = useNavigate()

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Trace ID</TableHead>
              <TableHead className="w-[180px]">Time</TableHead>
              <TableHead className="w-[100px]">Duration</TableHead>
              <TableHead className="w-[80px]">Spans</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {traces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  No traces found for this endpoint
                </TableCell>
              </TableRow>
            ) : (
              traces.map((trace) => (
                <TableRow
                  key={trace.traceId}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/traces/$traceId",
                      params: { traceId: trace.traceId },
                    })
                  }
                >
                  <TableCell>
                    <Link
                      to="/traces/$traceId"
                      params={{ traceId: trace.traceId }}
                      className="font-mono text-xs text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncateId(trace.traceId)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(trace.startTime)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {formatDuration(trace.durationMs)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {trace.spanCount}
                  </TableCell>
                  <TableCell>
                    <StatusBadge hasError={trace.hasError} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {traces.length > 0 && (
        <div className="text-sm">
          <Link
            to="/traces"
            search={{
              services: [service],
              httpMethods: [method],
              attributeKey: "http.route",
              attributeValue: endpoint,
              startTime,
              endTime,
            }}
            className="text-primary hover:underline"
          >
            View all traces for this endpoint →
          </Link>
        </div>
      )}
    </div>
  )
}
