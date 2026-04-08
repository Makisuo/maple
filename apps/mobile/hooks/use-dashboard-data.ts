import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchServiceUsage,
  fetchOverviewTimeSeries,
  type ServiceUsage,
  type TimeSeriesPoint,
} from "../lib/api"
import {
  getTimeRange,
  getPreviousTimeRange,
  computeBucketSeconds,
  type TimeRangeKey,
} from "../lib/time-utils"

interface UsageTotals {
  logs: number
  traces: number
  metrics: number
  dataSize: number
}

function sumUsage(data: ServiceUsage[]): UsageTotals {
  return data.reduce(
    (acc, s) => ({
      logs: acc.logs + s.totalLogs,
      traces: acc.traces + s.totalTraces,
      metrics: acc.metrics + s.totalMetrics,
      dataSize: acc.dataSize + s.dataSizeBytes,
    }),
    { logs: 0, traces: 0, metrics: 0, dataSize: 0 },
  )
}

export interface DashboardData {
  usage: UsageTotals
  prevUsage: UsageTotals
  usagePerService: ServiceUsage[]
  timeseries: TimeSeriesPoint[]
}

type DashboardState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "success"; data: DashboardData }

export function useDashboardData(timeKey: TimeRangeKey) {
  const [state, setState] = useState<DashboardState>({ status: "loading" })
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState({ status: "loading" })

    try {
      const { startTime, endTime } = getTimeRange(timeKey)
      const { startTime: prevStart, endTime: prevEnd } = getPreviousTimeRange(timeKey)
      const bucketSeconds = computeBucketSeconds(startTime, endTime)

      const [usage, prevUsageData, timeseries] = await Promise.all([
        fetchServiceUsage(startTime, endTime),
        fetchServiceUsage(prevStart, prevEnd),
        fetchOverviewTimeSeries(startTime, endTime, bucketSeconds),
      ])

      if (controller.signal.aborted) return

      setState({
        status: "success",
        data: {
          usage: sumUsage(usage),
          prevUsage: sumUsage(prevUsageData),
          usagePerService: usage,
          timeseries,
        },
      })
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
