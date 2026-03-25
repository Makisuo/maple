import {
  type QueryEngineAlertObservation,
  type QueryEngineAlertReducer,
  type QueryEngineEvaluateRequest,
  QueryEngineEvaluateResponse,
  type QueryEngineExecuteRequest,
  QueryEngineExecuteResponse,
  type QueryEngineSampleCountStrategy,
  type QuerySpec,
  type TimeseriesPoint,
} from "@maple/query-engine"
import {
  QueryEngineExecutionError,
  QueryEngineValidationError,
  TinybirdQueryError,
} from "@maple/domain/http"
import { Effect, Layer, ServiceMap } from "effect"
import type { TenantContext } from "./AuthService"
import { TinybirdService, type TinybirdServiceShape } from "./TinybirdService"

interface TimeRangeBounds {
  readonly startMs: number
  readonly endMs: number
  readonly rangeSeconds: number
}

interface BucketFillOptions {
  readonly startMs: number
  readonly endMs: number
  readonly bucketSeconds: number
}

interface MetricTimeseriesRow {
  readonly bucket: string | Date
  readonly serviceName: string
  readonly avgValue: number
  readonly minValue: number
  readonly maxValue: number
  readonly sumValue: number
  readonly dataPointCount: number
}

type AlertObservation = QueryEngineAlertObservation

export interface GroupedAlertObservation {
  readonly groupKey: string
  readonly value: number | null
  readonly sampleCount: number
  readonly hasData: boolean
}

export interface QueryEngineServiceShape {
  readonly execute: (
    tenant: TenantContext,
    request: QueryEngineExecuteRequest,
  ) => Effect.Effect<
    QueryEngineExecuteResponse,
    QueryEngineValidationError | QueryEngineExecutionError
  >
  readonly evaluate: (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
  ) => Effect.Effect<
    QueryEngineEvaluateResponse,
    QueryEngineValidationError | QueryEngineExecutionError
  >
  readonly evaluateGrouped: (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
    groupBy: "service",
  ) => Effect.Effect<
    ReadonlyArray<GroupedAlertObservation>,
    QueryEngineValidationError | QueryEngineExecutionError
  >
}

const MAX_RANGE_SECONDS = 60 * 60 * 24 * 31
const MAX_TIMESERIES_POINTS = 1_500

const toEpochMs = (value: string): number => new Date(value.replace(" ", "T") + "Z").getTime()
const TINYBIRD_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/

const computeBucketSeconds = (startMs: number, endMs: number): number => {
  const targetPoints = 40
  const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
  const raw = Math.ceil(rangeSeconds / targetPoints)
  if (raw <= 60) return 60
  if (raw <= 300) return 300
  if (raw <= 900) return 900
  if (raw <= 3600) return 3600
  if (raw <= 14400) return 14400
  return 86400
}

const floorToBucketMs = (epochMs: number, bucketSeconds: number): number => {
  const bucketMs = bucketSeconds * 1000
  return Math.floor(epochMs / bucketMs) * bucketMs
}

const buildBucketTimeline = (
  startMs: number,
  endMs: number,
  bucketSeconds: number,
): string[] => {
  const bucketMs = bucketSeconds * 1000
  const firstBucketMs = floorToBucketMs(startMs, bucketSeconds)
  const lastBucketMs = floorToBucketMs(endMs, bucketSeconds)
  const timeline: string[] = []

  for (let bucketMsCursor = firstBucketMs; bucketMsCursor <= lastBucketMs; bucketMsCursor += bucketMs) {
    timeline.push(new Date(bucketMsCursor).toISOString())
  }

  return timeline
}

const normalizeBucket = (bucket: string | Date): string => {
  if (bucket instanceof Date) {
    return bucket.toISOString()
  }

  const raw = String(bucket).trim()
  if (!raw) {
    return raw
  }

  const tinybirdDateTimeMatch = raw.match(TINYBIRD_DATETIME_RE)
  if (tinybirdDateTimeMatch) {
    const [, datePart, timePart, fractional = ""] = tinybirdDateTimeMatch
    const normalized = new Date(`${datePart}T${timePart}${fractional}Z`)
    if (!Number.isNaN(normalized.getTime())) {
      return normalized.toISOString()
    }
  }

  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString()
  }

  return raw
}

