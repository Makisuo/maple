import { Result, useAtomValue } from "@effect-atom/atom-react"
import { Link, useNavigate } from "@tanstack/react-router"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Trace } from "@/api/tinybird/traces"
import { listTracesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import type { TracesSearchParams } from "@/routes/traces"

function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
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

interface TracesTableProps {
  filters?: TracesSearchParams
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Trace ID</TableHead>
              <TableHead>Root Span</TableHead>
              <TableHead className="w-[160px]">Services</TableHead>
              <TableHead className="w-[100px]">Duration</TableHead>
              <TableHead className="w-[80px]">Spans</TableHead>
              <TableHead className="w-[80px]">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 10 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                <TableCell><Skeleton className="h-4 w-12" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function TracesTable({ filters }: TracesTableProps) {
  const navigate = useNavigate()
  const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
    filters?.startTime,
    filters?.endTime,
  )

  const tracesResult = useAtomValue(
    listTracesResultAtom({
      data: {
        service: filters?.services?.[0],
        spanName: filters?.spanNames?.[0],
        hasError: filters?.hasError,
        minDurationMs: filters?.minDurationMs,
        maxDurationMs: filters?.maxDurationMs,
        httpMethod: filters?.httpMethods?.[0],
        httpStatusCode: filters?.httpStatusCodes?.[0],
        deploymentEnv: filters?.deploymentEnvs?.[0],
        attributeKey: filters?.attributeKey,
        attributeValue: filters?.attributeValue,
        resourceAttributeKey: filters?.resourceAttributeKey,
        resourceAttributeValue: filters?.resourceAttributeValue,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        rootOnly: filters?.rootOnly,
      },
    }),
  )

  return Result.builder(tracesResult)
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-red-500/50 bg-red-500/10 p-8">
        <p className="font-medium text-red-600">Failed to load traces</p>
        <pre className="mt-2 text-xs text-red-500 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess((response, result) => (
      <div className={`space-y-4 transition-opacity ${result.waiting ? "opacity-50" : ""}`}>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Trace ID</TableHead>
                <TableHead>Root Span</TableHead>
                <TableHead className="w-[160px]">Services</TableHead>
                <TableHead className="w-[100px]">Duration</TableHead>
                <TableHead className="w-[80px]">Spans</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    No traces found
                  </TableCell>
                </TableRow>
              ) : (
                response.data.map((trace: Trace) => (
                  <TableRow
                    key={trace.traceId}
                    className="cursor-pointer"
                    onClick={() => navigate({ to: "/traces/$traceId", params: { traceId: trace.traceId } })}
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
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-mono text-xs">{trace.rootSpanName || "Unknown"}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatTimestamp(trace.startTime)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {trace.services.slice(0, 3).map((service: string) => (
                          <Badge
                            key={service}
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {service}
                          </Badge>
                        ))}
                        {trace.services.length > 3 && (
                          <Badge variant="outline" className="text-[10px]">
                            +{trace.services.length - 3}
                          </Badge>
                        )}
                      </div>
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

        <div className="text-sm text-muted-foreground">
          Showing {response.data.length} traces
        </div>
      </div>
    ))
    .render()
}
