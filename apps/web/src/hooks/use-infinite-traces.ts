import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { Effect } from "effect"

import { listTraces, type Trace, type TracesResponse } from "@/api/tinybird/traces"
import { listTracesResultAtom, type QueryAtomError } from "@/lib/services/atoms/tinybird-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { useTableRefreshTimeRange } from "@/hooks/use-table-refresh-time-range"
import type { TracesSearchParams } from "@/routes/traces"

const PAGE_SIZE = 100
const FETCH_THRESHOLD = 20

export interface UseInfiniteTracesReturn {
  firstPageResult: Result.Result<TracesResponse, QueryAtomError>
  allData: Trace[]
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
}

function buildQueryParams(filters: TracesSearchParams | undefined, refreshedRange: { startTime: string; endTime: string }) {
  return {
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
  }
}

export function useInfiniteTraces(filters: TracesSearchParams | undefined): UseInfiniteTracesReturn {
  const refreshedRange = useTableRefreshTimeRange({
    startTime: filters?.startTime,
    endTime: filters?.endTime,
    timePreset: filters?.timePreset,
    defaultRange: "12h",
  })

  const queryParams = React.useMemo(
    () => buildQueryParams(filters, refreshedRange),
    [filters, refreshedRange],
  )

  const filterKey = React.useMemo(() => JSON.stringify(queryParams), [queryParams])

  const firstPageResult = useRetainedRefreshableResultValue(
    listTracesResultAtom({
      data: { ...queryParams, limit: PAGE_SIZE, offset: 0 },
    }),
  )

  const [additionalPages, setAdditionalPages] = React.useState<TracesResponse[]>([])
  const [isFetchingNextPage, setIsFetchingNextPage] = React.useState(false)
  const filterKeyRef = React.useRef(filterKey)
  const isFetchingRef = React.useRef(false)

  React.useEffect(() => {
    filterKeyRef.current = filterKey
    setAdditionalPages([])
    setIsFetchingNextPage(false)
    isFetchingRef.current = false
  }, [filterKey])

  const allData = React.useMemo(() => {
    const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
    const additionalData = additionalPages.flatMap((p) => p.data)
    return [...firstPageData, ...additionalData]
  }, [firstPageResult, additionalPages])

  const hasNextPage = React.useMemo(() => {
    if (!Result.isSuccess(firstPageResult)) return false
    if (additionalPages.length === 0) {
      return firstPageResult.value.data.length === PAGE_SIZE
    }
    const lastPage = additionalPages[additionalPages.length - 1]
    return lastPage.data.length === PAGE_SIZE
  }, [firstPageResult, additionalPages])

  const fetchNextPage = React.useCallback(() => {
    if (isFetchingRef.current || !hasNextPage) return
    isFetchingRef.current = true
    setIsFetchingNextPage(true)

    const currentKey = filterKeyRef.current
    const offset = allData.length

    Effect.runPromise(
      listTraces({ data: { ...queryParams, limit: PAGE_SIZE, offset } }),
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
  }, [queryParams, allData.length, hasNextPage])

  return {
    firstPageResult,
    allData,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  }
}

export { PAGE_SIZE, FETCH_THRESHOLD }