const validateTimeRange = Effect.fn("QueryEngineService.validateTimeRange")(function* (
  request: { readonly startTime: string; readonly endTime: string },
): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
  const startMs = toEpochMs(request.startTime)
  const endMs = toEpochMs(request.endTime)

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return yield* new QueryEngineValidationError({
      message: "Invalid time range",
      details: ["startTime and endTime must be valid datetime strings"],
    })
  }

  if (endMs <= startMs) {
    return yield* new QueryEngineValidationError({
      message: "Invalid time range",
      details: ["endTime must be greater than startTime"],
    })
  }

  const rangeSeconds = (endMs - startMs) / 1000
  if (rangeSeconds > MAX_RANGE_SECONDS) {
    return yield* new QueryEngineValidationError({
      message: "Time range too large",
      details: [`Maximum supported range is ${MAX_RANGE_SECONDS} seconds`],
    })
  }

  return {
    startMs,
    endMs,
    rangeSeconds,
  }
})

const validateTraceAttributeFilters = Effect.fn("QueryEngineService.validateTraceAttributeFilters")(function* (
  query: QuerySpec,
): Effect.fn.Return<void, QueryEngineValidationError> {
  if (query.source !== "traces") return

  const details: string[] = []
  if (query.groupBy?.includes("attribute") && !query.filters?.groupByAttributeKeys?.length) {
    details.push("groupBy=attribute requires filters.groupByAttributeKeys")
  }
  if (!query.filters?.attributeKey && query.filters?.attributeValue) {
    details.push("filters.attributeValue requires filters.attributeKey")
  }

  if (details.length > 0) {
    return yield* new QueryEngineValidationError({
      message: "Invalid traces attribute filters",
      details,
    })
  }
})

const validatePointBudget = Effect.fn("QueryEngineService.validatePointBudget")(function* (
  request: QueryEngineExecuteRequest,
  range: TimeRangeBounds,
): Effect.fn.Return<void, QueryEngineValidationError> {
  if (request.query.kind !== "timeseries") return
  const bucketSeconds = request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs)
  const pointCount = Math.ceil(range.rangeSeconds / bucketSeconds)
  if (pointCount <= MAX_TIMESERIES_POINTS) return

  return yield* new QueryEngineValidationError({
    message: "Timeseries query too expensive",
    details: [
      `Requested ${pointCount} points, maximum is ${MAX_TIMESERIES_POINTS}`,
      "Increase bucketSeconds or reduce the time range",
    ],
  })
})

function groupTimeSeriesRows<T extends { bucket: string | Date; groupName: string }>(
  rows: ReadonlyArray<T>,
  valueExtractor: (row: T) => number,
  fillOptions?: BucketFillOptions,
): Array<TimeseriesPoint> {
  const bucketMap = new Map<string, Record<string, number>>()
  const bucketOrder: string[] = fillOptions
    ? buildBucketTimeline(fillOptions.startMs, fillOptions.endMs, fillOptions.bucketSeconds)
    : []

  for (const row of rows) {
    const bucket = normalizeBucket(row.bucket)
    if (!bucketMap.has(bucket)) {
      bucketMap.set(bucket, {})
      if (!fillOptions) {
        bucketOrder.push(bucket)
      }
    }
    bucketMap.get(bucket)![row.groupName] = valueExtractor(row)
  }

  if (fillOptions) {
    for (const bucket of bucketOrder) {
      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, {})
      }
    }
  }

  return bucketOrder.map((bucket) => ({
    bucket,
    series: bucketMap.get(bucket)!,
  }))
}

function collapseMetricTimeseriesRows(
  rows: ReadonlyArray<MetricTimeseriesRow>,
  metric: QuerySpec["metric"],
): Array<{ bucket: string; groupName: "all"; value: number }> {
  const bucketMap = new Map<
    string,
    {
      sumValue: number
      dataPointCount: number
      minValue: number
      maxValue: number
    }
  >()

  for (const row of rows) {
    const bucket = normalizeBucket(row.bucket)
    const current = bucketMap.get(bucket)
    if (current) {
      current.sumValue += Number(row.sumValue)
      current.dataPointCount += Number(row.dataPointCount)
      current.minValue = Math.min(current.minValue, Number(row.minValue))
      current.maxValue = Math.max(current.maxValue, Number(row.maxValue))
    } else {
      bucketMap.set(bucket, {
        sumValue: Number(row.sumValue),
        dataPointCount: Number(row.dataPointCount),
        minValue: Number(row.minValue),
        maxValue: Number(row.maxValue),
      })
    }
  }

  return [...bucketMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, value]) => ({
      bucket,
      groupName: "all" as const,
      value:
        metric === "count"
          ? value.dataPointCount
          : metric === "sum"
            ? value.sumValue
            : metric === "min"
              ? value.minValue
              : metric === "max"
                ? value.maxValue
                : value.dataPointCount > 0
                  ? value.sumValue / value.dataPointCount
                  : 0,
    }))
}

