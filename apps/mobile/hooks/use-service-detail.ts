import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchServiceDetailTimeSeries,
  fetchServiceApdex,
  type ServiceDetailPoint,
  type ApdexPoint,
} from "../lib/api"
import { computeBucketSeconds, getTimeRange, type TimeRangeKey } from "../lib/time-utils"

export interface ServiceDetailData {
  timeseries: ServiceDetailPoint[]
  apdex: ApdexPoint[]
}

type ServiceDetailState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "success"; data: ServiceDetailData }

export function useServiceDetail(serviceName: string, timeKey: TimeRangeKey = "24h") {
  const [state, setState] = useState<ServiceDetailState>({ status: "loading" })
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({ status: "loading" })

    try {
      const { startTime, endTime } = getTimeRange(timeKey)
      const bucketSeconds = computeBucketSeconds(startTime, endTime)

      const [timeseries, apdex] = await Promise.all([
        fetchServiceDetailTimeSeries(serviceName, startTime, endTime, bucketSeconds),
        fetchServiceApdex(serviceName, startTime, endTime, bucketSeconds),
      ])

      if (controller.signal.aborted) return

      setState({ status: "success", data: { timeseries, apdex } })
    } catch (err) {
      if (controller.signal.aborted) return
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }, [serviceName, timeKey])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [load])

  return { state, refresh: load }
}
