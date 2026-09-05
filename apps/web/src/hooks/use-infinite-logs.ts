import * as React from "react"
import { Result } from "@/lib/effect-atom"

import { listLogs, type Log, type LogsResponse } from "@/api/warehouse/logs"
import { listLogsResultAtom, type QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useTableRefreshTimeRange } from "@/hooks/use-table-refresh-time-range"
import { mapleRuntime } from "@/lib/registry"
import { logClientError } from "@/lib/services/common/telemetry"
import type { LogsSearchParams } from "@/routes/logs"

const PAGE_SIZE = 100
const FETCH_THRESHOLD = 20
export const MAX_RETAINED_LOGS = 2_000

export interface UseInfiniteLogsReturn {
	firstPageResult: Result.Result<LogsResponse, QueryAtomFailure>
	allData: Log[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	isCapped: boolean
	fetchNextPage: () => void
}

const initialPagination = (filterKey: string, firstPage: LogsResponse | undefined) => ({
	filterKey,
	firstPage,
	generation: Symbol(),
	additionalPages: [] as LogsResponse[],
	isFetchingNextPage: false,
	stopped: false,
})

function buildQueryParams(
	filters: LogsSearchParams | undefined,
	range: { startTime: string; endTime: string },
	globalNamespace: string | null,
) {
	// The org-global pin overrides URL namespace filters (they stay in the URL
	// untouched; unpinning restores them). Applied here so the atom page and the
	// direct pagination fetches below stay byte-for-byte identical.
	const pinned = globalNamespace !== null
	return {
		startTime: range.startTime,
		endTime: range.endTime,
		// Every ticked value, not just the first. The sidebar has rendered multi-select checkboxes
		// since it shipped; `services?.[0]` quietly threw the rest away.
		services: filters?.services,
		severities: filters?.severities,
		deploymentEnvs: filters?.deploymentEnvs,
		deploymentEnvMatchMode: filters?.deploymentEnvMatchMode,
		namespaces: pinned ? [globalNamespace] : filters?.namespaces,
		namespaceMatchMode: pinned ? undefined : filters?.namespaceMatchMode,
		excludedServices: filters?.excludedServices,
		excludedSeverities: filters?.excludedSeverities,
		excludedDeploymentEnvs: filters?.excludedDeploymentEnvs,
		excludedNamespaces: pinned ? undefined : filters?.excludedNamespaces,
		search: filters?.search,
		traceId: filters?.traceId,
	}
}

export function useInfiniteLogs(filters: LogsSearchParams | undefined): UseInfiniteLogsReturn {
	const { startTime, endTime } = useTableRefreshTimeRange({
		startTime: filters?.startTime,
		endTime: filters?.endTime,
		timePreset: filters?.timePreset,
		defaultRange: "12h",
	})

	const globalNamespace = useGlobalNamespace()

	const queryParams = React.useMemo(
		() => buildQueryParams(filters, { startTime, endTime }, globalNamespace),
		[filters, startTime, endTime, globalNamespace],
	)

	const filterKey = React.useMemo(() => JSON.stringify(queryParams), [queryParams])

	const firstPageResult = useRefreshableAtomValue(listLogsResultAtom({ data: queryParams }))

	const firstPage = Result.isSuccess(firstPageResult) ? firstPageResult.value : undefined
	const [pagination, setPagination] = React.useState(() => initialPagination(filterKey, firstPage))
	const inFlightGeneration = React.useRef<symbol | null>(null)

	// A new filter or refreshed first page owns a fresh set of later pages. Reset
	// during rendering so no committed render can paginate with an old cursor.
	if (pagination.filterKey !== filterKey || pagination.firstPage !== firstPage) {
		setPagination(initialPagination(filterKey, firstPage))
	}
	const { additionalPages, isFetchingNextPage, generation } = pagination

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
		return [...firstPageData, ...additionalData].slice(0, MAX_RETAINED_LOGS)
	}, [firstPageResult, additionalPages])

	const isCapped = allData.length >= MAX_RETAINED_LOGS
	const hasNextPage = !isCapped && !pagination.stopped && lastCursor !== null

	const fetchNextPage = React.useCallback(() => {
		if (
			inFlightGeneration.current === generation ||
			firstPageResult.waiting ||
			!hasNextPage ||
			!lastCursor
		)
			return
		inFlightGeneration.current = generation
		setPagination((current) => ({ ...current, isFetchingNextPage: true }))

		mapleRuntime
			.runPromise(listLogs({ data: { ...queryParams, cursor: lastCursor, limit: PAGE_SIZE } }))
			.then((result) => {
				setPagination((current) =>
					current.generation === generation
						? { ...current, additionalPages: [...current.additionalPages, result] }
						: current,
				)
			})
			.catch((error) => {
				if (inFlightGeneration.current !== generation) return
				// Stop the scroll sentinel retrying a failing cursor indefinitely.
				// Refreshing the first page or changing filters permits another try.
				setPagination((current) =>
					current.generation === generation ? { ...current, stopped: true } : current,
				)
				logClientError("logs.pagination_failed", error)
			})
			.finally(() => {
				if (inFlightGeneration.current !== generation) return
				inFlightGeneration.current = null
				setPagination((current) =>
					current.generation === generation ? { ...current, isFetchingNextPage: false } : current,
				)
			})
	}, [queryParams, lastCursor, hasNextPage, generation, firstPageResult.waiting])

	return {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		fetchNextPage,
	}
}

export { FETCH_THRESHOLD }