const validateExecute = Effect.fn("QueryEngineService.validateExecute")(function* (
  request: QueryEngineExecuteRequest,
): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
  const range = yield* validateTimeRange(request)
  yield* validateTraceAttributeFilters(request.query)
  yield* validatePointBudget(request, range)
  return range
})

const validateEvaluate = Effect.fn("QueryEngineService.validateEvaluate")(function* (
  request: QueryEngineEvaluateRequest,
): Effect.fn.Return<TimeRangeBounds, QueryEngineValidationError> {
  const range = yield* validateTimeRange(request)
  yield* validateTraceAttributeFilters(request.query)
  return range
})

const mapTinybirdError = <A, R>(
  effect: Effect.Effect<A, TinybirdQueryError, R>,
  context: string,
): Effect.Effect<A, QueryEngineExecutionError, R> =>
  effect.pipe(
    Effect.catchTag("TinybirdQueryError", (error: TinybirdQueryError) =>
      Effect.fail(
        new QueryEngineExecutionError({
          message: `${context}: ${error.message}`,
          causeTag: error._tag,
          pipe: error.pipe,
        }),
      ),
    ),
  )

type QueryEngineTinybird = Pick<
  TinybirdServiceShape,
  | "customTracesTimeseriesQuery"
  | "customLogsTimeseriesQuery"
  | "metricTimeSeriesSumQuery"
  | "metricTimeSeriesGaugeQuery"
  | "metricTimeSeriesHistogramQuery"
  | "metricTimeSeriesExpHistogramQuery"
  | "customTracesBreakdownQuery"
  | "customLogsBreakdownQuery"
  | "customMetricsBreakdownQuery"
  | "alertTracesAggregateQuery"
  | "alertMetricsAggregateQuery"
  | "alertLogsAggregateQuery"
  | "alertTracesAggregateByServiceQuery"
  | "alertMetricsAggregateByServiceQuery"
  | "alertLogsAggregateByServiceQuery"
>

const tracesMetricFieldMap = {
  count: "count",
  avg_duration: "avgDuration",
  p50_duration: "p50Duration",
  p95_duration: "p95Duration",
  p99_duration: "p99Duration",
  error_rate: "errorRate",
  apdex: "apdexScore",
} as const

const tracesAggregateValueForMetric = (
  metric: Extract<QuerySpec, { source: "traces" }>["metric"],
  row: {
    readonly count: number
    readonly avgDuration: number
    readonly p50Duration: number
    readonly p95Duration: number
    readonly p99Duration: number
    readonly errorRate: number
    readonly apdexScore: number
  },
): number => Number(row[tracesMetricFieldMap[metric]])

const metricsAggregateValueForMetric = (
  metric: Extract<QuerySpec, { source: "metrics" }>["metric"],
  row: {
    readonly avgValue: number
    readonly minValue: number
    readonly maxValue: number
    readonly sumValue: number
    readonly dataPointCount: number
  },
): number => {
  switch (metric) {
    case "avg":
      return Number(row.avgValue)
    case "min":
      return Number(row.minValue)
    case "max":
      return Number(row.maxValue)
    case "sum":
      return Number(row.sumValue)
    case "count":
      return Number(row.dataPointCount)
  }
}

const applyAlertReducer = (
  observations: ReadonlyArray<AlertObservation>,
  reducer: QueryEngineAlertReducer,
): number | null => {
  const values = observations
    .filter((observation) => observation.hasData && observation.value != null)
    .map((observation) => observation.value as number)

  if (values.length === 0) {
    return null
  }

  switch (reducer) {
    case "identity":
      return values[0] ?? null
    case "sum":
      return values.reduce((sum, value) => sum + value, 0)
    case "avg":
      return values.reduce((sum, value) => sum + value, 0) / values.length
    case "min":
      return Math.min(...values)
    case "max":
      return Math.max(...values)
  }
}

