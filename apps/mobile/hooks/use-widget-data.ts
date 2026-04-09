import { useCallback, useEffect, useRef, useState } from "react"
import {
	fetchCustomBreakdown,
	fetchCustomTimeseries,
	fetchQueryBuilderBreakdown,
	fetchQueryBuilderTimeseries,
	type CustomBreakdownItem,
	type CustomTimeseriesPoint,
	type DashboardWidget,
	type QueryBuilderQueryDraft,
	type WidgetBreakdownParams,
	type WidgetTimeRange,
	type WidgetTimeseriesParams,
} from "../lib/api"
import {
	computeBucketSeconds,
	getTimeRange,
	type TimeRangeKey,
} from "../lib/time-utils"

export type WidgetData =
	| { kind: "timeseries"; points: CustomTimeseriesPoint[] }
	| { kind: "breakdown"; items: CustomBreakdownItem[] }
	| { kind: "stat"; value: number }

export type WidgetDataState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "unsupported"; reason: string }
	| { status: "success"; data: WidgetData }

const SUPPORTED_TIMESERIES_ENDPOINTS = new Set([
	"custom_timeseries",
])
const SUPPORTED_BREAKDOWN_ENDPOINTS = new Set([
	"custom_breakdown",
])
const QUERY_BUILDER_TIMESERIES_ENDPOINTS = new Set([
	"custom_query_builder_timeseries",
])
const QUERY_BUILDER_BREAKDOWN_ENDPOINTS = new Set([
	"custom_query_builder_breakdown",
])

function resolveTimeRange(
	timeRange: WidgetTimeRange,
): { startTime: string; endTime: string } | null {
	if (timeRange.type === "absolute") {
		// API expects "YYYY-MM-DD HH:MM:SS"; the absolute strings are ISO,
		// so normalise the same way time-utils does.
		const start = new Date(timeRange.startTime)
		const end = new Date(timeRange.endTime)
		if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
		return {
			startTime: start.toISOString().replace("T", " ").slice(0, 19),
			endTime: end.toISOString().replace("T", " ").slice(0, 19),
		}
	}

	const known: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]
	if ((known as string[]).includes(timeRange.value)) {
		return getTimeRange(timeRange.value as TimeRangeKey)
	}
	// Unknown shorthand (e.g. "12h", "6h") — fall back to 24h.
	return getTimeRange("24h")
}

/** Apply the saved `transform.reduceToValue` reducer for stat widgets. */
function reduceTimeseriesToValue(
	points: CustomTimeseriesPoint[],
	field: string,
	aggregate: string | undefined,
): number {
	const values: number[] = []
	for (const p of points) {
		const v = p.series[field]
		if (typeof v === "number" && Number.isFinite(v)) values.push(v)
	}
	if (values.length === 0) return 0

	switch (aggregate) {
		case "avg":
		case "average":
			return values.reduce((a, b) => a + b, 0) / values.length
		case "min":
			return Math.min(...values)
		case "max":
			return Math.max(...values)
		case "last":
			return values[values.length - 1] ?? 0
		case "first":
			return values[0] ?? 0
		case "sum":
		default:
			return values.reduce((a, b) => a + b, 0)
	}
}

function reduceBreakdownToValue(
	items: CustomBreakdownItem[],
	aggregate: string | undefined,
): number {
	if (items.length === 0) return 0
	switch (aggregate) {
		case "avg":
		case "average":
			return items.reduce((a, b) => a + b.value, 0) / items.length
		case "min":
			return Math.min(...items.map((i) => i.value))
		case "max":
			return Math.max(...items.map((i) => i.value))
		case "first":
			return items[0]?.value ?? 0
		case "last":
			return items[items.length - 1]?.value ?? 0
		case "sum":
		default:
			return items.reduce((a, b) => a + b.value, 0)
	}
}

