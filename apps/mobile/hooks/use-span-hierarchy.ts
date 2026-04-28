import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { fetchSpanHierarchy, type Span, type SpanNode } from "../lib/api"
import { buildSpanTree, transformSpan } from "../lib/span-tree"
import {
	getQueryErrorMessage,
	mobileQueryKeys,
	mobileQueryStaleTimes,
	preservePreviousData,
} from "../lib/query"

interface SpanHierarchyData {
	spans: Span[]
	rootSpans: SpanNode[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
}

type SpanHierarchyState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: SpanHierarchyData }

async function fetchSpanHierarchyData(traceId: string): Promise<SpanHierarchyData> {
	const rawRows = await fetchSpanHierarchy(traceId)
	const spans = rawRows.map(transformSpan)
	const rootSpans = buildSpanTree(spans)
	const totalDurationMs = spans.length > 0 ? Math.max(...spans.map((s) => s.durationMs)) : 0
	const traceStartTime =
		spans.length > 0
			? spans.reduce((earliest, s) =>
					new Date(s.startTime).getTime() < new Date(earliest.startTime).getTime() ? s : earliest,
				).startTime
			: ""
	const services = [...new Set(spans.map((s) => s.serviceName))]

	return { spans, rootSpans, totalDurationMs, traceStartTime, services }
}

export function useSpanHierarchy(traceId: string) {
	const query = useQuery({
		queryKey: mobileQueryKeys.spanHierarchy(traceId),
		queryFn: () => fetchSpanHierarchyData(traceId),
		staleTime: mobileQueryStaleTimes.spanHierarchy,
		placeholderData: preservePreviousData,
		enabled: traceId.length > 0,
	})

	const refresh = useCallback(async () => {
		await query.refetch()
	}, [query])

	const state: SpanHierarchyState = query.data
		? { status: "success", data: query.data }
		: query.isError
			? { status: "error", error: getQueryErrorMessage(query.error) }
			: { status: "loading" }

	return { state, refresh }
}
