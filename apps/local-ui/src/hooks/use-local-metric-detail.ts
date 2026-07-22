import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import { bucketSecondsForRange, type MetricEntry } from "./use-local-metrics"

/** Catalog row(s) for one metric, aggregated across services. */
export function useLocalMetricEntry(metricName: string, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "metrics", "entry", metricName, range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<MetricEntry | null> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(CH.listMetricsQuery({ search: metricName, limit: 50 }), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			const rows = (await executeLocalCompiledQuery(compiled)).filter(
				(r) => r.metricName === metricName,
			)
			if (rows.length === 0) return null
			const first = rows[0]!
			return {
				metricName,
				metricType: first.metricType,
				metricUnit: first.metricUnit,
				metricDescription: first.metricDescription,
				serviceNames: [...new Set(rows.map((r) => r.serviceName))],
				dataPointCount: rows.reduce((sum, r) => sum + Number(r.dataPointCount), 0),
				lastSeen: rows.reduce((max, r) => (r.lastSeen > max ? r.lastSeen : max), first.lastSeen),
				isMonotonic: Number(first.isMonotonic) === 1,
			}
		},
	})
}

export interface MetricSeriesPoint {
	bucket: string
	groupName: string
	value: number
}

/**
 * Detail timeseries, one series per service. Monotonic counters plot the true
 * per-second rate (window-CTE query); gauges/histograms plot the average value.
 */
export function useLocalMetricTimeseries(entry: MetricEntry | null | undefined, range: string | undefined) {
	const metricName = entry?.metricName
	const isRate = entry?.metricType === "sum" && entry.isMonotonic
	return useQuery({
		queryKey: ["local", "metrics", "timeseries", metricName, entry?.metricType, isRate, range],
		enabled: entry != null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricSeriesPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const bucketSeconds = bucketSecondsForRange(range)
			const params = { orgId: LOCAL_ORG_ID, startTime, endTime, bucketSeconds, metricName: metricName! }
			if (isRate) {
				const rows = await executeLocalCompiledQuery(
					CH.compile(
						CH.metricsTimeseriesRateQuery({ metricName: metricName!, bucketSeconds }),
						params,
					),
				)
				return rows.map((r) => ({
					bucket: r.bucket,
					groupName: r.groupName,
					value: Number(r.rateValue),
				}))
			}
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.metricsTimeseriesQuery({
						metricType: entry!.metricType as CH.MetricsTimeseriesOpts["metricType"],
					}),
					params,
				),
			)
			return rows.map((r) => ({
				bucket: r.bucket,
				groupName: r.groupName,
				value: Number(r.avgValue),
			}))
		},
	})
}

export interface MetricBreakdownRow {
	name: string
	avgValue: number
	sumValue: number
	count: number
}

/** Per-service breakdown for the detail page's table. */
export function useLocalMetricBreakdown(entry: MetricEntry | null | undefined, range: string | undefined) {
	const metricName = entry?.metricName
	return useQuery({
		queryKey: ["local", "metrics", "breakdown", metricName, entry?.metricType, range],
		enabled: entry != null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricBreakdownRow>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.metricsBreakdownQuery({
						metricType: entry!.metricType as CH.MetricsBreakdownOpts["metricType"],
						limit: 20,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime, metricName: metricName! },
				),
			)
			return rows.map((r) => ({
				name: r.name,
				avgValue: Number(r.avgValue),
				sumValue: Number(r.sumValue),
				count: Number(r.count),
			}))
		},
	})
}
