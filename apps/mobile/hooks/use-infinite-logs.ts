import { useCallback, useMemo } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { fetchLogs, type Log, type LogsFilters } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
  getQueryErrorMessage,
  mobileQueryKeys,
  mobileQueryStaleTimes,
  preservePreviousData,
} from "../lib/query"

const PAGE_SIZE = 50

type InfiniteLogsState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Log[]; hasNextPage: boolean; isFetchingNextPage: boolean }

export function useInfiniteLogs(timeKey: TimeRangeKey = "24h", filters?: LogsFilters) {
	const query = useInfiniteQuery({
		queryKey: mobileQueryKeys.logs(timeKey, filters),
		queryFn: ({ pageParam }) => {
			const { startTime, endTime } = getTimeRange(timeKey)
			return fetchLogs(startTime, endTime, {
				limit: PAGE_SIZE,
				cursor: pageParam ?? undefined,
				filters,
			})
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.cursor,
		staleTime: mobileQueryStaleTimes.logs,
		placeholderData: preservePreviousData,
	})

	const data = useMemo(
		() => query.data?.pages.flatMap((page) => page.data) ?? [],
		[query.data],
	)

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: InfiniteLogsState = data.length > 0 || query.data
		? {
				status: "success",
				data,
				hasNextPage: query.hasNextPage ?? false,
				isFetchingNextPage: query.isFetchingNextPage,
			}
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return {
		state,
		fetchNextPage: () => {
			void query.fetchNextPage()
		},
		refresh,
	}
}
