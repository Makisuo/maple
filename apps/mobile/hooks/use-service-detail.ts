import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import {
	fetchServiceDetailTimeSeries,
	fetchServiceApdex,
	type ServiceDetailPoint,
	type ApdexPoint,
} from "../lib/api"
import { computeBucketSeconds, getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
	getQueryErrorMessage,
	mobileQueryKeys,
	mobileQueryStaleTimes,
	preservePreviousData,
} from "../lib/query"

export interface ServiceDetailData {
	timeseries: ServiceDetailPoint[]
	apdex: ApdexPoint[]
}

type ServiceDetailState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: ServiceDetailData }

async function fetchServiceDetailData(
	serviceName: string,
	timeKey: TimeRangeKey,
): Promise<ServiceDetailData> {
	const { startTime, endTime } = getTimeRange(timeKey)
	const bucketSeconds = computeBucketSeconds(startTime, endTime)

	const [timeseries, apdex] = await Promise.all([
		fetchServiceDetailTimeSeries(serviceName, startTime, endTime, bucketSeconds),
		fetchServiceApdex(serviceName, startTime, endTime, bucketSeconds),
	])

	return { timeseries, apdex }
}

export function useServiceDetail(serviceName: string, timeKey: TimeRangeKey = "24h") {
	const query = useQuery({
		queryKey: mobileQueryKeys.serviceDetail(serviceName, timeKey),
		queryFn: () => fetchServiceDetailData(serviceName, timeKey),
		staleTime: mobileQueryStaleTimes.serviceDetail,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: ServiceDetailState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return {
		state,
		refresh,
		isRefreshing: query.isFetching && query.isPlaceholderData,
	}
}
