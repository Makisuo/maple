import { useCallback, useEffect, useRef, useState } from "react"
import { fetchLogs, type Log, type LogsFilters } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"

const PAGE_SIZE = 50

type InfiniteLogsState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Log[]; hasNextPage: boolean; isFetchingNextPage: boolean }

export function useInfiniteLogs(timeKey: TimeRangeKey = "24h", filters?: LogsFilters) {
	const [state, setState] = useState<InfiniteLogsState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)
	const isFetchingRef = useRef(false)
	const cursorRef = useRef<string | null>(null)
	const filterKey = JSON.stringify(filters ?? {})
	const filterKeyRef = useRef(filterKey)

	const loadFirstPage = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller
		isFetchingRef.current = true
		cursorRef.current = null

		setState({ status: "loading" })

		try {
			const { startTime, endTime } = getTimeRange(timeKey)
			const page = await fetchLogs(startTime, endTime, { limit: PAGE_SIZE, filters })

			if (controller.signal.aborted) return

			cursorRef.current = page.cursor
			setState({
				status: "success",
				data: page.data,
				hasNextPage: page.cursor !== null,
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

		const cursor = cursorRef.current
		if (!cursor) return

		isFetchingRef.current = true
		const currentData = state.data

		setState((prev) => {
			if (prev.status !== "success") return prev
			return { ...prev, isFetchingNextPage: true }
		})

		const { startTime, endTime } = getTimeRange(timeKey)
		fetchLogs(startTime, endTime, { limit: PAGE_SIZE, cursor, filters })
			.then((page) => {
				if (abortRef.current?.signal.aborted) return
				cursorRef.current = page.cursor
				setState({
					status: "success",
					data: [...currentData, ...page.data],
					hasNextPage: page.cursor !== null,
					isFetchingNextPage: false,
				})
			})
			.catch(() => {
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
