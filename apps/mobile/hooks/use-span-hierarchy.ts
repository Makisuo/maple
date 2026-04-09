import { useCallback, useEffect, useRef, useState } from "react"
import { fetchSpanHierarchy, type Span, type SpanNode } from "../lib/api"
import { buildSpanTree, transformSpan } from "../lib/span-tree"

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

export function useSpanHierarchy(traceId: string) {
	const [state, setState] = useState<SpanHierarchyState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)

	const load = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState({ status: "loading" })

		try {
			const rawRows = await fetchSpanHierarchy(traceId)

			if (controller.signal.aborted) return

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

			setState({
				status: "success",
				data: { spans, rootSpans, totalDurationMs, traceStartTime, services },
			})
		} catch (err) {
			if (controller.signal.aborted) return
			setState({
				status: "error",
				error: err instanceof Error ? err.message : "Unknown error",
			})
		}
	}, [traceId])

	useEffect(() => {
		load()
		return () => abortRef.current?.abort()
	}, [load])

	return { state, refresh: load }
}
