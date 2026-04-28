import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchTracesFacets, type TracesFacets } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
	getQueryErrorMessage,
	mobileQueryKeys,
	mobileQueryStaleTimes,
	preservePreviousData,
} from "../lib/query"

type FacetsState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: TracesFacets }

async function fetchTracesFacetsData(timeKey: TimeRangeKey): Promise<TracesFacets> {
	const { startTime, endTime } = getTimeRange(timeKey)
	return fetchTracesFacets(startTime, endTime)
}

export function useTracesFacets(timeKey: TimeRangeKey = "24h") {
	const query = useQuery({
		queryKey: mobileQueryKeys.tracesFacets(timeKey),
		queryFn: () => fetchTracesFacetsData(timeKey),
		staleTime: mobileQueryStaleTimes.facets,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: FacetsState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return { state, refresh }
}