const sampleCountForStrategy = (
  _strategy: QueryEngineSampleCountStrategy,
  observations: ReadonlyArray<AlertObservation>,
): number =>
  observations.reduce((sum, observation) => sum + Number(observation.sampleCount), 0)

const isScalarAlertQuery = (
  query: QuerySpec,
): query is Extract<QuerySpec, { kind: "timeseries"; source: "traces" | "logs" | "metrics" }> => {
  if (query.kind !== "timeseries") {
    return false
  }

  if (query.source !== "traces" && query.source !== "metrics" && query.source !== "logs") {
    return false
  }

  return query.groupBy == null || query.groupBy.length === 0 || (
    query.groupBy.length === 1 && query.groupBy[0] === "none"
  )
}

export const makeQueryEngineExecute = (tinybird: QueryEngineTinybird) =>
  Effect.fn("QueryEngineService.execute")(function* (
    tenant: TenantContext,
    request: QueryEngineExecuteRequest,
  ): Effect.fn.Return<
    QueryEngineExecuteResponse,
    QueryEngineValidationError | QueryEngineExecutionError
  > {
    const range = yield* validateExecute(request)
    const bucketSeconds = request.query.kind === "timeseries"
      ? request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs)
      : undefined
    const fillOptions = bucketSeconds
      ? {
          startMs: range.startMs,
          endMs: range.endMs,
          bucketSeconds,
        }
      : undefined

    if (request.query.source === "traces" && request.query.kind === "timeseries") {
      const result = yield* mapTinybirdError(
        tinybird.customTracesTimeseriesQuery(tenant, {
          start_time: request.startTime,
          end_time: request.endTime,
          bucket_seconds: bucketSeconds,
          service_name: request.query.filters?.serviceName,
          span_name: request.query.filters?.spanName,
          root_only: request.query.filters?.rootSpansOnly ? "1" : undefined,
          errors_only: request.query.filters?.errorsOnly ? "1" : undefined,
          environments: request.query.filters?.environments?.join(","),
          commit_shas: request.query.filters?.commitShas?.join(","),
          group_by_service: request.query.groupBy?.includes("service") ? "1" : undefined,
          group_by_span_name: request.query.groupBy?.includes("span_name") ? "1" : undefined,
          group_by_status_code: request.query.groupBy?.includes("status_code") ? "1" : undefined,
          group_by_http_method: request.query.groupBy?.includes("http_method") ? "1" : undefined,
          group_by_attributes:
            request.query.groupBy?.includes("attribute") && request.query.filters?.groupByAttributeKeys?.length
              ? request.query.filters.groupByAttributeKeys.join(",")
              : undefined,
          attribute_filter_key: request.query.filters?.attributeKey,
          attribute_filter_value:
            request.query.filters?.attributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.attributeValue,
          attribute_filter_exists:
            request.query.filters?.attributeFilterMode === "exists" ? "1" : undefined,
          resource_filter_key: request.query.filters?.resourceAttributeKey,
          resource_filter_value:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.resourceAttributeValue,
          resource_filter_exists:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? "1"
              : undefined,
          apdex_threshold_ms:
            request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
        }),
        "Failed to execute traces timeseries query",
      )

      const field = tracesMetricFieldMap[request.query.metric]

      return new QueryEngineExecuteResponse({
        result: {
          kind: "timeseries",
          source: "traces",
          data: groupTimeSeriesRows(result, (row) => Number(row[field]), fillOptions),
        },
      })
    }

    if (request.query.source === "logs" && request.query.kind === "timeseries") {
      const result = yield* mapTinybirdError(
        tinybird.customLogsTimeseriesQuery(tenant, {
          start_time: request.startTime,
          end_time: request.endTime,
          bucket_seconds: bucketSeconds,
          service_name: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          group_by_service: request.query.groupBy?.includes("service") ? "1" : undefined,
          group_by_severity: request.query.groupBy?.includes("severity") ? "1" : undefined,
        }),
        "Failed to execute logs timeseries query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "timeseries",
          source: "logs",
          data: groupTimeSeriesRows(result, (row) => Number(row.count), fillOptions),
        },
      })
    }

    if (request.query.source === "metrics" && request.query.kind === "timeseries") {
      const params = {
        metric_name: request.query.filters.metricName,
        service: request.query.filters.serviceName,
        start_time: request.startTime,
        end_time: request.endTime,
        bucket_seconds: bucketSeconds,
      }

      const result = yield* mapTinybirdError(
        request.query.filters.metricType === "sum"
          ? tinybird.metricTimeSeriesSumQuery(tenant, params)
          : request.query.filters.metricType === "gauge"
            ? tinybird.metricTimeSeriesGaugeQuery(tenant, params)
            : request.query.filters.metricType === "histogram"
              ? tinybird.metricTimeSeriesHistogramQuery(tenant, params)
              : tinybird.metricTimeSeriesExpHistogramQuery(tenant, params),
        "Failed to execute metrics timeseries query",
      )

      const metricValueField = {
        avg: "avgValue",
        sum: "sumValue",
        min: "minValue",
        max: "maxValue",
        count: "dataPointCount",
      } as const
      const valueField = metricValueField[request.query.metric]
      const data = (request.query.groupBy?.includes("none") || !request.query.groupBy?.length)
        ? groupTimeSeriesRows(
            collapseMetricTimeseriesRows(result as Array<MetricTimeseriesRow>, request.query.metric),
            (row) => row.value,
            fillOptions,
          )
        : groupTimeSeriesRows(
            result.map((row) => ({
              bucket: row.bucket,
              groupName: row.serviceName,
              value: Number(row[valueField]),
            })),
            (row) => row.value,
            fillOptions,
          )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "timeseries",
          source: "metrics",
          data,
        },
      })
    }

    if (request.query.source === "traces" && request.query.kind === "breakdown") {
      const result = yield* mapTinybirdError(
        tinybird.customTracesBreakdownQuery(tenant, {
          start_time: request.startTime,
          end_time: request.endTime,
          service_name: request.query.filters?.serviceName,
          span_name: request.query.filters?.spanName,
          limit: request.query.limit,
          root_only: request.query.filters?.rootSpansOnly ? "1" : undefined,
          errors_only: request.query.filters?.errorsOnly ? "1" : undefined,
          environments: request.query.filters?.environments?.join(","),
          commit_shas: request.query.filters?.commitShas?.join(","),
          group_by_service: request.query.groupBy === "service" ? "1" : undefined,
          group_by_span_name: request.query.groupBy === "span_name" ? "1" : undefined,
          group_by_status_code: request.query.groupBy === "status_code" ? "1" : undefined,
          group_by_http_method: request.query.groupBy === "http_method" ? "1" : undefined,
          group_by_attribute:
            request.query.groupBy === "attribute"
              ? request.query.filters?.groupByAttributeKeys?.[0]
              : undefined,
          attribute_filter_key: request.query.filters?.attributeKey,
          attribute_filter_value:
            request.query.filters?.attributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.attributeValue,
          attribute_filter_exists:
            request.query.filters?.attributeFilterMode === "exists" ? "1" : undefined,
          resource_filter_key: request.query.filters?.resourceAttributeKey,
          resource_filter_value:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.resourceAttributeValue,
          resource_filter_exists:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? "1"
              : undefined,
          apdex_threshold_ms:
            request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
        }),
        "Failed to execute traces breakdown query",
      )

      const field = tracesMetricFieldMap[request.query.metric]

      return new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "traces",
          data: result.map((row) => ({
            name: row.name,
            value: Number(row[field]),
          })),
        },
      })
    }

    if (request.query.source === "logs" && request.query.kind === "breakdown") {
      const result = yield* mapTinybirdError(
        tinybird.customLogsBreakdownQuery(tenant, {
          start_time: request.startTime,
          end_time: request.endTime,
          service_name: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          limit: request.query.limit,
          group_by_service: request.query.groupBy === "service" ? "1" : undefined,
          group_by_severity: request.query.groupBy === "severity" ? "1" : undefined,
        }),
        "Failed to execute logs breakdown query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "logs",
          data: result.map((row) => ({
            name: row.name,
            value: Number(row.count),
          })),
        },
      })
    }

    if (request.query.source === "metrics" && request.query.kind === "breakdown") {
      const result = yield* mapTinybirdError(
        tinybird.customMetricsBreakdownQuery(tenant, {
          metric_name: request.query.filters.metricName,
          start_time: request.startTime,
          end_time: request.endTime,
          metric_type: request.query.filters.metricType,
          limit: request.query.limit,
        }),
        "Failed to execute metrics breakdown query",
      )

      const valueFieldMap = {
        avg: "avgValue",
        sum: "sumValue",
        count: "count",
      } as const
      const valueField = valueFieldMap[request.query.metric]

      return new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "metrics",
          data: result.map((row) => ({
            name: row.name,
            value: Number(row[valueField]),
          })),
        },
      })
    }

    return yield* new QueryEngineValidationError({
      message: "Unsupported query",
      details: ["This source/kind combination is not supported"],
    })
  })

