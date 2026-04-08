import { useCallback, useEffect, useRef, useState } from "react"
import { fetchTraces, type Trace } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"

type TracesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: Trace[] }

export function useTraces(timeKey: TimeRangeKey = "24h") {
	const [state, setState] = useState<TracesState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)

	const load = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState({ status: "loading" })

		try {
			const { startTime, endTime } = getTimeRange(timeKey)
			const traces = await fetchTraces(startTime, endTime, { limit: 50 })

			if (controller.signal.aborted) return

			setState({ status: "success", data: traces })
		} catch (err) {
			if (controller.signal.aborted) return
			setState({
				status: "error",
				error: err instanceof Error ? err.message : "Unknown error",
			})
		}
	}, [timeKey])

	useEffect(() => {
		load()
		return () => abortRef.current?.abort()
	}, [load])

	return { state, refresh: load }
}
