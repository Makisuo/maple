import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchLogsFacets, type LogsFacets } from "../lib/api"
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
	| { status: "success"; data: LogsFacets }

async function fetchLogsFacetsData(timeKey: TimeRangeKey): Promise<LogsFacets> {
	const { startTime, endTime } = getTimeRange(timeKey)
	return fetchLogsFacets(startTime, endTime)
}

export function useLogsFacets(timeKey: TimeRangeKey = "24h") {
	const query = useQuery({
		queryKey: mobileQueryKeys.logsFacets(timeKey),
		queryFn: () => fetchLogsFacetsData(timeKey),
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
