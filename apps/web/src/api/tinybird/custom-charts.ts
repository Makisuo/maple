import { QueryEngineExecuteRequest, type MetricsMetric, type QuerySpec, type TracesMetric } from "@maple/query-engine"
import { Effect, Schema } from "effect"

import { getTinybird } from "@/lib/tinybird"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  buildBucketTimeline,
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils"
import {
  TinybirdDateTimeString,
  TinybirdApiError,
  decodeInput,
  invalidTinybirdInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"
import type {
  ServiceDetailTimeSeriesPoint,
  ServiceTimeSeriesPoint,
} from "@/api/tinybird/services"
import { parseSamplingThreshold } from "@/lib/sampling"

const dateTimeString = TinybirdDateTimeString

// SpanMetrics connector metric names — try namespaced first, then default
const SPANMETRICS_CALLS_CANDIDATES = ["span.metrics.calls", "calls"]

function querySpanMetricsCalls(
  tinybird: ReturnType<typeof getTinybird>,
  params: {
    service?: string
    start_time?: string
    end_time?: string
    bucket_seconds: number
  },
) {
  return Effect.gen(function* () {
    for (const metricName of SPANMETRICS_CALLS_CANDIDATES) {
      const result = yield* runTinybirdQuery("metric_time_series_sum", () =>
        tinybird.query.metric_time_series_sum({
          metric_name: metricName,
          service: params.service,
          start_time: params.start_time,
          end_time: params.end_time,
          bucket_seconds: params.bucket_seconds,
          attribute_key: "span.kind",
          attribute_value: "SPAN_KIND_SERVER",
        }),
      ).pipe(Effect.orElseSucceed(() => ({ data: [] as Array<Record<string, unknown>> })))

      if (result.data.length > 0) {
        return result
      }
    }
    return { data: [] as never[] }
  })
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function sortByBucket<T extends { bucket: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.bucket.localeCompare(right.bucket))
}

function fillServiceDetailPoints(
  points: ServiceDetailTimeSeriesPoint[],
  startTime: string | undefined,
  endTime: string | undefined,
  bucketSeconds: number,
): ServiceDetailTimeSeriesPoint[] {
  const timeline = buildBucketTimeline(startTime, endTime, bucketSeconds)
  if (timeline.length === 0) {
    return sortByBucket(points)
  }

  const byBucket = new Map<string, ServiceDetailTimeSeriesPoint>()
  for (const point of points) {
    byBucket.set(toIsoBucket(point.bucket), point)
  }

  return timeline.map((bucket) => {
    const existing = byBucket.get(bucket)
    if (existing) {
      return existing
    }

    return {
      bucket,
      throughput: 0,
      tracedThroughput: 0,
      hasSampling: false,
      samplingWeight: 1,
      errorRate: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
    }
  })
}

function fillServiceSparklinePoints(
  points: ServiceTimeSeriesPoint[],
  timeline: string[],
): ServiceTimeSeriesPoint[] {
  if (timeline.length === 0) {
    return sortByBucket(points)
  }

  const byBucket = new Map<string, ServiceTimeSeriesPoint>()
  for (const point of points) {
    byBucket.set(toIsoBucket(point.bucket), point)
  }

  return timeline.map((bucket) => {
    const existing = byBucket.get(bucket)
    if (existing) {
      return existing
    }

    return {
      bucket,
      throughput: 0,
      tracedThroughput: 0,
      hasSampling: false,
      errorRate: 0,
    }
  })
}

const SharedFiltersSchema = Schema.Struct({
  serviceName: Schema.optional(Schema.String),
  spanName: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  metricName: Schema.optional(Schema.String),
  metricType: Schema.optional(
    Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"]),
  ),
  rootSpansOnly: Schema.optional(Schema.Boolean),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  commitShas: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  attributeKey: Schema.optional(Schema.String),
  attributeValue: Schema.optional(Schema.String),
  attributeFilterMode: Schema.optional(Schema.Literals(["equals", "exists"])),
  resourceAttributeKey: Schema.optional(Schema.String),
  resourceAttributeValue: Schema.optional(Schema.String),
  resourceAttributeFilterMode: Schema.optional(Schema.Literals(["equals", "exists"])),
})

const CustomChartTimeSeriesInputSchema = Schema.Struct({
  source: Schema.Literals(["traces", "logs", "metrics"]),
  metric: Schema.String,
  groupBy: Schema.optional(
    Schema.Literals(["service", "span_name", "status_code", "severity", "attribute", "none"]),
  ),
  filters: Schema.optional(SharedFiltersSchema),
  startTime: dateTimeString,
  endTime: dateTimeString,
  bucketSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
})

export type CustomChartTimeSeriesInput = Schema.Schema.Type<typeof CustomChartTimeSeriesInputSchema>

export interface CustomChartTimeSeriesPoint {
  bucket: string
  series: Record<string, number>
}

export interface CustomChartTimeSeriesResponse {
  data: CustomChartTimeSeriesPoint[]
}

const tracesMetrics = new Set<TracesMetric>([
  "count",
  "avg_duration",
  "p50_duration",
  "p95_duration",
  "p99_duration",
  "error_rate",
])
const metricsMetrics = new Set<MetricsMetric>(["avg", "sum", "min", "max", "count"])
const metricsBreakdownMetrics = new Set<"avg" | "sum" | "count">(["avg", "sum", "count"])

function executeQueryEngine(payload: QueryEngineExecuteRequest) {
  return executeQueryEngineEffect(payload).pipe(
    Effect.provide(MapleApiAtomClient.layer),
    Effect.mapError(
      (cause) =>
        new TinybirdApiError({
          operation: "queryEngine.execute",
          stage: "query",
          message: toMessage(cause, "Query engine request failed"),
          cause,
        }),
    ),
  )
}

const executeQueryEngineEffect = Effect.fn("Tinybird.executeQueryEngine")(
  function* (payload: QueryEngineExecuteRequest) {
    const client = yield* MapleApiAtomClient
    return yield* client.queryEngine.execute({
      payload: new QueryEngineExecuteRequest(payload),
    })
  },
)

function buildTimeseriesQuerySpec(data: CustomChartTimeSeriesInput): QuerySpec | string {
  if (data.source === "traces") {
    if (!tracesMetrics.has(data.metric as TracesMetric)) {
      return `Unknown trace metric: ${data.metric}`
    }
    if (
      data.groupBy &&
      !["service", "span_name", "status_code", "http_method", "attribute", "none"].includes(
        data.groupBy,
      )
    ) {
      return `Unsupported traces groupBy: ${data.groupBy}`
    }

    return {
      kind: "timeseries",
      source: "traces",
      metric: data.metric as TracesMetric,
      groupBy: data.groupBy ? [data.groupBy] as any : undefined,
      filters: {
        serviceName: data.filters?.serviceName,
        spanName: data.filters?.spanName,
        rootSpansOnly: data.filters?.rootSpansOnly,
        environments: data.filters?.environments,
        commitShas: data.filters?.commitShas,
        attributeKey: data.filters?.attributeKey,
        attributeValue: data.filters?.attributeValue,
        attributeFilterMode: data.filters?.attributeFilterMode,
        resourceAttributeKey: data.filters?.resourceAttributeKey,
        resourceAttributeValue: data.filters?.resourceAttributeValue,
        resourceAttributeFilterMode: data.filters?.resourceAttributeFilterMode,
      },
      bucketSeconds: data.bucketSeconds,
    }
  }

  if (data.source === "logs") {
    if (data.metric !== "count") {
      return `Unknown logs metric: ${data.metric}`
    }
    if (data.groupBy && !["service", "severity", "none"].includes(data.groupBy)) {
      return `Unsupported logs groupBy: ${data.groupBy}`
    }

    return {
      kind: "timeseries",
      source: "logs",
      metric: "count",
      groupBy: data.groupBy ? [data.groupBy] as any : undefined,
      filters: {
        serviceName: data.filters?.serviceName,
        severity: data.filters?.severity,
      },
      bucketSeconds: data.bucketSeconds,
    }
  }

  if (!metricsMetrics.has(data.metric as MetricsMetric)) {
    return `Unknown metrics metric: ${data.metric}`
  }
  if (!data.filters?.metricName || !data.filters.metricType) {
    return "metricName and metricType are required for metrics source"
  }
  if (data.groupBy && !["service", "none"].includes(data.groupBy)) {
    return `Unsupported metrics groupBy: ${data.groupBy}`
  }

  const metricsGroupBy = data.groupBy as "service" | "none" | undefined

  return {
    kind: "timeseries",
    source: "metrics",
    metric: data.metric as MetricsMetric,
    groupBy: metricsGroupBy === "none" ? ["none"] : ["service"],
    filters: {
      metricName: data.filters.metricName,
      metricType: data.filters.metricType,
      serviceName: data.filters.serviceName,
    },
    bucketSeconds: data.bucketSeconds,
  }
}

export function getCustomChartTimeSeries({
  data,
}: {
  data: CustomChartTimeSeriesInput
}) {
  return getCustomChartTimeSeriesEffect({ data })
}

const getCustomChartTimeSeriesEffect = Effect.fn("Tinybird.getCustomChartTimeSeries")(
  function* ({
    data,
  }: {
    data: CustomChartTimeSeriesInput
  }) {
    const input = yield* decodeInput(
      CustomChartTimeSeriesInputSchema,
      data,
      "getCustomChartTimeSeries",
    )

    const query = buildTimeseriesQuerySpec(input)
    if (typeof query === "string") {
      return yield* invalidTinybirdInput("getCustomChartTimeSeries", query)
    }

    const request = yield* decodeInput(
      QueryEngineExecuteRequest,
      {
        startTime: input.startTime,
        endTime: input.endTime,
        query,
      },
      "getCustomChartTimeSeries.request",
    )

    const response = yield* executeQueryEngine(request)
    if (response.result.kind !== "timeseries") {
      return yield* invalidTinybirdInput(
        "getCustomChartTimeSeries",
        "Unexpected query result kind",
      )
    }

    return {
      data: response.result.data.map((point) => ({
        bucket: point.bucket,
        series: { ...point.series },
      })),
    }
  },
)

const CustomChartBreakdownInputSchema = Schema.Struct({
  source: Schema.Literals(["traces", "logs", "metrics"]),
  metric: Schema.String,
  groupBy: Schema.Literals([
    "service",
    "span_name",
    "status_code",
    "http_method",
    "severity",
    "attribute",
  ]),
  filters: Schema.optional(SharedFiltersSchema),
  startTime: dateTimeString,
  endTime: dateTimeString,
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
})

export type CustomChartBreakdownInput = Schema.Schema.Type<typeof CustomChartBreakdownInputSchema>

export interface CustomChartBreakdownItem {
  name: string
  value: number
}

export interface CustomChartBreakdownResponse {
  data: CustomChartBreakdownItem[]
}

function buildBreakdownQuerySpec(data: CustomChartBreakdownInput): QuerySpec | string {
  if (data.source === "traces") {
    if (!tracesMetrics.has(data.metric as TracesMetric)) {
      return `Unknown trace metric: ${data.metric}`
    }
    if (
      !["service", "span_name", "status_code", "http_method", "attribute"].includes(data.groupBy)
    ) {
      return `Unsupported traces groupBy: ${data.groupBy}`
    }

    return {
      kind: "breakdown",
      source: "traces",
      metric: data.metric as TracesMetric,
      groupBy: data.groupBy as "service" | "span_name" | "status_code" | "http_method" | "attribute",
      filters: {
        serviceName: data.filters?.serviceName,
        spanName: data.filters?.spanName,
        rootSpansOnly: data.filters?.rootSpansOnly,
        environments: data.filters?.environments,
        commitShas: data.filters?.commitShas,
        attributeKey: data.filters?.attributeKey,
        attributeValue: data.filters?.attributeValue,
        attributeFilterMode: data.filters?.attributeFilterMode,
        resourceAttributeKey: data.filters?.resourceAttributeKey,
        resourceAttributeValue: data.filters?.resourceAttributeValue,
        resourceAttributeFilterMode: data.filters?.resourceAttributeFilterMode,
      },
      limit: data.limit,
    }
  }

  if (data.source === "logs") {
    if (data.metric !== "count") {
      return `Unknown logs metric: ${data.metric}`
    }
    if (![("service" as const), ("severity" as const)].includes(data.groupBy as "service" | "severity")) {
      return `Unsupported logs groupBy: ${data.groupBy}`
    }

    return {
      kind: "breakdown",
      source: "logs",
      metric: "count",
      groupBy: data.groupBy as "service" | "severity",
      filters: {
        serviceName: data.filters?.serviceName,
        severity: data.filters?.severity,
      },
      limit: data.limit,
    }
  }

  if (!metricsBreakdownMetrics.has(data.metric as "avg" | "sum" | "count")) {
    return `Unknown metrics metric: ${data.metric}`
  }
  if (!data.filters?.metricName || !data.filters.metricType) {
    return "metricName and metricType are required for metrics source"
  }
  if (data.groupBy !== "service") {
    return `Unsupported metrics groupBy: ${data.groupBy}`
  }

  return {
    kind: "breakdown",
    source: "metrics",
    metric: data.metric as "avg" | "sum" | "count",
    groupBy: "service",
    filters: {
      metricName: data.filters.metricName,
      metricType: data.filters.metricType,
      serviceName: data.filters.serviceName,
    },
    limit: data.limit,
  }
}

export function getCustomChartBreakdown({
  data,
}: {
  data: CustomChartBreakdownInput
}) {
  return getCustomChartBreakdownEffect({ data })
}

const getCustomChartBreakdownEffect = Effect.fn("Tinybird.getCustomChartBreakdown")(
  function* ({
    data,
  }: {
    data: CustomChartBreakdownInput
  }) {
    const input = yield* decodeInput(
      CustomChartBreakdownInputSchema,
      data,
      "getCustomChartBreakdown",
    )

    const query = buildBreakdownQuerySpec(input)
    if (typeof query === "string") {
      return yield* invalidTinybirdInput("getCustomChartBreakdown", query)
    }

    const request = yield* decodeInput(
      QueryEngineExecuteRequest,
      {
        startTime: input.startTime,
        endTime: input.endTime,
        query,
      },
      "getCustomChartBreakdown.request",
    )

    const response = yield* executeQueryEngine(request)
    if (response.result.kind !== "breakdown") {
      return yield* invalidTinybirdInput(
        "getCustomChartBreakdown",
        "Unexpected query result kind",
      )
    }

    return {
      data: response.result.data.map((item) => ({
        name: item.name,
        value: item.value,
      })),
    }
  },
)

const GetCustomChartServiceDetailInputSchema = Schema.Struct({
  serviceName: Schema.String,
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
})

type GetCustomChartServiceDetailInput = Schema.Schema.Type<typeof GetCustomChartServiceDetailInputSchema>

export function getCustomChartServiceDetail({
  data,
}: {
  data: GetCustomChartServiceDetailInput
}) {
  return getCustomChartServiceDetailEffect({ data })
}

const getCustomChartServiceDetailEffect = Effect.fn("Tinybird.getCustomChartServiceDetail")(
  function* ({
    data,
  }: {
    data: GetCustomChartServiceDetailInput
  }) {
    const input = yield* decodeInput(
      GetCustomChartServiceDetailInputSchema,
      data,
      "getCustomChartServiceDetail",
    )

    const tinybird = getTinybird()
    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

    const [tracesResult, metricsResult] = yield* Effect.all([
      runTinybirdQuery("custom_traces_timeseries", () =>
        tinybird.query.custom_traces_timeseries({
          start_time: input.startTime,
          end_time: input.endTime,
          bucket_seconds: bucketSeconds,
          service_name: input.serviceName,
          root_only: "1",
        }),
      ),
      querySpanMetricsCalls(tinybird, {
        service: input.serviceName,
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 2 })

    const metricsMap = new Map(
      metricsResult.data.map((r) => [toIsoBucket(String(r.bucket)), Number(r.sumValue)]),
    )

    const points = tracesResult.data.map((row): ServiceDetailTimeSeriesPoint => {
      const rawCount = Number(row.count)
      const bucket = toIsoBucket(row.bucket)
      const metricsThroughput = metricsMap.get(bucket)

      // Prefer SpanMetrics (exact) over TraceState extrapolation
      if (metricsThroughput != null && metricsThroughput > 0) {
        return {
          bucket,
          throughput: metricsThroughput,
          tracedThroughput: rawCount,
          hasSampling: true,
          samplingWeight: rawCount > 0 ? metricsThroughput / rawCount : 1,
          errorRate: Number(row.errorRate),
          p50LatencyMs: Number(row.p50Duration),
          p95LatencyMs: Number(row.p95Duration),
          p99LatencyMs: Number(row.p99Duration),
        }
      }

      // Fallback: TraceState-based extrapolation
      const sampledCount = Number(row.sampledSpanCount)
      const unsampledCount = Number(row.unsampledSpanCount)
      const { weight } = parseSamplingThreshold(row.dominantThreshold || "")
      const hasSampling = sampledCount > 0 && weight > 1.01
      const estimatedCount = hasSampling
        ? sampledCount * weight + unsampledCount
        : rawCount

      return {
        bucket,
        throughput: estimatedCount,
        tracedThroughput: rawCount,
        hasSampling,
        samplingWeight: weight,
        errorRate: Number(row.errorRate),
        p50LatencyMs: Number(row.p50Duration),
        p95LatencyMs: Number(row.p95Duration),
        p99LatencyMs: Number(row.p99Duration),
      }
    })

    return {
      data: fillServiceDetailPoints(points, input.startTime, input.endTime, bucketSeconds),
    }
  },
)

const GetOverviewTimeSeriesInputSchema = Schema.Struct({
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

type GetOverviewTimeSeriesInput = Schema.Schema.Type<typeof GetOverviewTimeSeriesInputSchema>

export function getOverviewTimeSeries({
  data,
}: {
  data: GetOverviewTimeSeriesInput
}) {
  return getOverviewTimeSeriesEffect({ data })
}

const getOverviewTimeSeriesEffect = Effect.fn("Tinybird.getOverviewTimeSeries")(function* ({
  data,
}: {
  data: GetOverviewTimeSeriesInput
}) {
    const input = yield* decodeInput(
      GetOverviewTimeSeriesInputSchema,
      data ?? {},
      "getOverviewTimeSeries",
    )

    const tinybird = getTinybird()
    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

    const [tracesResult, metricsResult] = yield* Effect.all([
      runTinybirdQuery("custom_traces_timeseries", () =>
        tinybird.query.custom_traces_timeseries({
          start_time: input.startTime,
          end_time: input.endTime,
          bucket_seconds: bucketSeconds,
          root_only: "1",
          environments: input.environments?.join(","),
        }),
      ),
      querySpanMetricsCalls(tinybird, {
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 2 })

    // SpanMetrics: aggregate across all services per bucket
    const metricsMap = new Map<string, number>()
    for (const r of metricsResult.data) {
      const key = toIsoBucket(String(r.bucket))
      metricsMap.set(key, (metricsMap.get(key) ?? 0) + Number(r.sumValue))
    }

    const points = tracesResult.data.map((row): ServiceDetailTimeSeriesPoint => {
      const rawCount = Number(row.count)
      const bucket = toIsoBucket(row.bucket)
      const metricsThroughput = metricsMap.get(bucket)

      if (metricsThroughput != null && metricsThroughput > 0) {
        return {
          bucket,
          throughput: metricsThroughput,
          tracedThroughput: rawCount,
          hasSampling: true,
          samplingWeight: rawCount > 0 ? metricsThroughput / rawCount : 1,
          errorRate: Number(row.errorRate),
          p50LatencyMs: Number(row.p50Duration),
          p95LatencyMs: Number(row.p95Duration),
          p99LatencyMs: Number(row.p99Duration),
        }
      }

      const sampledCount = Number(row.sampledSpanCount)
      const unsampledCount = Number(row.unsampledSpanCount)
      const { weight } = parseSamplingThreshold(row.dominantThreshold || "")
      const hasSampling = sampledCount > 0 && weight > 1.01
      const estimatedCount = hasSampling
        ? sampledCount * weight + unsampledCount
        : rawCount

      return {
        bucket,
        throughput: estimatedCount,
        tracedThroughput: rawCount,
        hasSampling,
        samplingWeight: weight,
        errorRate: Number(row.errorRate),
        p50LatencyMs: Number(row.p50Duration),
        p95LatencyMs: Number(row.p95Duration),
        p99LatencyMs: Number(row.p99Duration),
      }
    })

    return {
      data: fillServiceDetailPoints(points, input.startTime, input.endTime, bucketSeconds),
    }
})

const GetCustomChartServiceSparklinesInputSchema = Schema.Struct({
  startTime: Schema.optional(dateTimeString),
  endTime: Schema.optional(dateTimeString),
  environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  commitShas: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

type GetCustomChartServiceSparklinesInput = Schema.Schema.Type<
  typeof GetCustomChartServiceSparklinesInputSchema
>

export function getCustomChartServiceSparklines({
  data,
}: {
  data: GetCustomChartServiceSparklinesInput
}) {
  return getCustomChartServiceSparklinesEffect({ data })
}

const getCustomChartServiceSparklinesEffect = Effect.fn("Tinybird.getCustomChartServiceSparklines")(
  function* ({
    data,
  }: {
    data: GetCustomChartServiceSparklinesInput
  }) {
    const input = yield* decodeInput(
      GetCustomChartServiceSparklinesInputSchema,
      data ?? {},
      "getCustomChartServiceSparklines",
    )

    const tinybird = getTinybird()
    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

    const [tracesResult, metricsResult] = yield* Effect.all([
      runTinybirdQuery("custom_traces_timeseries", () =>
        tinybird.query.custom_traces_timeseries({
          start_time: input.startTime,
          end_time: input.endTime,
          bucket_seconds: bucketSeconds,
          root_only: "1",
          group_by_service: "1",
          environments: input.environments?.join(","),
          commit_shas: input.commitShas?.join(","),
        }),
      ),
      querySpanMetricsCalls(tinybird, {
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 2 })

    // SpanMetrics: keyed by "serviceName::bucket"
    const metricsMap = new Map<string, number>()
    for (const r of metricsResult.data) {
      const key = `${String(r.serviceName)}::${toIsoBucket(String(r.bucket))}`
      metricsMap.set(key, (metricsMap.get(key) ?? 0) + Number(r.sumValue))
    }

    const timeline = buildBucketTimeline(input.startTime, input.endTime, bucketSeconds)
    const grouped: Record<string, ServiceTimeSeriesPoint[]> = {}
    for (const row of tracesResult.data) {
      const bucket = toIsoBucket(row.bucket)
      const rawCount = Number(row.count)
      const metricsKey = `${row.groupName}::${bucket}`
      const metricsThroughput = metricsMap.get(metricsKey)

      let throughput: number
      let hasSampling: boolean

      if (metricsThroughput != null && metricsThroughput > 0) {
        throughput = metricsThroughput
        hasSampling = true
      } else {
        const sampledCount = Number(row.sampledSpanCount)
        const unsampledCount = Number(row.unsampledSpanCount)
        const { weight } = parseSamplingThreshold(row.dominantThreshold || "")
        hasSampling = sampledCount > 0 && weight > 1.01
        throughput = hasSampling
          ? sampledCount * weight + unsampledCount
          : rawCount
      }

      const point: ServiceTimeSeriesPoint = {
        bucket,
        throughput,
        tracedThroughput: rawCount,
        hasSampling,
        errorRate: Number(row.errorRate),
      }
      if (!grouped[row.groupName]) {
        grouped[row.groupName] = []
      }
      grouped[row.groupName].push(point)
    }

    const filledGrouped = Object.fromEntries(
      Object.entries(grouped).map(([service, points]) => [
        service,
        fillServiceSparklinePoints(points, timeline),
      ]),
    )

    return { data: filledGrouped }
  },
)
