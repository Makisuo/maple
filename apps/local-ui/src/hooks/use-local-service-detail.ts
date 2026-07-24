import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import { bucketSecondsForRange } from "./use-local-metrics"

export interface ServiceOverviewStats {
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	environments: string[]
	namespaces: string[]
}

/** Golden-signal header stats for one service (entry-point spans only). */
export function useLocalServiceOverview(serviceName: string, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "services", "overview", serviceName, range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ServiceOverviewStats | null> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.serviceOverviewQuery({ serviceName }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			if (rows.length === 0) return null
			let spanCount = 0
			let errorCount = 0
			// The overview groups by (namespace, env, commit); merge the slices and
			// approximate latency percentiles with a span-weighted average.
			let p50 = 0
			let p95 = 0
			let p99 = 0
			const environments = new Set<string>()
			const namespaces = new Set<string>()
			for (const row of rows) {
				const slice = Number(row.estimatedSpanCount) || Number(row.spanCount)
				spanCount += slice
				errorCount += Number(row.estimatedErrorCount) || Number(row.errorCount)
				p50 += Number(row.p50LatencyMs) * slice
				p95 += Number(row.p95LatencyMs) * slice
				p99 += Number(row.p99LatencyMs) * slice
				if (row.environment) environments.add(row.environment)
				if (row.serviceNamespace) namespaces.add(row.serviceNamespace)
			}
			return {
				spanCount,
				errorCount,
				errorRate: spanCount > 0 ? errorCount / spanCount : 0,
				p50LatencyMs: spanCount > 0 ? p50 / spanCount : 0,
				p95LatencyMs: spanCount > 0 ? p95 / spanCount : 0,
				p99LatencyMs: spanCount > 0 ? p99 / spanCount : 0,
				environments: [...environments].sort(),
				namespaces: [...namespaces].sort(),
			}
		},
	})
}

export type ServiceOperationRow = CH.ServiceOperationsSummaryOutput

/** Top operations table for the service detail page. */
export function useLocalServiceOperations(serviceName: string, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "services", "operations", serviceName, range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<ServiceOperationRow>> => {
			const { startTime, endTime } = boundsForRange(range)
			return executeLocalCompiledQuery(
				CH.compile(CH.serviceOperationsSummaryQuery({ serviceName, limit: 25 }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

export interface OperationSeriesPoint {
	bucket: string
	spanName: string
	count: number
}

/** Per-bucket throughput for the top operations (drives the detail chart). */
export function useLocalServiceOperationsTimeseries(
	serviceName: string,
	spanNames: ReadonlyArray<string>,
	range: string | undefined,
) {
	return useQuery({
		queryKey: ["local", "services", "operations-ts", serviceName, spanNames, range],
		enabled: spanNames.length > 0,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<OperationSeriesPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.serviceOperationsTimeseriesQuery({ serviceName, spanNames }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
					bucketSeconds: bucketSecondsForRange(range),
				}),
			)
			return rows.map((r) => ({ bucket: r.bucket, spanName: r.spanName, count: Number(r.count) }))
		},
	})
}
