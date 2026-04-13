import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchServiceOverview, fetchServiceSparklines, type ServiceOverview } from "../lib/api"
import { computeBucketSeconds, getTimeRange, type TimeRangeKey } from "../lib/time-utils"
import {
  getQueryErrorMessage,
  mobileQueryKeys,
  mobileQueryStaleTimes,
  preservePreviousData,
} from "../lib/query"

export interface ServicesData {
	services: ServiceOverview[]
	sparklines: Record<string, number[]>
}

type ServicesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: ServicesData }

async function fetchServicesData(timeKey: TimeRangeKey): Promise<ServicesData> {
	const { startTime, endTime } = getTimeRange(timeKey)
	const bucketSeconds = computeBucketSeconds(startTime, endTime)

	const [services, sparklines] = await Promise.all([
		fetchServiceOverview(startTime, endTime),
		fetchServiceSparklines(startTime, endTime, bucketSeconds),
	])

	return { services, sparklines }
}

export function useServices(timeKey: TimeRangeKey = "24h") {
	const query = useQuery({
		queryKey: mobileQueryKeys.services(timeKey),
		queryFn: () => fetchServicesData(timeKey),
		staleTime: mobileQueryStaleTimes.services,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: ServicesState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return { state, refresh }
}