export const makeQueryEngineEvaluate = (tinybird: QueryEngineTinybird) =>
  Effect.fn("QueryEngineService.evaluate")(function* (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
  ): Effect.fn.Return<
    QueryEngineEvaluateResponse,
    QueryEngineValidationError | QueryEngineExecutionError
  > {
    yield* validateEvaluate(request)

    if (!isScalarAlertQuery(request.query)) {
      return yield* new QueryEngineValidationError({
        message: "Unsupported alert evaluation query",
        details: [
          "Alert evaluation currently supports collapsed traces, logs, and metrics timeseries queries only",
        ],
      })
    }

    let observations: ReadonlyArray<AlertObservation>

    if (request.query.source === "traces") {
      const rows = yield* mapTinybirdError(
        tinybird.alertTracesAggregateQuery(tenant, {
          start_time: request.startTime,
          end_time: request.endTime,
          service_name: request.query.filters?.serviceName,
          span_name: request.query.filters?.spanName,
          root_only: request.query.filters?.rootSpansOnly ? "1" : undefined,
          errors_only: request.query.filters?.errorsOnly ? "1" : undefined,
          environments: request.query.filters?.environments?.join(","),
          commit_shas: request.query.filters?.commitShas?.join(","),
          attribute_filter_key: request.query.filters?.attributeKey,
          attribute_filter_value:
            request.query.filters?.attributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.attributeValue,
          attribute_filter_exists:
            request.query.filters?.attributeFilterMode === "exists" ? "1" : undefined,
          resource_filter_key: request.query.filters?.resourceAttributeKey,
          resource_filter_value:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? undefined
              : request.query.filters?.resourceAttributeValue,
          resource_filter_exists:
            request.query.filters?.resourceAttributeFilterMode === "exists"
              ? "1"
              : undefined,
          apdex_threshold_ms:
            request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
        }),
        "Failed to evaluate traces alert query",
      )

      const row = rows[0]
      const sampleCount = Number(row?.count ?? 0)
      observations = [{
        value:
          sampleCount > 0 && row
            ? tracesAggregateValueForMetric(request.query.metric, row)
            : null,
        sampleCount,
        hasData: sampleCount > 0,
      }]
    } else if (request.query.source === "logs") {
      const rows = yield* mapTinybirdError(
        tinybird.alertLogsAggregateQuery(tenant, {
          service_name: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          start_time: request.startTime,
          end_time: request.endTime,
        }),
        "Failed to evaluate logs alert query",
      )

      const row = rows[0]
      const sampleCount = Number(row?.count ?? 0)
      observations = [{
        value: sampleCount > 0 ? sampleCount : null,
        sampleCount,
        hasData: sampleCount > 0,
      }]
    } else {
      const rows = yield* mapTinybirdError(
        tinybird.alertMetricsAggregateQuery(tenant, {
          metric_name: request.query.filters.metricName,
          metric_type: request.query.filters.metricType,
          service: request.query.filters.serviceName,
          start_time: request.startTime,
          end_time: request.endTime,
        }),
        "Failed to evaluate metrics alert query",
      )

      const row = rows[0]
      const sampleCount = Number(row?.dataPointCount ?? 0)
      observations = [{
        value:
          sampleCount > 0 && row
            ? metricsAggregateValueForMetric(request.query.metric, row)
            : null,
        sampleCount,
        hasData: sampleCount > 0,
      }]
    }

    return new QueryEngineEvaluateResponse({
      value: applyAlertReducer(observations, request.reducer),
      sampleCount: sampleCountForStrategy(request.sampleCountStrategy, observations),
      hasData: observations.some((observation) => observation.hasData),
      reason: `Reduced ${observations.length} observation(s) with ${request.reducer}`,
      reducer: request.reducer,
      observations,
    })
  })

