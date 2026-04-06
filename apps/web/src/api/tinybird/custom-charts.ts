import { QueryEngineExecuteRequest, type MetricsMetric, type QuerySpec, type TracesMetric } from "@maple/query-engine"
import { Effect, Schema } from "effect"

import {
  buildBucketTimeline,
  computeBucketSeconds,
  toIsoBucket,
} from "@/api/tinybird/timeseries-utils"
import {
  TinybirdDateTimeString,
  decodeInput,
  executeQueryEngine,
  invalidTinybirdInput,
} from "@/api/tinybird/effect-utils"
import type {
  ServiceDetailTimeSeriesPoint,
  ServiceTimeSeriesPoint,
} from "@/api/tinybird/services"
const dateTimeString = TinybirdDateTimeString

// SpanMetrics connector metric names — try namespaced first, then default
const SPANMETRICS_CALLS_CANDIDATES = ["span.metrics.calls", "calls"]

function querySpanMetricsCalls(
  params: {
    service?: string
    start_time?: string
    end_time?: string
    bucket_seconds: number
  },
) {
  return Effect.gen(function* () {
    for (const metricName of SPANMETRICS_CALLS_CANDIDATES) {
      const response = yield* executeQueryEngine(
        "queryEngine.spanMetricsCalls",
        new QueryEngineExecuteRequest({
          startTime: params.start_time ?? "2020-01-01 00:00:00",
          endTime: params.end_time ?? "2099-12-31 23:59:59",
          query: {
            kind: "timeseries",
            source: "metrics",
            metric: "sum",
            groupBy: ["service"],
            filters: {
              metricName,
              metricType: "sum",
              serviceName: params.service,
              attributeFilters: [
                { key: "span.kind", value: "SPAN_KIND_SERVER", mode: "equals" },
              ],
            },
            bucketSeconds: params.bucket_seconds,
          },
        }),
      ).pipe(Effect.orElseSucceed(() => null))

      if (response && response.result.kind === "timeseries" && response.result.data.length > 0) {
        // Transform grouped timeseries back to flat rows for compatibility
        const data: Array<Record<string, unknown>> = []
        for (const point of response.result.data) {
          for (const [serviceName, value] of Object.entries(point.series)) {
            data.push({
              bucket: point.bucket,
              serviceName,
              sumValue: value,
            })
          }
        }
        return { data }
      }
    }
    return { data: [] as never[] }
  })
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
  attributeFilters: Schema.optional(Schema.mutable(Schema.Array(Schema.Struct({
    key: Schema.String,
    value: Schema.optional(Schema.String),
    mode: Schema.Literals(["equals", "exists"]),
  })))),
  resourceAttributeFilters: Schema.optional(Schema.mutable(Schema.Array(Schema.Struct({
    key: Schema.String,
    value: Schema.optional(Schema.String),
    mode: Schema.Literals(["equals", "exists"]),
  })))),
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
  apdexThresholdMs: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
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
  "apdex",
])
const metricsMetrics = new Set<MetricsMetric>(["avg", "sum", "min", "max", "count", "rate", "increase"])
const metricsBreakdownMetrics = new Set<"avg" | "sum" | "count">(["avg", "sum", "count"])

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
      apdexThresholdMs: data.apdexThresholdMs,
      groupBy: data.groupBy ? [data.groupBy] as any : undefined,
      filters: {
        serviceName: data.filters?.serviceName,
        spanName: data.filters?.spanName,
        rootSpansOnly: data.filters?.rootSpansOnly,
        environments: data.filters?.environments,
        commitShas: data.filters?.commitShas,
        attributeFilters: data.filters?.attributeFilters,
        resourceAttributeFilters: data.filters?.resourceAttributeFilters,
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

    const response = yield* executeQueryEngine("queryEngine.customChartTimeSeries", request)
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
        attributeFilters: data.filters?.attributeFilters,
        resourceAttributeFilters: data.filters?.resourceAttributeFilters,
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

    const response = yield* executeQueryEngine("queryEngine.customChartBreakdown", request)
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

function makeTracesTimeseriesRequest(
  metric: TracesMetric,
  opts: {
    startTime?: string
    endTime?: string
    bucketSeconds: number
    serviceName?: string
    rootSpansOnly?: boolean
    environments?: string[]
    commitShas?: string[]
    groupBy?: string[]
  },
) {
  return new QueryEngineExecuteRequest({
    startTime: opts.startTime ?? "2020-01-01 00:00:00",
    endTime: opts.endTime ?? "2099-12-31 23:59:59",
    query: {
      kind: "timeseries" as const,
      source: "traces" as const,
      metric,
      groupBy: opts.groupBy as any,
      filters: {
        serviceName: opts.serviceName,
        rootSpansOnly: opts.rootSpansOnly ?? true,
        environments: opts.environments,
        commitShas: opts.commitShas,
      },
      bucketSeconds: opts.bucketSeconds,
    },
  })
}

function extractSingleSeries(
  response: { result: { kind: string; data: ReadonlyArray<{ bucket: string; series: Record<string, number> }> } },
): Map<string, number> {
  const map = new Map<string, number>()
  if (response.result.kind !== "timeseries") return map
  for (const point of (response.result as any).data) {
    // Sum across all series keys (there's typically one or "all")
    let total = 0
    for (const v of Object.values(point.series)) {
      total += Number(v)
    }
    map.set(point.bucket, total)
  }
  return map
}

const getCustomChartServiceDetailEffect = Effect.fn("QueryEngine.getCustomChartServiceDetail")(
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

    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
    const reqOpts = {
      startTime: input.startTime,
      endTime: input.endTime,
      bucketSeconds,
      serviceName: input.serviceName,
      rootSpansOnly: true,
    }

    const [countRes, errorRateRes, p50Res, p95Res, p99Res, metricsResult] = yield* Effect.all([
      executeQueryEngine("queryEngine.serviceDetail.count", makeTracesTimeseriesRequest("count", reqOpts)),
      executeQueryEngine("queryEngine.serviceDetail.errorRate", makeTracesTimeseriesRequest("error_rate", reqOpts)),
      executeQueryEngine("queryEngine.serviceDetail.p50", makeTracesTimeseriesRequest("p50_duration", reqOpts)),
      executeQueryEngine("queryEngine.serviceDetail.p95", makeTracesTimeseriesRequest("p95_duration", reqOpts)),
      executeQueryEngine("queryEngine.serviceDetail.p99", makeTracesTimeseriesRequest("p99_duration", reqOpts)),
      querySpanMetricsCalls({
        service: input.serviceName,
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 6 })

    const countMap = extractSingleSeries(countRes as any)
    const errorRateMap = extractSingleSeries(errorRateRes as any)
    const p50Map = extractSingleSeries(p50Res as any)
    const p95Map = extractSingleSeries(p95Res as any)
    const p99Map = extractSingleSeries(p99Res as any)

    const metricsMap = new Map(
      metricsResult.data.map((r) => [toIsoBucket(String(r.bucket)), Number(r.sumValue)]),
    )

    const allBuckets = new Set<string>()
    for (const k of countMap.keys()) allBuckets.add(k)
    for (const k of metricsMap.keys()) allBuckets.add(k)

    const points = [...allBuckets].sort().map((bucket): ServiceDetailTimeSeriesPoint => {
      const rawCount = countMap.get(bucket) ?? 0
      const metricsThroughput = metricsMap.get(bucket)

      if (metricsThroughput != null && metricsThroughput > 0) {
        return {
          bucket,
          throughput: metricsThroughput,
          tracedThroughput: rawCount,
          hasSampling: true,
          samplingWeight: rawCount > 0 ? metricsThroughput / rawCount : 1,
          errorRate: errorRateMap.get(bucket) ?? 0,
          p50LatencyMs: p50Map.get(bucket) ?? 0,
          p95LatencyMs: p95Map.get(bucket) ?? 0,
          p99LatencyMs: p99Map.get(bucket) ?? 0,
        }
      }

      return {
        bucket,
        throughput: rawCount,
        tracedThroughput: rawCount,
        hasSampling: false,
        samplingWeight: 1,
        errorRate: errorRateMap.get(bucket) ?? 0,
        p50LatencyMs: p50Map.get(bucket) ?? 0,
        p95LatencyMs: p95Map.get(bucket) ?? 0,
        p99LatencyMs: p99Map.get(bucket) ?? 0,
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

const getOverviewTimeSeriesEffect = Effect.fn("QueryEngine.getOverviewTimeSeries")(function* ({
  data,
}: {
  data: GetOverviewTimeSeriesInput
}) {
    const input = yield* decodeInput(
      GetOverviewTimeSeriesInputSchema,
      data ?? {},
      "getOverviewTimeSeries",
    )

    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
    const reqOpts = {
      startTime: input.startTime,
      endTime: input.endTime,
      bucketSeconds,
      rootSpansOnly: true,
      environments: input.environments,
    }

    const [countRes, errorRateRes, p50Res, p95Res, p99Res, metricsResult] = yield* Effect.all([
      executeQueryEngine("queryEngine.overview.count", makeTracesTimeseriesRequest("count", reqOpts)),
      executeQueryEngine("queryEngine.overview.errorRate", makeTracesTimeseriesRequest("error_rate", reqOpts)),
      executeQueryEngine("queryEngine.overview.p50", makeTracesTimeseriesRequest("p50_duration", reqOpts)),
      executeQueryEngine("queryEngine.overview.p95", makeTracesTimeseriesRequest("p95_duration", reqOpts)),
      executeQueryEngine("queryEngine.overview.p99", makeTracesTimeseriesRequest("p99_duration", reqOpts)),
      querySpanMetricsCalls({
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 6 })

    const countMap = extractSingleSeries(countRes as any)
    const errorRateMap = extractSingleSeries(errorRateRes as any)
    const p50Map = extractSingleSeries(p50Res as any)
    const p95Map = extractSingleSeries(p95Res as any)
    const p99Map = extractSingleSeries(p99Res as any)

    // SpanMetrics: aggregate across all services per bucket
    const metricsMap = new Map<string, number>()
    for (const r of metricsResult.data) {
      const key = toIsoBucket(String(r.bucket))
      metricsMap.set(key, (metricsMap.get(key) ?? 0) + Number(r.sumValue))
    }

    const allBuckets = new Set<string>()
    for (const k of countMap.keys()) allBuckets.add(k)
    for (const k of metricsMap.keys()) allBuckets.add(k)

    const points = [...allBuckets].sort().map((bucket): ServiceDetailTimeSeriesPoint => {
      const rawCount = countMap.get(bucket) ?? 0
      const metricsThroughput = metricsMap.get(bucket)

      if (metricsThroughput != null && metricsThroughput > 0) {
        return {
          bucket,
          throughput: metricsThroughput,
          tracedThroughput: rawCount,
          hasSampling: true,
          samplingWeight: rawCount > 0 ? metricsThroughput / rawCount : 1,
          errorRate: errorRateMap.get(bucket) ?? 0,
          p50LatencyMs: p50Map.get(bucket) ?? 0,
          p95LatencyMs: p95Map.get(bucket) ?? 0,
          p99LatencyMs: p99Map.get(bucket) ?? 0,
        }
      }

      return {
        bucket,
        throughput: rawCount,
        tracedThroughput: rawCount,
        hasSampling: false,
        samplingWeight: 1,
        errorRate: errorRateMap.get(bucket) ?? 0,
        p50LatencyMs: p50Map.get(bucket) ?? 0,
        p95LatencyMs: p95Map.get(bucket) ?? 0,
        p99LatencyMs: p99Map.get(bucket) ?? 0,
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

const getCustomChartServiceSparklinesEffect = Effect.fn("QueryEngine.getCustomChartServiceSparklines")(
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

    const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
    const reqOpts = {
      startTime: input.startTime,
      endTime: input.endTime,
      bucketSeconds,
      rootSpansOnly: true,
      environments: input.environments,
      commitShas: input.commitShas,
      groupBy: ["service"] as string[],
    }

    const [countRes, errorRateRes, metricsResult] = yield* Effect.all([
      executeQueryEngine("queryEngine.sparklines.count", makeTracesTimeseriesRequest("count", reqOpts)),
      executeQueryEngine("queryEngine.sparklines.errorRate", makeTracesTimeseriesRequest("error_rate", reqOpts)),
      querySpanMetricsCalls({
        start_time: input.startTime,
        end_time: input.endTime,
        bucket_seconds: bucketSeconds,
      }),
    ], { concurrency: 3 })

    // SpanMetrics: keyed by "serviceName::bucket"
    const metricsMap = new Map<string, number>()
    for (const r of metricsResult.data) {
      const key = `${String(r.serviceName)}::${toIsoBucket(String(r.bucket))}`
      metricsMap.set(key, (metricsMap.get(key) ?? 0) + Number(r.sumValue))
    }

    // Build per-service count and errorRate maps from grouped timeseries
    const countByService = new Map<string, Map<string, number>>()
    const errorRateByService = new Map<string, Map<string, number>>()

    const extractGroupedSeries = (
      response: typeof countRes,
      target: Map<string, Map<string, number>>,
    ) => {
      if (response.result.kind !== "timeseries") return
      for (const point of response.result.data) {
        for (const [service, value] of Object.entries(point.series)) {
          let serviceMap = target.get(service)
          if (!serviceMap) {
            serviceMap = new Map()
            target.set(service, serviceMap)
          }
          serviceMap.set(point.bucket, Number(value))
        }
      }
    }

    extractGroupedSeries(countRes, countByService)
    extractGroupedSeries(errorRateRes, errorRateByService)

    const timeline = buildBucketTimeline(input.startTime, input.endTime, bucketSeconds)
    const grouped: Record<string, ServiceTimeSeriesPoint[]> = {}

    for (const [service, bucketCountMap] of countByService) {
      const serviceErrorMap = errorRateByService.get(service) ?? new Map()
      const points: ServiceTimeSeriesPoint[] = []

      for (const [bucket, rawCount] of bucketCountMap) {
        const metricsKey = `${service}::${bucket}`
        const metricsThroughput = metricsMap.get(metricsKey)

        let throughput: number
        let hasSampling: boolean

        if (metricsThroughput != null && metricsThroughput > 0) {
          throughput = metricsThroughput
          hasSampling = true
        } else {
          throughput = rawCount
          hasSampling = false
        }

        points.push({
          bucket,
          throughput,
          tracedThroughput: rawCount,
          hasSampling,
          errorRate: serviceErrorMap.get(bucket) ?? 0,
        })
      }

      grouped[service] = points
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
