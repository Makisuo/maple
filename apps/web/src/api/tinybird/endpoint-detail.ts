import { Effect, Schema } from "effect"
import { getTinybird } from "@/lib/tinybird"
import {
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"
import { fillServiceDetailPoints } from "@/api/tinybird/custom-charts"
import type { ServiceDetailTimeSeriesPoint } from "@/api/tinybird/services"

const GetEndpointDetailTimeSeriesInputSchema = Schema.Struct({
  serviceName: Schema.String,
  spanName: Schema.String,
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetEndpointDetailTimeSeriesInput = Schema.Schema.Type<
  typeof GetEndpointDetailTimeSeriesInputSchema
>

export function getEndpointDetailTimeSeries({
  data,
}: {
  data: GetEndpointDetailTimeSeriesInput
}) {
  return getEndpointDetailTimeSeriesEffect({ data })
}

const getEndpointDetailTimeSeriesEffect = Effect.fn(
  "Tinybird.getEndpointDetailTimeSeries",
)(function* ({
  data,
}: {
  data: GetEndpointDetailTimeSeriesInput
}) {
  const input = yield* decodeInput(
    GetEndpointDetailTimeSeriesInputSchema,
    data,
    "getEndpointDetailTimeSeries",
  )

  const tinybird = getTinybird()
  const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
  const result = yield* runTinybirdQuery("custom_traces_timeseries", () =>
    tinybird.query.custom_traces_timeseries({
      start_time: input.startTime,
      end_time: input.endTime,
      bucket_seconds: bucketSeconds,
      service_name: input.serviceName,
      span_name: input.spanName,
    }),
  )

  const points = result.data.map(
    (row): ServiceDetailTimeSeriesPoint => ({
      bucket: toIsoBucket(row.bucket),
      throughput: Number(row.count),
      errorRate: Number(row.errorRate),
      p50LatencyMs: Number(row.p50Duration),
      p95LatencyMs: Number(row.p95Duration),
      p99LatencyMs: Number(row.p99Duration),
    }),
  )

  return {
    data: fillServiceDetailPoints(
      points,
      input.startTime,
      input.endTime,
      bucketSeconds,
    ),
  }
})

const GetEndpointStatusCodeBreakdownInputSchema = Schema.Struct({
  serviceName: Schema.String,
  spanName: Schema.String,
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetEndpointStatusCodeBreakdownInput = Schema.Schema.Type<
  typeof GetEndpointStatusCodeBreakdownInputSchema
>

export interface StatusCodeBreakdownItem {
  statusCode: string
  count: number
}

export function getEndpointStatusCodeBreakdown({
  data,
}: {
  data: GetEndpointStatusCodeBreakdownInput
}) {
  return getEndpointStatusCodeBreakdownEffect({ data })
}

const getEndpointStatusCodeBreakdownEffect = Effect.fn(
  "Tinybird.getEndpointStatusCodeBreakdown",
)(function* ({
  data,
}: {
  data: GetEndpointStatusCodeBreakdownInput
}) {
  const input = yield* decodeInput(
    GetEndpointStatusCodeBreakdownInputSchema,
    data,
    "getEndpointStatusCodeBreakdown",
  )

  const tinybird = getTinybird()
  const result = yield* runTinybirdQuery("custom_traces_breakdown", () =>
    tinybird.query.custom_traces_breakdown({
      start_time: input.startTime,
      end_time: input.endTime,
      service_name: input.serviceName,
      span_name: input.spanName,
      group_by_attribute: "http.status_code",
    }),
  )

  return {
    data: result.data.map(
      (row): StatusCodeBreakdownItem => ({
        statusCode: String(row.name),
        count: Number(row.count),
      }),
    ),
  }
})
