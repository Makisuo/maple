import { Effect, Schema } from "effect"
import { ServiceUsageRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

export interface ServiceUsage {
  serviceName: string
  totalLogs: number
  totalTraces: number
  totalMetrics: number
  dataSizeBytes: number
  logSizeBytes: number
  traceSizeBytes: number
  metricSizeBytes: number
}

export interface ServiceUsageResponse {
  data: ServiceUsage[]
}

const GetServiceUsageInput = Schema.Struct({
  service: Schema.optional(Schema.String),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetServiceUsageInput = Schema.Schema.Type<typeof GetServiceUsageInput>

const defaultTimeRange = () => {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
  return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

export const getServiceUsage = Effect.fn("QueryEngine.getServiceUsage")(
  function* ({
    data,
  }: {
    data: GetServiceUsageInput
  }) {
    const input = yield* decodeInput(GetServiceUsageInput, data ?? {}, "getServiceUsage")
    const fallback = defaultTimeRange()

    const result = yield* runTinybirdQuery("serviceUsage", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.serviceUsage({
          payload: new ServiceUsageRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            service: input.service,
          }),
        })
      }),
    )

    if (!result.data || result.data.length === 0) {
      return { data: [] }
    }

    return {
      data: result.data.map((row: Record<string, unknown>) => ({
        serviceName: String(row.serviceName ?? ""),
        totalLogs: Number(row.totalLogCount ?? 0),
        totalTraces: Number(row.totalTraceCount ?? 0),
        totalMetrics:
          Number(row.totalSumMetricCount ?? 0) +
          Number(row.totalGaugeMetricCount ?? 0) +
          Number(row.totalHistogramMetricCount ?? 0) +
          Number(row.totalExpHistogramMetricCount ?? 0),
        dataSizeBytes: Number(row.totalSizeBytes ?? 0),
        logSizeBytes: Number(row.totalLogSizeBytes ?? 0),
        traceSizeBytes: Number(row.totalTraceSizeBytes ?? 0),
        metricSizeBytes:
          Number(row.totalSumMetricSizeBytes ?? 0) +
          Number(row.totalGaugeMetricSizeBytes ?? 0) +
          Number(row.totalHistogramMetricSizeBytes ?? 0) +
          Number(row.totalExpHistogramMetricSizeBytes ?? 0),
      })),
    }
  },
)
