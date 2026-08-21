import * as React from "react"
import { Result } from "@/lib/effect-atom"

import { listTraces, type Trace, type TracesResponse } from "@/api/warehouse/traces"
import { listTracesResultAtom, type QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { useTableRefreshTimeRange } from "@/hooks/use-table-refresh-time-range"
import type { TracesSearchParams } from "@/routes/traces"
import { logClientError } from "@/lib/services/common/telemetry"
import { mapleRuntime } from "@/lib/registry"

const PAGE_SIZE = 100
const FETCH_THRESHOLD = 20
export const MAX_RETAINED_TRACES = 2_000

export interface UseInfiniteTracesReturn {
	firstPageResult: Result.Result<TracesResponse, QueryAtomFailure>
	allData: Trace[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	isCapped: boolean
	/** Noise traces the server dropped across every loaded page (see `hideNoise`). */
	hiddenCount: number
	fetchNextPage: () => void
}

function buildQueryParams(
	filters: TracesSearchParams | undefined,
	refreshedRange: { startTime: string; endTime: string },
) {
	return {
		services: filters?.services,
		spanNames: filters?.spanNames,
		hasError: filters?.hasError,
		minDurationMs: filters?.minDurationMs,
		maxDurationMs: filters?.maxDurationMs,
		httpMethods: filters?.httpMethods,
		httpStatusCodes: filters?.httpStatusCodes,
		deploymentEnvs: filters?.deploymentEnvs,
		namespaces: filters?.namespaces,
		attributeFilters: filters?.attributeFilters,
		resourceAttributeFilters: filters?.resourceAttributeFilters,
		startTime: refreshedRange.startTime,
		endTime: refreshedRange.endTime,
		rootOnly: filters?.rootOnly,
		serviceMatchMode: filters?.serviceMatchMode,
		spanNameMatchMode: filters?.spanNameMatchMode,
		deploymentEnvMatchMode: filters?.deploymentEnvMatchMode,
		namespaceMatchMode: filters?.namespaceMatchMode,
		excludedServices: filters?.excludedServices,
		excludedSpanNames: filters?.excludedSpanNames,
		excludedDeploymentEnvs: filters?.excludedDeploymentEnvs,
		excludedNamespaces: filters?.excludedNamespaces,
		excludedHttpMethods: filters?.excludedHttpMethods,
		excludedHttpStatusCodes: filters?.excludedHttpStatusCodes,
		hideNoise: filters?.hideNoise,
		minSpanCount: filters?.minSpanCount,
		sortBy: filters?.sortBy,
		sortDir: filters?.sortDir,
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
	const [paginationStopped, setPaginationStopped] = React.useState(false)
	const filterKeyRef = React.useRef(filterKey)
	const isFetchingRef = React.useRef(false)

	React.useEffect(() => {
		filterKeyRef.current = filterKey
		setAdditionalPages([])
		setIsFetchingNextPage(false)
		setPaginationStopped(false)
		isFetchingRef.current = false
	}, [filterKey])

	const allData = React.useMemo(() => {
		const firstPageData = Result.isSuccess(firstPageResult) ? firstPageResult.value.data : []
		const additionalData = additionalPages.flatMap((p) => p.data)
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_TRACES)
	}, [firstPageResult, additionalPages])
	const isCapped = allData.length >= MAX_RETAINED_TRACES

	const hiddenCount = React.useMemo(() => {
		const first = Result.isSuccess(firstPageResult) ? firstPageResult.value.meta.hiddenCount : 0
		return first + additionalPages.reduce((sum, page) => sum + page.meta.hiddenCount, 0)
	}, [firstPageResult, additionalPages])

	// "More pages exist" means the warehouse page came back full BEFORE the
	// server-side noise filter ran. `data.length === PAGE_SIZE` would end
	// pagination on the first page with any hidden rows.
	const hasNextPage = React.useMemo(() => {
		if (isCapped) return false
		if (paginationStopped) return false
		if (!Result.isSuccess(firstPageResult)) return false
		if (additionalPages.length === 0) {
			return firstPageResult.value.meta.scannedCount === PAGE_SIZE
		}
		const lastPage = additionalPages[additionalPages.length - 1]
		return lastPage.meta.scannedCount === PAGE_SIZE
	}, [firstPageResult, additionalPages, paginationStopped, isCapped])

	const fetchNextPage = React.useCallback(() => {
		if (isFetchingRef.current || !hasNextPage) return
		isFetchingRef.current = true
		setIsFetchingNextPage(true)

		const currentKey = filterKeyRef.current
		// Offset counts warehouse rows consumed, not rows kept: the server drops
		// noise rows after paging, so offsetting by `allData.length` would rescan
		// the filtered region and duplicate every kept row in it.
		const offset = (additionalPages.length + 1) * PAGE_SIZE

		mapleRuntime
			.runPromise(listTraces({ data: { ...queryParams, limit: PAGE_SIZE, offset } }))
			.then((result) => {
				if (filterKeyRef.current !== currentKey) return
				setAdditionalPages((prev) => [...prev, result])
			})
			.catch((error) => {
				if (filterKeyRef.current !== currentKey) return
				// Surface the failure by terminating pagination so the caller stops
				// asking for more pages. Without this, hasNextPage stays true and the
				// UI loops on a backend offset cap.
				setPaginationStopped(true)
				logClientError("trace.pagination_failed", error)
			})
			.finally(() => {
				if (filterKeyRef.current === currentKey) {
					setIsFetchingNextPage(false)
				}
				isFetchingRef.current = false
			})
	}, [queryParams, additionalPages.length, hasNextPage])

	return {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		hiddenCount,
		fetchNextPage,
	}
}

export { FETCH_THRESHOLD }
