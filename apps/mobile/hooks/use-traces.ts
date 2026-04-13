import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchTraces, type Trace, type TraceFilters } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
	getQueryErrorMessage,
	mobileQueryKeys,
	mobileQueryStaleTimes,
	preservePreviousData,
} from "../lib/query"

type TracesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Trace[] }

export function useTraces(timeKey: TimeRangeKey = "24h", filters?: TraceFilters) {
	const query = useQuery({
		queryKey: mobileQueryKeys.traces(timeKey, filters),
		queryFn: async () => {
			const { startTime, endTime } = getTimeRange(timeKey)
			return fetchTraces(startTime, endTime, { limit: 50, filters })
		},
		staleTime: mobileQueryStaleTimes.traces,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: TracesState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return { state, refresh }
}
