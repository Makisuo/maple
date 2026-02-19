import { Effect, Schema } from "effect"
import {
  getTinybird,
  type ListMetricsOutput,
  type MetricTimeSeriesSumOutput,
  type MetricsSummaryOutput,
} from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  invalidTinybirdInput,
  runTinybirdQuery,
  type TinybirdApiError,
} from "@/api/tinybird/effect-utils"

const MetricTypeSchema = Schema.Literal(
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
)

const ListMetricsInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1000)),
  ),
  offset: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
  service: Schema.optional(Schema.String),
  metricType: Schema.optional(MetricTypeSchema),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  search: Schema.optional(Schema.String),
})

export type ListMetricsInput = Schema.Schema.Type<typeof ListMetricsInputSchema>

export interface Metric {
  metricName: string
  metricType: string
  serviceName: string
  metricDescription: string
  metricUnit: string
  dataPointCount: number
  firstSeen: string
  lastSeen: string
}

export interface MetricsResponse {
  data: Metric[]
}

function transformMetric(raw: ListMetricsOutput): Metric {
  return {
    metricName: raw.metricName,
    metricType: raw.metricType,
    serviceName: raw.serviceName,
    metricDescription: raw.metricDescription,
    metricUnit: raw.metricUnit,
    dataPointCount: Number(raw.dataPointCount),
    firstSeen: String(raw.firstSeen),
    lastSeen: String(raw.lastSeen),
  }
}

export function listMetrics({
  data,
}: {
  data: ListMetricsInput
}): Effect.Effect<MetricsResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(ListMetricsInputSchema, data ?? {}, "listMetrics")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("list_metrics", () =>
      tinybird.query.list_metrics({
        limit: input.limit,
        offset: input.offset,
        service: input.service,
        metric_type: input.metricType,
        start_time: input.startTime,
        end_time: input.endTime,
        search: input.search,
      }),
    )

    return {
      data: result.data.map(transformMetric),
    }
  })
}

const GetMetricTimeSeriesInputSchema = Schema.Struct({
  metricName: Schema.String,
  metricType: MetricTypeSchema,
  service: Schema.optional(Schema.String),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  bucketSeconds: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
})

export type GetMetricTimeSeriesInput = Schema.Schema.Type<typeof GetMetricTimeSeriesInputSchema>

export interface MetricTimeSeriesPoint {
  bucket: string
  serviceName: string
  avgValue: number
  minValue: number
  maxValue: number
  sumValue: number
  dataPointCount: number
}

export interface MetricTimeSeriesResponse {
  data: MetricTimeSeriesPoint[]
}

function transformTimeSeriesPoint(raw: MetricTimeSeriesSumOutput): MetricTimeSeriesPoint {
  return {
    bucket: String(raw.bucket),
    serviceName: raw.serviceName,
    avgValue: raw.avgValue,
    minValue: raw.minValue,
    maxValue: raw.maxValue,
    sumValue: raw.sumValue,
    dataPointCount: Number(raw.dataPointCount),
  }
}

export function getMetricTimeSeries({
  data,
}: {
  data: GetMetricTimeSeriesInput
}): Effect.Effect<MetricTimeSeriesResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(
      GetMetricTimeSeriesInputSchema,
      data,
      "getMetricTimeSeries",
    )

    const tinybird = getTinybird()
    const params = {
      metric_name: input.metricName,
      service: input.service,
      start_time: input.startTime,
      end_time: input.endTime,
      bucket_seconds: input.bucketSeconds,
    }

    let operation = ""
    let execute:
      | (() => Effect.Effect<{ data: MetricTimeSeriesSumOutput[] }, unknown, any>)
      | null = null

    switch (input.metricType) {
      case "sum":
        operation = "metric_time_series_sum"
        execute = () =>
          tinybird.query.metric_time_series_sum(params) as Effect.Effect<
            { data: MetricTimeSeriesSumOutput[] },
            unknown,
            any
          >
        break
      case "gauge":
        operation = "metric_time_series_gauge"
        execute = () =>
          tinybird.query.metric_time_series_gauge(params) as Effect.Effect<
            { data: MetricTimeSeriesSumOutput[] },
            unknown,
            any
          >
        break
      case "histogram":
        operation = "metric_time_series_histogram"
        execute = () =>
          tinybird.query.metric_time_series_histogram(params) as Effect.Effect<
            { data: MetricTimeSeriesSumOutput[] },
            unknown,
            any
          >
        break
      case "exponential_histogram":
        operation = "metric_time_series_exp_histogram"
        execute = () =>
          tinybird.query.metric_time_series_exp_histogram(params) as Effect.Effect<
            { data: MetricTimeSeriesSumOutput[] },
            unknown,
            any
          >
        break
      default:
        return yield* invalidTinybirdInput(
          "getMetricTimeSeries",
          `Unknown metric type: ${String(input.metricType)}`,
        )
    }

    if (!execute) {
      return yield* invalidTinybirdInput(
        "getMetricTimeSeries",
        `Unknown metric type: ${String(input.metricType)}`,
      )
    }

    const result = yield* runTinybirdQuery(operation, execute)

    return {
      data: result.data.map(transformTimeSeriesPoint),
    }
  })
}

const GetMetricsSummaryInputSchema = Schema.Struct({
  service: Schema.optional(Schema.String),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetMetricsSummaryInput = Schema.Schema.Type<typeof GetMetricsSummaryInputSchema>

export interface MetricTypeSummary {
  metricType: string
  metricCount: number
  dataPointCount: number
}

export interface MetricsSummaryResponse {
  data: MetricTypeSummary[]
}

function transformSummary(raw: MetricsSummaryOutput): MetricTypeSummary {
  return {
    metricType: raw.metricType,
    metricCount: Number(raw.metricCount),
    dataPointCount: Number(raw.dataPointCount),
  }
}

export function getMetricsSummary({
  data,
}: {
  data: GetMetricsSummaryInput
}): Effect.Effect<MetricsSummaryResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(
      GetMetricsSummaryInputSchema,
      data ?? {},
      "getMetricsSummary",
    )

    const tinybird = getTinybird()
    const result = yield* runTinybirdQuery("metrics_summary", () =>
      tinybird.query.metrics_summary({
        service: input.service,
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    return {
      data: result.data.map(transformSummary),
    }
  })
}
