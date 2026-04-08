import { useCallback, useEffect, useRef, useState } from "react"
import { fetchServiceOverview, fetchServiceSparklines, type ServiceOverview } from "../lib/api"
import { computeBucketSeconds, getTimeRange, type TimeRangeKey } from "../lib/time-utils"

export interface ServicesData {
	services: ServiceOverview[]
	sparklines: Record<string, number[]>
}

type ServicesState =
	| { status: "loading" }
	| { status: "error"; error: string }
	| { status: "success"; data: ServicesData }

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
			const bucketSeconds = computeBucketSeconds(startTime, endTime)

			const [services, sparklines] = await Promise.all([
				fetchServiceOverview(startTime, endTime),
				fetchServiceSparklines(startTime, endTime, bucketSeconds),
			])

			if (controller.signal.aborted) return

			setState({ status: "success", data: { services, sparklines } })
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