export function useWidgetData(
	widget: DashboardWidget,
	timeRange: WidgetTimeRange,
): WidgetDataState {
	const [state, setState] = useState<WidgetDataState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)

	const load = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState({ status: "loading" })

		const range = resolveTimeRange(timeRange)
		if (!range) {
			setState({ status: "error", error: "Invalid time range" })
			return
		}

		const endpoint = widget.dataSource.endpoint
		const params = (widget.dataSource.params ?? {}) as Record<string, unknown>
		const isStat = widget.visualization === "stat"

		try {
			if (SUPPORTED_TIMESERIES_ENDPOINTS.has(endpoint)) {
				const bucketSeconds = computeBucketSeconds(range.startTime, range.endTime)
				const points = await fetchCustomTimeseries(
					range.startTime,
					range.endTime,
					bucketSeconds,
					params as unknown as WidgetTimeseriesParams,
				)
				if (controller.signal.aborted) return

				if (isStat) {
					const reducer = widget.dataSource.transform?.reduceToValue
					const field = reducer?.field ?? "value"
					const value = reduceTimeseriesToValue(points, field, reducer?.aggregate)
					setState({ status: "success", data: { kind: "stat", value } })
				} else {
					setState({ status: "success", data: { kind: "timeseries", points } })
				}
				return
			}

			if (SUPPORTED_BREAKDOWN_ENDPOINTS.has(endpoint)) {
				const items = await fetchCustomBreakdown(
					range.startTime,
					range.endTime,
					params as unknown as WidgetBreakdownParams,
				)
				if (controller.signal.aborted) return

				if (isStat) {
					const reducer = widget.dataSource.transform?.reduceToValue
					const value = reduceBreakdownToValue(items, reducer?.aggregate)
					setState({ status: "success", data: { kind: "stat", value } })
				} else {
					setState({ status: "success", data: { kind: "breakdown", items } })
				}
				return
			}

			if (QUERY_BUILDER_TIMESERIES_ENDPOINTS.has(endpoint)) {
				const queries = Array.isArray(params.queries)
					? (params.queries as QueryBuilderQueryDraft[])
					: []

				if (queries.length === 0) {
					setState({
						status: "unsupported",
						reason: "Widget has no queries configured",
					})
					return
				}

				const points = await fetchQueryBuilderTimeseries(
					range.startTime,
					range.endTime,
					queries,
				)
				if (controller.signal.aborted) return

				if (isStat) {
					const reducer = widget.dataSource.transform?.reduceToValue
					const field = reducer?.field ?? "value"
					const value = reduceTimeseriesToValue(points, field, reducer?.aggregate)
					setState({ status: "success", data: { kind: "stat", value } })
				} else {
					setState({ status: "success", data: { kind: "timeseries", points } })
				}
				return
			}

			if (QUERY_BUILDER_BREAKDOWN_ENDPOINTS.has(endpoint)) {
				const queries = Array.isArray(params.queries)
					? (params.queries as QueryBuilderQueryDraft[])
					: []

				if (queries.length === 0) {
					setState({
						status: "unsupported",
						reason: "Widget has no queries configured",
					})
					return
				}

				const items = await fetchQueryBuilderBreakdown(
					range.startTime,
					range.endTime,
					queries,
				)
				if (controller.signal.aborted) return

				if (isStat) {
					const reducer = widget.dataSource.transform?.reduceToValue
					const value = reduceBreakdownToValue(items, reducer?.aggregate)
					setState({ status: "success", data: { kind: "stat", value } })
				} else {
					setState({ status: "success", data: { kind: "breakdown", items } })
				}
				return
			}

			setState({
				status: "unsupported",
				reason: `Endpoint "${endpoint}" not supported on mobile yet`,
			})
		} catch (err) {
			if (controller.signal.aborted) return
			setState({
				status: "error",
				error: err instanceof Error ? err.message : "Unknown error",
			})
		}
	}, [widget, timeRange])

	useEffect(() => {
		load()
		return () => abortRef.current?.abort()
	}, [load])

	return state
}
