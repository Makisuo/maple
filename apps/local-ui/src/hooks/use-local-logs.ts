import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import type { TimeBounds } from "../lib/time"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"

const PAGE_SIZE = 50

export interface LogFilters {
	/** Exact service name match. */
	service?: string
	/** Exact severity text match (e.g. `ERROR`). */
	severity?: string
	/** Substring match on the log body. */
	search?: string
}

/**
 * Infinite log stream, newest first. Keyset pagination on `Timestamp` — the
 * cursor is the last row's `timestamp`.
 */
export function useLocalLogs(filters: LogFilters, bounds: TimeBounds) {
	return useInfiniteQuery({
		queryKey: ["local", "logs", filters, bounds.startTime, bounds.endTime],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const compiled = CH.compile(
				CH.logsListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					serviceName: filters.service,
					severity: filters.severity,
					search: filters.search,
				}),
				{ orgId: LOCAL_ORG_ID, ...bounds },
			)
			return executeLocalCompiledQuery(compiled)
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.timestamp : undefined,
	})
}

/**
 * Distinct severity values in the window (with counts), for the severity facet.
 * Derived from the data so the option casing always matches what's stored.
 */
export function useLocalLogSeverities(bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "log-severities", bounds.startTime, bounds.endTime],
		staleTime: 60_000,
		queryFn: async () => {
			const compiled = CH.compile(CH.logsBreakdownQuery({ groupBy: "severity", limit: 20 }), {
				orgId: LOCAL_ORG_ID,
				...bounds,
			})
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: row.count }))
		},
	})
}
