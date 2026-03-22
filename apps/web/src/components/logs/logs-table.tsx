import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Log } from "@/api/tinybird/logs"
import { LogDetailSheet } from "./log-detail-sheet"
import type { LogsSearchParams } from "@/routes/logs"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatCompactTimeInTimezone } from "@/lib/timezone-format"
import { getSeverityColor } from "@/lib/severity"
import { useInfiniteLogs, FETCH_THRESHOLD } from "@/hooks/use-infinite-logs"

const ROW_HEIGHT = 28

interface LogsTableProps {
  filters?: LogsSearchParams
}

function LoadingState() {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="rounded-md border overflow-hidden flex-1 min-h-0">
        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            className="border-l-2 border-l-transparent flex items-center gap-2 px-3 py-1 border-b border-border"
          >
            <Skeleton className="h-3 w-[72px] shrink-0" />
            <Skeleton className="h-3 w-16 shrink-0" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}

function LogsTableContent({
  allData,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  waiting,
}: {
  allData: Log[]
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  waiting: boolean
}) {
  const [selectedLog, setSelectedLog] = React.useState<Log | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const { effectiveTimezone } = useTimezonePreference()
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)

  const handleRowClick = React.useCallback((log: Log) => {
    setSelectedLog(log)
    setSheetOpen(true)
  }, [])

  const virtualizer = useVirtualizer({
    count: allData.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const virtualItems = virtualizer.getVirtualItems()

  React.useEffect(() => {
    const lastItem = virtualItems[virtualItems.length - 1]
    if (!lastItem) return

    if (lastItem.index >= allData.length - FETCH_THRESHOLD && hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [virtualItems, allData.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  if (allData.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <div className="rounded-md border flex items-center justify-center h-48">
          <span className="text-sm text-muted-foreground">No logs found</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={`flex-1 min-h-0 flex flex-col transition-opacity ${waiting ? "opacity-60" : ""}`}>
        <div className="flex-1 min-h-0 relative">
          <div
            ref={scrollContainerRef}
            className="absolute inset-0 overflow-auto rounded-md border"
          >
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              role="log"
            >
              {virtualItems.map((virtualRow) => {
                const log = allData[virtualRow.index]
                return (
                  <div
                    key={virtualRow.index}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                      borderLeftColor: getSeverityColor(log.severityText),
                    }}
                    className="border-l-2 flex items-center gap-2 px-3 py-1 text-xs font-mono cursor-pointer border-b border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                    tabIndex={0}
                    role="listitem"
                    onClick={() => handleRowClick(log)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        handleRowClick(log)
                      }
                    }}
                  >
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatCompactTimeInTimezone(log.timestamp, {
                        timeZone: effectiveTimezone,
                      })}
                    </span>
                    <span className="shrink-0 text-muted-foreground/60 truncate max-w-[120px] hidden md:inline">
                      {log.serviceName}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {log.body}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-md bg-gradient-to-t from-background to-transparent" />
        </div>

        <div className="text-sm text-muted-foreground shrink-0 mt-1.5">
          Showing {allData.length} logs
          {!hasNextPage && allData.length > 0 && " (all loaded)"}
        </div>
      </div>

      <LogDetailSheet
        log={selectedLog}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </>
  )
}

export function LogsTable({ filters }: LogsTableProps) {
  const { firstPageResult, allData, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useInfiniteLogs(filters)

  return Result.builder(firstPageResult)
    .onInitial(() => <LoadingState />)
    .onError((error) => (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-8">
        <p className="font-medium text-destructive">Failed to load logs</p>
        <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">{error.message}</pre>
      </div>
    ))
    .onSuccess((_response, result) => (
      <LogsTableContent
        allData={allData}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        fetchNextPage={fetchNextPage}
        waiting={result.waiting ?? false}
      />
    ))
    .render()
}
