import { Effect, Schema } from "effect"
import { getTinybird } from "@/lib/tinybird"
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

export const getServiceUsage = Effect.fn("Tinybird.getServiceUsage")(
  function* ({
    data,
  }: {
    data: GetServiceUsageInput
  }) {
    const input = yield* decodeInput(GetServiceUsageInput, data ?? {}, "getServiceUsage")

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("get_service_usage", () =>
      tinybird.query.get_service_usage({
        service: input.service,
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    if (!result.data || result.data.length === 0) {
      return { data: [] }
    }

    return {
      data: result.data.map((row) => ({
        serviceName: row.serviceName,
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
