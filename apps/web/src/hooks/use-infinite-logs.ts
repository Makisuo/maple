import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { Effect } from "effect"

import { listLogs, type Log, type LogsResponse } from "@/api/tinybird/logs"
import { listLogsResultAtom, type QueryAtomError } from "@/lib/services/atoms/tinybird-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { useTableRefreshTimeRange } from "@/hooks/use-table-refresh-time-range"
import type { LogsSearchParams } from "@/routes/logs"

const PAGE_SIZE = 100
const FETCH_THRESHOLD = 20

export interface UseInfiniteLogsReturn {
  firstPageResult: Result.Result<LogsResponse, QueryAtomError>
  allData: Log[]
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
}

function buildQueryParams(filters: LogsSearchParams | undefined, range: { startTime: string; endTime: string }) {
  return {
    startTime: range.startTime,
    endTime: range.endTime,
    service: filters?.services?.[0],
    severity: filters?.severities?.[0],
    deploymentEnv: filters?.deploymentEnvs?.[0],
    deploymentEnvMatchMode: filters?.deploymentEnvMatchMode,
    search: filters?.search,
  }
}

export function useInfiniteLogs(filters: LogsSearchParams | undefined): UseInfiniteLogsReturn {
  const { startTime, endTime } = useTableRefreshTimeRange({
    startTime: filters?.startTime,
    endTime: filters?.endTime,
    timePreset: filters?.timePreset,
    defaultRange: "12h",
  })

  const queryParams = React.useMemo(
    () => buildQueryParams(filters, { startTime, endTime }),
    [filters, startTime, endTime],
  )

  const filterKey = React.useMemo(() => JSON.stringify(queryParams), [queryParams])

  const firstPageResult = useRetainedRefreshableResultValue(
    listLogsResultAtom({ data: queryParams }),
  )

  const [additionalPages, setAdditionalPages] = React.useState<LogsResponse[]>([])
  const [isFetchingNextPage, setIsFetchingNextPage] = React.useState(false)
  const filterKeyRef = React.useRef(filterKey)
  const isFetchingRef = React.useRef(false)

  React.useEffect(() => {
    filterKeyRef.current = filterKey
    setAdditionalPages([])
    setIsFetchingNextPage(false)
    isFetchingRef.current = false
  }, [filterKey])

  const lastCursor = React.useMemo(() => {
    if (additionalPages.length > 0) {
      return additionalPages[additionalPages.length - 1].meta.cursor
    }
    if (Result.isSuccess(firstPageResult)) {
      return firstPageResult.value.meta.cursor
    }
    return null
  }, [firstPageResult, additionalPages])

  const allData = React.useMemo(() => {
    const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
    const additionalData = additionalPages.flatMap((p) => p.data)
    return [...firstPageData, ...additionalData]
  }, [firstPageResult, additionalPages])

  const hasNextPage = lastCursor !== null

  const fetchNextPage = React.useCallback(() => {
    if (isFetchingRef.current || !hasNextPage || !lastCursor) return
    isFetchingRef.current = true
    setIsFetchingNextPage(true)

    const currentKey = filterKeyRef.current

    Effect.runPromise(
      listLogs({ data: { ...queryParams, cursor: lastCursor, limit: PAGE_SIZE } }),
    )
      .then((result) => {
        if (filterKeyRef.current !== currentKey) return
        setAdditionalPages((prev) => [...prev, result])
      })
      .catch(() => {
        // Silently handle errors for subsequent pages
      })
      .finally(() => {
        if (filterKeyRef.current === currentKey) {
          setIsFetchingNextPage(false)
        }
        isFetchingRef.current = false
      })
  }, [queryParams, lastCursor, hasNextPage])

  return {
    firstPageResult,
    allData,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  }
}

export { PAGE_SIZE, FETCH_THRESHOLD }
