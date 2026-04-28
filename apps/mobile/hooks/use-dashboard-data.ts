import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import {
	fetchServiceUsage,
	fetchOverviewTimeSeries,
	fetchLogsTimeSeries,
	type ServiceUsage,
	type TimeSeriesPoint,
	type LogsTimeSeriesPoint,
} from "../lib/api"
import {
	getTimeRange,
	getPreviousTimeRange,
	computeBucketSeconds,
	type TimeRangeKey,
} from "../lib/time-utils"
import {
	getQueryErrorMessage,
	mobileQueryKeys,
	mobileQueryStaleTimes,
	preservePreviousData,
} from "../lib/query"

interface UsageTotals {
	logs: number
	traces: number
	metrics: number
	dataSize: number
}

function sumUsage(data: ServiceUsage[]): UsageTotals {
	return data.reduce(
		(acc, s) => ({
			logs: acc.logs + s.totalLogs,
			traces: acc.traces + s.totalTraces,
			metrics: acc.metrics + s.totalMetrics,
			dataSize: acc.dataSize + s.dataSizeBytes,
		}),
		{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
	)
}

export interface DashboardData {
	usage: UsageTotals
	prevUsage: UsageTotals
	usagePerService: ServiceUsage[]
	timeseries: TimeSeriesPoint[]
	logsTimeseries: LogsTimeSeriesPoint[]
}

type DashboardState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: DashboardData }

async function fetchDashboardData(timeKey: TimeRangeKey): Promise<DashboardData> {
	const { startTime, endTime } = getTimeRange(timeKey)
	const { startTime: prevStart, endTime: prevEnd } = getPreviousTimeRange(timeKey)
	const bucketSeconds = computeBucketSeconds(startTime, endTime)

	const [usage, prevUsageData, timeseries, logsTimeseries] = await Promise.all([
		fetchServiceUsage(startTime, endTime),
		fetchServiceUsage(prevStart, prevEnd),
		fetchOverviewTimeSeries(startTime, endTime, bucketSeconds),
		fetchLogsTimeSeries(startTime, endTime, bucketSeconds),
	])

	return {
		usage: sumUsage(usage),
		prevUsage: sumUsage(prevUsageData),
		usagePerService: usage,
		timeseries,
		logsTimeseries,
	}
}

export function useDashboardData(timeKey: TimeRangeKey) {
	const query = useQuery({
		queryKey: mobileQueryKeys.dashboardData(timeKey),
		queryFn: () => fetchDashboardData(timeKey),
		staleTime: mobileQueryStaleTimes.dashboardData,
		placeholderData: preservePreviousData,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: DashboardState = query.data
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
