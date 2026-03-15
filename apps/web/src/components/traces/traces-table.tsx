import { Result } from "@effect-atom/atom-react"
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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Trace } from "@/api/tinybird/traces"
import { listTracesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import type { TracesSearchParams } from "@/routes/traces"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatRelativeTime } from "@/lib/format"
import { HttpSpanLabel } from "./http-span-label"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { useTableRefreshTimeRange } from "@/hooks/use-table-refresh-time-range"

function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
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

function HttpStatusBadge({ statusCode }: { statusCode: number }) {
  return (
    <Badge
      variant="secondary"
      className={
        statusCode >= 500
          ? "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400"
          : statusCode >= 400
            ? "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400"
            : statusCode >= 300
              ? "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400"
              : "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400"
      }
    >
      {statusCode}
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
  const { effectiveTimezone } = useTimezonePreference()
  const refreshedRange = useTableRefreshTimeRange({
    startTime: filters?.startTime,
    endTime: filters?.endTime,
    timePreset: filters?.timePreset,
    defaultRange: "12h",
  })

  const tracesResult = useRetainedRefreshableResultValue(
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
        startTime: refreshedRange.startTime,
        endTime: refreshedRange.endTime,
        rootOnly: filters?.rootOnly,
        serviceMatchMode: filters?.serviceMatchMode,
        spanNameMatchMode: filters?.spanNameMatchMode,
        deploymentEnvMatchMode: filters?.deploymentEnvMatchMode,
        attributeValueMatchMode: filters?.attributeValueMatchMode,
        resourceAttributeValueMatchMode: filters?.resourceAttributeValueMatchMode,
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
          <Table aria-label="Traces">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Trace ID</TableHead>
                <TableHead>Root Span</TableHead>
                <TableHead className="hidden md:table-cell w-[160px]">Services</TableHead>
                <TableHead className="w-[100px]">Duration</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    No traces found
                  </TableCell>
                </TableRow>
              ) : (
                response.data.map((trace: Trace) => (
                  <TableRow
                    key={trace.traceId}
                    className="cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                    tabIndex={0}
                    onClick={() => navigate({
                      to: "/traces/$traceId",
                      params: { traceId: trace.traceId },
                      search: true,
                    })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        navigate({
                          to: "/traces/$traceId",
                          params: { traceId: trace.traceId },
                          search: true,
                        })
                      }
                    }}
                  >
                    <TableCell>
                      <Link
                        to="/traces/$traceId"
                        params={{ traceId: trace.traceId }}
                        search={true}
                        className="font-mono text-xs text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {truncateId(trace.traceId)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <HttpSpanLabel
                          spanName={trace.rootSpan.name || trace.rootSpanName || "Unknown"}
                          spanAttributes={trace.rootSpan.attributes}
                          textClassName="text-xs"
                        />
                        <span className="text-[10px] text-muted-foreground">
                          {formatTimestampInTimezone(trace.startTime, {
                            timeZone: effectiveTimezone,
                          })}{" "}
                          <span className="text-muted-foreground/60">
                            ({formatRelativeTime(trace.startTime)})
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
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
                    <TableCell>
                      {trace.rootSpan.http?.statusCode != null ? (
                        <HttpStatusBadge statusCode={trace.rootSpan.http.statusCode} />
                      ) : (
                        <StatusBadge hasError={trace.hasError} />
                      )}
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
