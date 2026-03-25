import { useMemo } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { getCustomChartTimeSeriesResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { computeBucketSeconds } from "@/api/tinybird/timeseries-utils"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { type RuleFormState, signalToQueryParams, flattenAlertChartData } from "@/lib/alerts/form-utils"

const CHART_BUCKET_TARGET = 96
const emptyChartAtom = Atom.make(Result.initial())

export function useAlertRuleChart(form: RuleFormState) {
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "24h")

  const bucketSeconds = useMemo(
    () => computeBucketSeconds(startTime, endTime, CHART_BUCKET_TARGET),
    [startTime, endTime],
  )

  const queryParams = useMemo(() => signalToQueryParams(form), [form])

  const chartGroupBy = useMemo(
    () => form.serviceNames.length > 1 || (form.serviceNames.length === 0 && form.groupBy === "service")
      ? "service" as const : "none" as const,
    [form.serviceNames.length, form.groupBy],
  )

  const chartQueryInput = useMemo(() => {
    if (!queryParams) return null
    return {
      data: {
        source: queryParams.source as "traces" | "logs" | "metrics",
        metric: queryParams.metric,
        groupBy: chartGroupBy,
        startTime,
        endTime,
        bucketSeconds,
        filters: queryParams.filters as Record<string, string | boolean | string[] | undefined>,
      },
    }
  }, [queryParams, startTime, endTime, bucketSeconds, chartGroupBy])

  const chartResult = useAtomValue(
    chartQueryInput
      ? getCustomChartTimeSeriesResultAtom(chartQueryInput)
      : emptyChartAtom,
  )

  const chartData = useMemo(() => {
    if (!chartQueryInput) return []
    return Result.builder(chartResult)
      .onSuccess((response) => flattenAlertChartData(response.data, form.serviceNames))
      .orElse(() => [])
  }, [chartResult, chartQueryInput, form.serviceNames])

  const chartLoading = !chartQueryInput || Result.isInitial(chartResult)

  return { chartData, chartLoading }
}