export const makeQueryEngineEvaluateGrouped = (tinybird: QueryEngineTinybird) =>
  Effect.fn("QueryEngineService.evaluateGrouped")(function* (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
    groupBy: "service",
  ): Effect.fn.Return<
    ReadonlyArray<GroupedAlertObservation>,
    QueryEngineValidationError | QueryEngineExecutionError
  > {
    yield* validateEvaluate(request)

    if (
      request.query.kind !== "timeseries" ||
      (request.query.source !== "traces" &&
        request.query.source !== "metrics" &&
        request.query.source !== "logs")
    ) {
      return yield* new QueryEngineValidationError({
        message: "Unsupported grouped alert evaluation query",
        details: ["Grouped alert evaluation supports traces, logs, and metrics timeseries queries only"],
      })
    }

    if (groupBy === "service") {
      if (request.query.source === "traces") {
        const rows = yield* mapTinybirdError(
          tinybird.alertTracesAggregateByServiceQuery(tenant, {
            start_time: request.startTime,
            end_time: request.endTime,
            span_name: request.query.filters?.spanName,
            root_only: request.query.filters?.rootSpansOnly ? "1" : undefined,
            errors_only: request.query.filters?.errorsOnly ? "1" : undefined,
            environments: request.query.filters?.environments?.join(","),
            commit_shas: request.query.filters?.commitShas?.join(","),
            attribute_filter_key: request.query.filters?.attributeKey,
            attribute_filter_value:
              request.query.filters?.attributeFilterMode === "exists"
                ? undefined
                : request.query.filters?.attributeValue,
            attribute_filter_exists:
              request.query.filters?.attributeFilterMode === "exists" ? "1" : undefined,
            resource_filter_key: request.query.filters?.resourceAttributeKey,
            resource_filter_value:
              request.query.filters?.resourceAttributeFilterMode === "exists"
                ? undefined
                : request.query.filters?.resourceAttributeValue,
            resource_filter_exists:
              request.query.filters?.resourceAttributeFilterMode === "exists"
                ? "1"
                : undefined,
            apdex_threshold_ms:
              request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
          }),
          "Failed to evaluate grouped traces alert query",
        )

        return rows.map((row) => {
          const sampleCount = Number(row.count ?? 0)
          return {
            groupKey: row.serviceName,
            value: sampleCount > 0 ? tracesAggregateValueForMetric(request.query.metric as Extract<QuerySpec, { source: "traces" }>["metric"], row) : null,
            sampleCount,
            hasData: sampleCount > 0,
          }
        })
      } else if (request.query.source === "logs") {
        const rows = yield* mapTinybirdError(
          tinybird.alertLogsAggregateByServiceQuery(tenant, {
            severity: request.query.filters?.severity,
            start_time: request.startTime,
            end_time: request.endTime,
          }),
          "Failed to evaluate grouped logs alert query",
        )

        return rows.map((row) => {
          const sampleCount = Number(row.count ?? 0)
          return {
            groupKey: row.serviceName,
            value: sampleCount > 0 ? sampleCount : null,
            sampleCount,
            hasData: sampleCount > 0,
          }
        })
      } else {
        const rows = yield* mapTinybirdError(
          tinybird.alertMetricsAggregateByServiceQuery(tenant, {
            metric_name: (request.query as Extract<QuerySpec, { source: "metrics" }>).filters.metricName,
            metric_type: (request.query as Extract<QuerySpec, { source: "metrics" }>).filters.metricType,
            start_time: request.startTime,
            end_time: request.endTime,
          }),
          "Failed to evaluate grouped metrics alert query",
        )

        return rows.map((row) => {
          const sampleCount = Number(row.dataPointCount ?? 0)
          return {
            groupKey: row.serviceName,
            value: sampleCount > 0 ? metricsAggregateValueForMetric(request.query.metric as Extract<QuerySpec, { source: "metrics" }>["metric"], row) : null,
            sampleCount,
            hasData: sampleCount > 0,
          }
        })
      }
    }

    return []
  })

export class QueryEngineService extends ServiceMap.Service<QueryEngineService, QueryEngineServiceShape>()("QueryEngineService", {
  make: Effect.gen(function* () {
    const tinybird = yield* TinybirdService
    const execute = makeQueryEngineExecute(tinybird)
    const evaluate = makeQueryEngineEvaluate(tinybird)
    const evaluateGrouped = makeQueryEngineEvaluateGrouped(tinybird)

    return {
      execute,
      evaluate,
      evaluateGrouped,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
