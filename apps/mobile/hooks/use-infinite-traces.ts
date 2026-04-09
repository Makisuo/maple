import { useCallback, useEffect, useRef, useState } from "react"
import { fetchTraces, type Trace, type TraceFilters } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"

const PAGE_SIZE = 50

type InfiniteTracesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Trace[]; hasNextPage: boolean; isFetchingNextPage: boolean }

export function useInfiniteTraces(timeKey: TimeRangeKey = "24h", filters?: TraceFilters) {
	const [state, setState] = useState<InfiniteTracesState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)
	const isFetchingRef = useRef(false)
	const filterKey = JSON.stringify(filters ?? {})
	const filterKeyRef = useRef(filterKey)

	const loadFirstPage = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller
		isFetchingRef.current = true

		setState({ status: "loading" })

		try {
			const { startTime, endTime } = getTimeRange(timeKey)
			const traces = await fetchTraces(startTime, endTime, { limit: PAGE_SIZE, offset: 0, filters })

			if (controller.signal.aborted) return

			setState({
				status: "success",
				data: traces,
				hasNextPage: traces.length === PAGE_SIZE,
				isFetchingNextPage: false,
			})
		} catch (err) {
			if (controller.signal.aborted) return
			setState({
				status: "error",
				error: err instanceof Error ? err.message : "Unknown error",
			})
		} finally {
			isFetchingRef.current = false
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [timeKey, filterKey])

	// Reset when filters change
	useEffect(() => {
		if (filterKeyRef.current !== filterKey) {
			filterKeyRef.current = filterKey
		}
		loadFirstPage()
		return () => abortRef.current?.abort()
	}, [loadFirstPage, filterKey])

	const fetchNextPage = useCallback(() => {
		if (isFetchingRef.current) return
		if (state.status !== "success" || !state.hasNextPage) return

		isFetchingRef.current = true
		const currentData = state.data

		setState((prev) => {
			if (prev.status !== "success") return prev
			return { ...prev, isFetchingNextPage: true }
		})

		const { startTime, endTime } = getTimeRange(timeKey)
		fetchTraces(startTime, endTime, { limit: PAGE_SIZE, offset: currentData.length, filters })
			.then((newTraces) => {
				if (abortRef.current?.signal.aborted) return
				setState({
					status: "success",
					data: [...currentData, ...newTraces],
					hasNextPage: newTraces.length === PAGE_SIZE,
					isFetchingNextPage: false,
				})
			})
			.catch((err) => {
				if (abortRef.current?.signal.aborted) return
				setState((prev) => {
					if (prev.status !== "success") return prev
					return { ...prev, isFetchingNextPage: false }
				})
			})
			.finally(() => {
				isFetchingRef.current = false
			})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state, timeKey, filterKey])

	return { state, fetchNextPage, refresh: loadFirstPage }
}
