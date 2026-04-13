import { useCallback, useMemo } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { fetchTraces, type Trace, type TraceFilters } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
  getQueryErrorMessage,
  mobileQueryKeys,
  mobileQueryStaleTimes,
  preservePreviousData,
} from "../lib/query"

const PAGE_SIZE = 50

type InfiniteTracesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Trace[]; hasNextPage: boolean; isFetchingNextPage: boolean }

export function useInfiniteTraces(timeKey: TimeRangeKey = "24h", filters?: TraceFilters) {
	const query = useInfiniteQuery({
		queryKey: mobileQueryKeys.traces(timeKey, filters),
		queryFn: ({ pageParam }) => {
			const { startTime, endTime } = getTimeRange(timeKey)
			return fetchTraces(startTime, endTime, {
				limit: PAGE_SIZE,
				offset: pageParam,
				filters,
			}).then((data) => ({
				data,
				nextOffset: data.length === PAGE_SIZE ? pageParam + data.length : undefined,
			}))
		},
		initialPageParam: 0,
		getNextPageParam: (lastPage) => lastPage.nextOffset,
		staleTime: mobileQueryStaleTimes.traces,
		placeholderData: preservePreviousData,
	})

	const data = useMemo(
		() => query.data?.pages.flatMap((page) => page.data) ?? [],
		[query.data],
	)

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: InfiniteTracesState = data.length > 0 || query.data
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
