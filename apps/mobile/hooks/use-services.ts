import { useCallback, useEffect, useRef, useState } from "react"
import { fetchServiceOverview, type ServiceOverview } from "../lib/api"
import { getTimeRange, type TimeRangeKey } from "../lib/time-utils"

type ServicesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: ServiceOverview[] }

export function useServices(timeKey: TimeRangeKey = "24h") {
	const [state, setState] = useState<ServicesState>({ status: "loading" })
	const abortRef = useRef<AbortController | null>(null)

	const load = useCallback(async () => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller

		setState({ status: "loading" })

		try {
			const { startTime, endTime } = getTimeRange(timeKey)
			const services = await fetchServiceOverview(startTime, endTime)

			if (controller.signal.aborted) return

			setState({ status: "success", data: services })
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
