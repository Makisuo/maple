import {
  type QueryEngineAlertObservation,
  type QueryEngineAlertReducer,
  type QueryEngineEvaluateRequest,
  type QueryEngineExecuteRequest,
  QueryEngineExecuteResponse,
  type QuerySpec,
  type TimeseriesPoint,
  CH,
} from "@maple/query-engine"
import {
  QueryEngineExecutionError,
  QueryEngineTimeoutError,
  QueryEngineValidationError,
  TinybirdQueryError,
} from "@maple/domain/http"
import { Array as Arr, Duration, Effect, Layer, Match, Metric, Option, Result, Context } from "effect"
import type { TenantContext } from "./AuthService"
import { EdgeCacheService } from "./EdgeCacheService"
import { TinybirdService, type TinybirdServiceShape } from "./TinybirdService"
import * as QueryEngineMetrics from "./QueryEngineMetrics"

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
  readonly attributeValue: string
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
    QueryEngineValidationError | QueryEngineExecutionError | QueryEngineTimeoutError
  >
  /**
   * Evaluate an alert query and return one observation per group. When the
   * spec has no group-by (or `groupBy = ["none"]`) the result is a length-1
   * array with `groupKey = "all"`. The reducer collapses each group's bucket
   * series down to a scalar value.
   */
  readonly evaluate: (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
  ) => Effect.Effect<
    ReadonlyArray<GroupedAlertObservation>,
    QueryEngineValidationError | QueryEngineExecutionError | QueryEngineTimeoutError
  >
  readonly cachedDirect: <A>(
    tenant: TenantContext,
    routeName: string,
    payload: unknown,
    effect: Effect.Effect<A, QueryEngineExecutionError>,
  ) => Effect.Effect<A, QueryEngineExecutionError>
}

const MAX_RANGE_SECONDS = 60 * 60 * 24 * 31
const MAX_LIST_RANGE_SECONDS = 60 * 60 * 24 * 7
const MAX_TIMESERIES_POINTS = 1_500
const QUERY_ENGINE_TIMEOUT = Duration.seconds(30)

const withTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: QUERY_ENGINE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new QueryEngineTimeoutError({
            message: "Query execution timed out after 30 seconds",
          }),
        ),
    }),
  )

const toEpochMs = (value: string): number => new Date(value.replace(" ", "T") + "Z").getTime()
const TINYBIRD_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/

const CACHE_SNAP_S = 15

function snapSeconds(dateStr: string): string {
  if (dateStr.length !== 19 || dateStr[4] !== "-" || dateStr[10] !== " ") return dateStr
  const seconds = parseInt(dateStr.slice(17, 19), 10)
  if (Number.isNaN(seconds)) return dateStr
  const snapped = seconds - (seconds % CACHE_SNAP_S)
  return dateStr.slice(0, 17) + snapped.toString().padStart(2, "0")
}

function buildCacheKey(orgId: string, request: QueryEngineExecuteRequest): string {
  return `${orgId}:${snapSeconds(request.startTime)}:${snapSeconds(request.endTime)}:${JSON.stringify(request.query)}`
}

function buildEvaluateCacheKey(orgId: string, request: QueryEngineEvaluateRequest): string {
  return `eval:${orgId}:${snapSeconds(request.startTime)}:${snapSeconds(request.endTime)}:${request.reducer}:${request.sampleCountStrategy}:${JSON.stringify(request.query)}`
}

const DIRECT_CACHE_SNAP_KEYS = new Set(["startTime", "endTime"])

function normalizeDirectCacheValue(value: unknown, parentKey?: string): unknown {
  if (value == null) return value
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (parentKey && DIRECT_CACHE_SNAP_KEYS.has(parentKey) && typeof value === "string") {
      return snapSeconds(value)
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDirectCacheValue(item))
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeDirectCacheValue(nestedValue, key)]),
    )
  }

  return String(value)
}

function buildDirectRouteCacheKey(orgId: string, routeName: string, payload: unknown): string {
  return `direct:${orgId}:${routeName}:${JSON.stringify(normalizeDirectCacheValue(payload))}`
}

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
  if (query.kind !== "timeseries" && query.kind !== "breakdown") return

  const details: string[] = []
  if (query.groupBy?.includes("attribute") && !query.filters?.groupByAttributeKeys?.length) {
    details.push("groupBy=attribute requires filters.groupByAttributeKeys")
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

const validateListQuery = Effect.fn("QueryEngineService.validateListQuery")(function* (
  request: QueryEngineExecuteRequest,
  range: TimeRangeBounds,
): Effect.fn.Return<void, QueryEngineValidationError> {
  if (request.query.kind !== "list") return

  if (range.rangeSeconds > MAX_LIST_RANGE_SECONDS) {
    return yield* new QueryEngineValidationError({
      message: "List query time range too large",
      details: [
        `List queries support a maximum range of 7 days`,
        "Narrow the time range or use a timeseries/breakdown query for wider ranges",
      ],
    })
  }
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

function parseSamplingWeight(hex: string): number {
  if (!hex || hex === "0") return 1
  const thresholdInt = parseInt(hex, 16)
  const maxInt = Math.pow(16, hex.length)
  const rejectionRate = thresholdInt / maxInt
  return 1 / Math.max(1 - rejectionRate, 0.0001)
}

function groupAllMetricsTimeSeriesRows<T extends {
  bucket: string | Date
  groupName: string
  count: number
  avgDuration: number
  p50Duration: number
  p95Duration: number
  p99Duration: number
  errorRate: number
  apdexScore: number
  sampledSpanCount: number
  unsampledSpanCount: number
  dominantThreshold: string
}>(
  rows: ReadonlyArray<T>,
  fillOptions?: BucketFillOptions,
): Array<TimeseriesPoint> {
  const emptyMetrics: Record<string, number> = {
    count: 0,
    avg_duration: 0,
    p50_duration: 0,
    p95_duration: 0,
    p99_duration: 0,
    error_rate: 0,
    apdex: 0,
    sampled_span_count: 0,
    unsampled_span_count: 0,
    sampling_weight: 1,
  }
  const bucketMap = new Map<string, Record<string, number>>()
  const bucketOrder: string[] = fillOptions
    ? buildBucketTimeline(fillOptions.startMs, fillOptions.endMs, fillOptions.bucketSeconds)
    : []

  for (const row of rows) {
    const bucket = normalizeBucket(row.bucket)
    bucketMap.set(bucket, {
      count: Number(row.count),
      avg_duration: Number(row.avgDuration),
      p50_duration: Number(row.p50Duration),
      p95_duration: Number(row.p95Duration),
      p99_duration: Number(row.p99Duration),
      error_rate: Number(row.errorRate),
      apdex: Number(row.apdexScore),
      sampled_span_count: Number(row.sampledSpanCount),
      unsampled_span_count: Number(row.unsampledSpanCount),
      sampling_weight: parseSamplingWeight(String(row.dominantThreshold ?? "")),
    })
    if (!fillOptions) {
      bucketOrder.push(bucket)
    }
  }

  if (fillOptions) {
    for (const bucket of bucketOrder) {
      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, { ...emptyMetrics })
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
  metric: Extract<QuerySpec, { metric: string }>["metric"],
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
  yield* validateListQuery(request, range)
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
    Effect.catchTag("@maple/http/errors/TinybirdQueryError", (error: TinybirdQueryError) =>
      Effect.fail(
        new QueryEngineExecutionError({
          message: `${context}: ${error.message}`,
          causeTag: error._tag,
          pipe: error.pipe,
        }),
      ),
    ),
  )

const truncateSql = (s: string, maxLen = 1000) =>
  s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

/** Compile a CHQuery, execute it via Tinybird SQL, and return typed rows. */
const executeCHQuery = <Output extends Record<string, any>, Params extends Record<string, any>>(
  tinybird: Pick<TinybirdServiceShape, "sqlQuery">,
  tenant: TenantContext,
  query: CH.CHQuery<any, Output>,
  params: Params,
  context: string,
): Effect.Effect<ReadonlyArray<Output>, QueryEngineExecutionError> => {
  const compiled = CH.compile(query, params)
  return mapTinybirdError(tinybird.sqlQuery(tenant, compiled.sql), context).pipe(
    Effect.map((rows) => compiled.castRows(rows)),
    Effect.tap((rows) => Effect.annotateCurrentSpan("result.rowCount", rows.length)),
    Effect.withSpan("QueryEngineService.executeCHQuery", {
      attributes: {
        "db.statement": truncateSql(compiled.sql),
        "query.context": context,
      },
    }),
  )
}

/** Compile a CHUnionQuery, execute it via Tinybird SQL, and return typed rows. */
const executeCHUnionQuery = <Output extends Record<string, any>, Params extends Record<string, any>>(
  tinybird: Pick<TinybirdServiceShape, "sqlQuery">,
  tenant: TenantContext,
  query: CH.CHUnionQuery<Output>,
  params: Params,
  context: string,
): Effect.Effect<ReadonlyArray<Output>, QueryEngineExecutionError> => {
  const compiled = CH.compileUnion(query, params)
  return mapTinybirdError(tinybird.sqlQuery(tenant, compiled.sql), context).pipe(
    Effect.map((rows) => compiled.castRows(rows)),
    Effect.tap((rows) => Effect.annotateCurrentSpan("result.rowCount", rows.length)),
    Effect.withSpan("QueryEngineService.executeCHUnionQuery", {
      attributes: {
        "db.statement": truncateSql(compiled.sql),
        "query.context": context,
      },
    }),
  )
}

type QueryEngineTinybird = Pick<
  TinybirdServiceShape,
  | "sqlQuery"
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
  metric: Extract<QuerySpec, { source: "traces"; metric: string }>["metric"],
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
    readonly avgValue?: number
    readonly minValue?: number
    readonly maxValue?: number
    readonly sumValue?: number
    readonly dataPointCount?: number
    readonly rateValue?: number
    readonly increaseValue?: number
  },
): number =>
  Match.value(metric).pipe(
    Match.when("avg", () => Number(row.avgValue)),
    Match.when("min", () => Number(row.minValue)),
    Match.when("max", () => Number(row.maxValue)),
    Match.when("sum", () => Number(row.sumValue)),
    Match.when("count", () => Number(row.dataPointCount)),
    Match.when("rate", () => Number(row.rateValue)),
    Match.when("increase", () => Number(row.increaseValue)),
    Match.exhaustive,
  )

const applyAlertReducer = (
  observations: ReadonlyArray<AlertObservation>,
  reducer: QueryEngineAlertReducer,
): number | null => {
  const values = Arr.filterMap(observations, (observation) =>
    observation.hasData && observation.value != null
      ? Result.succeed(observation.value as number)
      : Result.failVoid,
  )

  if (values.length === 0) {
    return null
  }

  return Match.value(reducer).pipe(
    Match.when("identity", () => Option.getOrNull(Arr.head(values))),
    Match.when("sum", () => Arr.reduce(values, 0, (sum, value) => sum + value)),
    Match.when("avg", () => Arr.reduce(values, 0, (sum, value) => sum + value) / values.length),
    Match.when("min", () => Math.min(...values)),
    Match.when("max", () => Math.max(...values)),
    Match.exhaustive,
  )
}

/** Map query engine source/scope to the MV's AttributeScope value. */
function resolveAttributeScope(
  source: "traces" | "logs" | "metrics",
  scope?: "span" | "resource",
): string {
  if (source === "metrics") return "metric"
  if (source === "logs") return scope === "resource" ? "resource" : "log"
  return scope === "resource" ? "resource" : "span"
}

type AttrFilterArray = Array<{
  key: string
  value?: string
  mode: "equals" | "exists" | "gt" | "gte" | "lt" | "lte" | "contains"
}>

function extractTracesOpts(filters: Record<string, unknown> | undefined) {
  return {
    serviceName: filters?.serviceName as string | undefined,
    spanName: filters?.spanName as string | undefined,
    rootOnly: filters?.rootSpansOnly as boolean | undefined,
    errorsOnly: filters?.errorsOnly as boolean | undefined,
    environments: filters?.environments as string[] | undefined,
    commitShas: filters?.commitShas as string[] | undefined,
    minDurationMs: filters?.minDurationMs as number | undefined,
    maxDurationMs: filters?.maxDurationMs as number | undefined,
    matchModes: filters?.matchModes as {
      serviceName?: "contains"
      spanName?: "contains"
      deploymentEnv?: "contains"
    } | undefined,
    attributeFilters: filters?.attributeFilters as AttrFilterArray | undefined,
    resourceAttributeFilters: filters?.resourceAttributeFilters as AttrFilterArray | undefined,
    groupByAttributeKeys: filters?.groupByAttributeKeys as string[] | undefined,
  }
}

/**
 * Map TracesFilters to the flat opts format expected by tracesFacetsQuery / tracesDurationStatsQuery.
 * TracesFilters stores http filters as attributeFilters entries; facets opts want them as top-level fields.
 */
function extractTracesFacetsOpts(filters: Record<string, unknown> | undefined): CH.TracesFacetsOpts {
  const attrFilters = (filters?.attributeFilters ?? []) as AttrFilterArray
  const resFilters = (filters?.resourceAttributeFilters ?? []) as AttrFilterArray

  const httpMethodFilter = attrFilters.find((f) => f.key === "http.method")
  const httpStatusFilter = attrFilters.find((f) => f.key === "http.status_code")
  const customAttr = attrFilters.find((f) => f.key !== "http.method" && f.key !== "http.status_code")
  const customRes = resFilters[0]

  const envs = filters?.environments as string[] | undefined

  return {
    serviceName: filters?.serviceName as string | undefined,
    spanName: filters?.spanName as string | undefined,
    hasError: filters?.errorsOnly as boolean | undefined,
    minDurationMs: filters?.minDurationMs as number | undefined,
    maxDurationMs: filters?.maxDurationMs as number | undefined,
    httpMethod: httpMethodFilter?.value,
    httpStatusCode: httpStatusFilter?.value,
    deploymentEnv: envs?.[0],
    matchModes: filters?.matchModes as CH.TracesFacetsOpts["matchModes"],
    attributeFilterKey: customAttr?.key,
    attributeFilterValue: customAttr?.value,
    attributeFilterValueMatchMode: customAttr?.mode === "contains" ? "contains" : undefined,
    resourceFilterKey: customRes?.key,
    resourceFilterValue: customRes?.value,
    resourceFilterValueMatchMode: customRes?.mode === "contains" ? "contains" : undefined,
  }
}

function extractTracesDurationStatsOpts(filters: Record<string, unknown> | undefined): CH.TracesDurationStatsOpts {
  const facetsOpts = extractTracesFacetsOpts(filters)
  return {
    serviceName: facetsOpts.serviceName,
    spanName: facetsOpts.spanName,
    hasError: facetsOpts.hasError,
    minDurationMs: facetsOpts.minDurationMs,
    maxDurationMs: facetsOpts.maxDurationMs,
    httpMethod: facetsOpts.httpMethod,
    httpStatusCode: facetsOpts.httpStatusCode,
    deploymentEnv: facetsOpts.deploymentEnv,
    matchModes: facetsOpts.matchModes,
  }
}

function shapeMetricsGroupRows<T extends { bucket: string | Date; serviceName: string; attributeValue: string }>(
  rows: ReadonlyArray<T>,
  valueExtractor: (row: T) => number,
  groupBy: readonly string[] | undefined,
  groupByAttributeKey: string | undefined,
  fillOptions: BucketFillOptions | undefined,
): Array<TimeseriesPoint> {
  if (groupBy?.includes("none") || !groupBy?.length) {
    return groupTimeSeriesRows(
      rows.map((row) => ({ bucket: row.bucket, groupName: "all" as const, value: valueExtractor(row) })),
      (r) => r.value,
      fillOptions,
    )
  }
  if (groupByAttributeKey) {
    return groupTimeSeriesRows(
      rows.map((row) => ({ bucket: row.bucket, groupName: row.attributeValue || "(empty)", value: valueExtractor(row) })),
      (r) => r.value,
      fillOptions,
    )
  }
  return groupTimeSeriesRows(
    rows.map((row) => ({ bucket: row.bucket, groupName: row.serviceName, value: valueExtractor(row) })),
    (r) => r.value,
    fillOptions,
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
    yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
    yield* Effect.annotateCurrentSpan("query.source", request.query.source)
    yield* Effect.annotateCurrentSpan("query.kind", request.query.kind)
    if ("metric" in request.query && request.query.metric) {
      yield* Effect.annotateCurrentSpan("query.metric", request.query.metric)
    }
    if ("filters" in request.query && request.query.filters) {
      const filters = request.query.filters as Record<string, unknown>
      if (filters.serviceName) yield* Effect.annotateCurrentSpan("query.filter.serviceName", String(filters.serviceName))
      if (filters.spanName) yield* Effect.annotateCurrentSpan("query.filter.spanName", String(filters.spanName))
      if (filters.metricName) yield* Effect.annotateCurrentSpan("query.filter.metricName", String(filters.metricName))
    }

    const range = yield* validateExecute(request)
    const bucketSeconds = request.query.kind === "timeseries"
      ? request.query.bucketSeconds ?? computeBucketSeconds(range.startMs, range.endMs)
      : undefined
    if (bucketSeconds) yield* Effect.annotateCurrentSpan("query.bucketSeconds", bucketSeconds)

    const fillOptions = bucketSeconds
      ? {
          startMs: range.startMs,
          endMs: range.endMs,
          bucketSeconds,
        }
      : undefined

    if (request.query.source === "traces" && request.query.kind === "timeseries") {
      const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)

      if (request.query.allMetrics) {
        const rows = yield* executeCHQuery(
          tinybird,
          tenant,
          CH.tracesTimeseriesQuery({
            ...opts,
            metric: request.query.metric,
            allMetrics: true,
            needsSampling: true,
            groupBy: request.query.groupBy as string[] | undefined,
            apdexThresholdMs: request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
          }),
          { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime, bucketSeconds: bucketSeconds! },
          "Failed to execute traces all-metrics timeseries query",
        )

        return new QueryEngineExecuteResponse({
          result: {
            kind: "timeseries",
            source: "traces",
            data: groupAllMetricsTimeSeriesRows(rows, fillOptions),
          },
        })
      }

      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.tracesTimeseriesQuery({
          ...opts,
          metric: request.query.metric,
          needsSampling: false,
          groupBy: request.query.groupBy as string[] | undefined,
          apdexThresholdMs: request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime, bucketSeconds: bucketSeconds! },
        "Failed to execute traces timeseries query",
      )

      const field = tracesMetricFieldMap[request.query.metric]
      return new QueryEngineExecuteResponse({
        result: {
          kind: "timeseries",
          source: "traces",
          data: groupTimeSeriesRows(rows, (row) => Number(row[field]), fillOptions),
        },
      })
    }

    if (request.query.source === "logs" && request.query.kind === "timeseries") {
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.logsTimeseriesQuery({
          serviceName: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          environments: request.query.filters?.environments,
          matchModes: request.query.filters?.deploymentEnvMatchMode
            ? { deploymentEnv: request.query.filters.deploymentEnvMatchMode }
            : undefined,
          groupBy: request.query.groupBy as string[] | undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime, bucketSeconds: bucketSeconds! },
        "Failed to execute logs timeseries query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "timeseries",
          source: "logs",
          data: groupTimeSeriesRows(rows, (row) => Number(row.count), fillOptions),
        },
      })
    }

    if (request.query.source === "metrics" && request.query.kind === "timeseries") {
      const groupByAttribute = request.query.groupBy?.includes("attribute")
      const groupByAttributeKey = groupByAttribute
        ? request.query.filters.groupByAttributeKey
        : undefined
      const attributeFilter = request.query.filters.attributeFilters?.[0]

      const isRateOrIncrease = request.query.metric === "rate" || request.query.metric === "increase"

      if (isRateOrIncrease) {
        const compiled = CH.compile(
          CH.metricsTimeseriesRateQuery({
            serviceName: request.query.filters.serviceName,
            groupByAttributeKey,
            attributeKey: attributeFilter?.key,
            attributeValue: attributeFilter?.value,
          }),
          {
            orgId: tenant.orgId,
            metricName: request.query.filters.metricName,
            startTime: request.startTime,
            endTime: request.endTime,
            bucketSeconds: bucketSeconds!,
          },
        )
        const rawRows = yield* mapTinybirdError(
          tinybird.sqlQuery(tenant, compiled.sql),
          "Failed to execute metrics rate/increase query",
        ).pipe(
          Effect.tap((rows) => Effect.annotateCurrentSpan("result.rowCount", rows.length)),
          Effect.withSpan("QueryEngineService.executeCHQuery", {
            attributes: {
              "db.statement": truncateSql(compiled.sql),
              "query.context": "metrics rate/increase query",
            },
          }),
        )
        const rateResult = compiled.castRows(rawRows)

        const rateValueField = request.query.metric === "rate" ? "rateValue" : "increaseValue"

        const data = shapeMetricsGroupRows(
          rateResult,
          (row) => Number(row[rateValueField]),
          request.query.groupBy,
          groupByAttributeKey,
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

      const result = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.metricsTimeseriesQuery({
          metricType: request.query.filters.metricType,
          serviceName: request.query.filters.serviceName,
          groupByAttributeKey,
          attributeKey: attributeFilter?.key,
          attributeValue: attributeFilter?.value,
        }),
        {
          orgId: tenant.orgId,
          metricName: request.query.filters.metricName,
          startTime: request.startTime,
          endTime: request.endTime,
          bucketSeconds: bucketSeconds!,
        },
        "Failed to execute metrics timeseries query",
      )

      const metricValueField = {
        avg: "avgValue",
        sum: "sumValue",
        min: "minValue",
        max: "maxValue",
        count: "dataPointCount",
      } as const
      const valueField = metricValueField[request.query.metric as keyof typeof metricValueField]

      const data = (request.query.groupBy?.includes("none") || !request.query.groupBy?.length)
        ? groupTimeSeriesRows(
            collapseMetricTimeseriesRows(result as Array<MetricTimeseriesRow>, request.query.metric),
            (row) => row.value,
            fillOptions,
          )
        : shapeMetricsGroupRows(
            result,
            (row) => Number(row[valueField]),
            request.query.groupBy,
            groupByAttributeKey,
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
      const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.tracesBreakdownQuery({
          ...opts,
          metric: request.query.metric,
          groupBy: request.query.groupBy,
          groupByAttributeKey:
            request.query.groupBy === "attribute"
              ? opts.groupByAttributeKeys?.[0]
              : undefined,
          limit: request.query.limit,
          apdexThresholdMs: request.query.metric === "apdex" ? request.query.apdexThresholdMs : undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        "Failed to execute traces breakdown query",
      )

      const field = tracesMetricFieldMap[request.query.metric]
      return new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "traces",
          data: rows.map((row) => ({
            name: row.name,
            value: Number(row[field]),
          })),
        },
      })
    }

    if (request.query.source === "logs" && request.query.kind === "breakdown") {
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.logsBreakdownQuery({
          groupBy: request.query.groupBy as "service" | "severity",
          serviceName: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          environments: request.query.filters?.environments,
          matchModes: request.query.filters?.deploymentEnvMatchMode
            ? { deploymentEnv: request.query.filters.deploymentEnvMatchMode }
            : undefined,
          limit: request.query.limit,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        "Failed to execute logs breakdown query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "logs",
          data: rows.map((row) => ({
            name: row.name,
            value: Number(row.count),
          })),
        },
      })
    }

    if (request.query.source === "metrics" && request.query.kind === "breakdown") {
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.metricsBreakdownQuery({
          metricType: request.query.filters.metricType,
          limit: request.query.limit,
        }),
        {
          orgId: tenant.orgId,
          metricName: request.query.filters.metricName,
          startTime: request.startTime,
          endTime: request.endTime,
        },
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
          data: rows.map((row) => ({
            name: row.name,
            value: Number(row[valueField]),
          })),
        },
      })
    }

    if (request.query.source === "traces" && request.query.kind === "list") {
      const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)

      // Graceful limit clamping: cap at 200, auto-reduce to 50 when no indexed filters
      const hasIndexedFilter = !!(opts.serviceName || opts.spanName || opts.errorsOnly || opts.rootOnly)
      const maxLimit = hasIndexedFilter ? 200 : 50
      const clampedLimit = Math.min(request.query.limit ?? 25, maxLimit)

      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.tracesListQuery({
          ...opts,
          limit: clampedLimit,
          offset: request.query.offset,
          columns: (request.query as { columns?: readonly string[] }).columns as string[] | undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        "Failed to execute traces list query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "list",
          source: "traces",
          data: rows.map((row) => ({
            traceId: row.traceId,
            timestamp: String(row.timestamp),
            spanId: row.spanId,
            serviceName: row.serviceName,
            spanName: row.spanName,
            durationMs: Number(row.durationMs),
            statusCode: row.statusCode,
            spanKind: row.spanKind,
            hasError: Number(row.hasError) === 1,
            spanAttributes: row.spanAttributes ?? {},
            resourceAttributes: row.resourceAttributes ?? {},
          })),
        },
      })
    }

    if (request.query.kind === "attributeKeys") {
      const scope = resolveAttributeScope(request.query.source, request.query.scope)
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.attributeKeysQuery({
          scope,
          limit: request.query.limit,
        }),
        {
          orgId: tenant.orgId,
          startTime: request.startTime,
          endTime: request.endTime,
        },
        "Failed to execute attribute keys query",
      )

      return new QueryEngineExecuteResponse({
        result: {
          kind: "attributeKeys",
          source: request.query.source,
          data: rows.map((row) => ({
            key: row.attributeKey,
            count: Number(row.usageCount),
          })),
        },
      })
    }

    // ---- Facets ----
    if (request.query.kind === "facets") {
      const baseParams = { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime }

      if (request.query.source === "traces") {
        const opts = extractTracesFacetsOpts(request.query.filters as Record<string, unknown> | undefined)
        const rows = yield* executeCHUnionQuery(
          tinybird, tenant, CH.tracesFacetsQuery(opts), baseParams,
          "Failed to execute traces facets query",
        )
        return new QueryEngineExecuteResponse({
          result: {
            kind: "facets", source: "traces",
            data: rows.map((row) => ({ facetType: row.facetType, name: row.name, count: Number(row.count) })),
          },
        })
      }

      if (request.query.source === "logs") {
        const filters = request.query.filters as Record<string, unknown> | undefined
        const envMatchMode = filters?.deploymentEnvMatchMode as "contains" | undefined
        const rows = yield* executeCHUnionQuery(
          tinybird, tenant,
          CH.logsFacetsQuery({
            serviceName: filters?.serviceName as string | undefined,
            severity: filters?.severity as string | undefined,
            environments: filters?.environments as readonly string[] | undefined,
            matchModes: envMatchMode ? { deploymentEnv: envMatchMode } : undefined,
          }),
          baseParams,
          "Failed to execute logs facets query",
        )
        return new QueryEngineExecuteResponse({
          result: {
            kind: "facets", source: "logs",
            data: rows.map((row) => ({
              facetType: row.facetType,
              name:
                row.facetType === "severity"
                  ? row.severityText
                  : row.facetType === "deploymentEnv"
                  ? row.deploymentEnv
                  : row.serviceName,
              count: Number(row.count),
            })),
          },
        })
      }

      if (request.query.source === "errors") {
        const filters = request.query.filters as Record<string, unknown> | undefined
        const rows = yield* executeCHUnionQuery(
          tinybird, tenant,
          CH.errorsFacetsQuery({
            rootOnly: filters?.rootOnly as boolean | undefined,
            services: filters?.services as string[] | undefined,
            deploymentEnvs: filters?.deploymentEnvs as string[] | undefined,
            errorTypes: filters?.errorTypes as string[] | undefined,
          }),
          baseParams,
          "Failed to execute errors facets query",
        )
        return new QueryEngineExecuteResponse({
          result: {
            kind: "facets", source: "errors",
            data: rows.map((row) => ({ facetType: row.facetType, name: row.name, count: Number(row.count) })),
          },
        })
      }

      if (request.query.source === "services") {
        const rows = yield* executeCHUnionQuery(
          tinybird, tenant, CH.servicesFacetsQuery(), baseParams,
          "Failed to execute services facets query",
        )
        return new QueryEngineExecuteResponse({
          result: {
            kind: "facets", source: "services",
            data: rows.map((row) => ({ facetType: row.facetType, name: row.name, count: Number(row.count) })),
          },
        })
      }
    }

    // ---- Stats ----
    if (request.query.source === "traces" && request.query.kind === "stats") {
      const opts = extractTracesDurationStatsOpts(request.query.filters as Record<string, unknown> | undefined)
      const rows = yield* executeCHQuery(
        tinybird, tenant, CH.tracesDurationStatsQuery(opts),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        "Failed to execute traces duration stats query",
      )
      const row = rows[0]
      return new QueryEngineExecuteResponse({
        result: {
          kind: "stats", source: "traces",
          data: row
            ? {
                minDurationMs: Number(row.minDurationMs),
                maxDurationMs: Number(row.maxDurationMs),
                p50DurationMs: Number(row.p50DurationMs),
                p95DurationMs: Number(row.p95DurationMs),
              }
            : { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 },
        },
      })
    }

    // ---- Attribute Values ----
    if (request.query.kind === "attributeValues") {
      const queryFn = request.query.scope === "resource"
        ? CH.resourceAttributeValuesQuery
        : CH.spanAttributeValuesQuery
      const rows = yield* executeCHQuery(
        tinybird, tenant,
        queryFn({ attributeKey: request.query.attributeKey, limit: request.query.limit }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        `Failed to execute ${request.query.scope} attribute values query`,
      )
      return new QueryEngineExecuteResponse({
        result: {
          kind: "attributeValues", source: "traces",
          data: rows.map((row) => ({ value: row.attributeValue, count: Number(row.usageCount) })),
        },
      })
    }

    // ---- Count ----
    if (request.query.source === "logs" && request.query.kind === "count") {
      const filters = request.query.filters as Record<string, unknown> | undefined
      const envMatchMode = filters?.deploymentEnvMatchMode as "contains" | undefined
      const rows = yield* executeCHQuery(
        tinybird, tenant,
        CH.logsCountQuery({
          serviceName: filters?.serviceName as string | undefined,
          severity: filters?.severity as string | undefined,
          traceId: filters?.traceId as string | undefined,
          search: filters?.search as string | undefined,
          environments: filters?.environments as readonly string[] | undefined,
          matchModes: envMatchMode ? { deploymentEnv: envMatchMode } : undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime },
        "Failed to execute logs count query",
      )
      return new QueryEngineExecuteResponse({
        result: {
          kind: "count", source: "logs",
          data: { total: rows[0] ? Number(rows[0].total) : 0 },
        },
      })
    }

    return yield* new QueryEngineValidationError({
      message: "Unsupported query",
      details: ["This source/kind combination is not supported"],
    })
  })

/**
 * Reduce per-bucket observations into a single GroupedAlertObservation per
 * group. Used by the unified alert `evaluate` path which executes the same
 * dashboard timeseries queries that widgets use, then collapses each group's
 * bucket series with the configured reducer.
 */
const reducePerGroupObservations = (
  byGroup: Map<string, Array<{ value: number | null; sampleCount: number; hasData: boolean }>>,
  reducer: QueryEngineAlertReducer,
): ReadonlyArray<GroupedAlertObservation> => {
  const result: Array<GroupedAlertObservation> = []
  for (const [groupKey, observations] of byGroup.entries()) {
    const reducedValue = applyAlertReducer(observations, reducer)
    const totalSampleCount = observations.reduce((sum, o) => sum + Number(o.sampleCount), 0)
    const hasData = observations.some((o) => o.hasData)
    result.push({
      groupKey,
      value: reducedValue,
      sampleCount: totalSampleCount,
      hasData,
    })
  }
  return result
}

/** Compose a JS-side composite group key for metrics, which doesn't emit groupName from SQL. */
const composeMetricsGroupKey = (
  groupBy: ReadonlyArray<string> | undefined,
  serviceName: string,
  attributeValue: string,
): string => {
  if (!groupBy || groupBy.length === 0 || groupBy.includes("none")) return "all"
  const parts: string[] = []
  for (const dim of groupBy) {
    if (dim === "service") parts.push(serviceName || "")
    else if (dim === "attribute") parts.push(attributeValue || "")
  }
  const filtered = parts.filter((p) => p.length > 0)
  if (filtered.length === 0) return "all"
  return filtered.join(" \u00b7 ")
}

export const makeQueryEngineEvaluate = (tinybird: QueryEngineTinybird) =>
  Effect.fn("QueryEngineService.evaluate")(function* (
    tenant: TenantContext,
    request: QueryEngineEvaluateRequest,
  ): Effect.fn.Return<
    ReadonlyArray<GroupedAlertObservation>,
    QueryEngineValidationError | QueryEngineExecutionError
  > {
    yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
    yield* Effect.annotateCurrentSpan("query.source", request.query.source)
    yield* Effect.annotateCurrentSpan("query.kind", request.query.kind)
    yield* Effect.annotateCurrentSpan("query.reducer", request.reducer)
    if ("metric" in request.query && request.query.metric) {
      yield* Effect.annotateCurrentSpan("query.metric", request.query.metric)
    }
    if ("groupBy" in request.query && request.query.groupBy) {
      yield* Effect.annotateCurrentSpan(
        "query.groupBy",
        (request.query.groupBy as ReadonlyArray<string>).join(","),
      )
    }

    yield* validateEvaluate(request)

    if (
      request.query.kind !== "timeseries" ||
      (request.query.source !== "traces" &&
        request.query.source !== "metrics" &&
        request.query.source !== "logs")
    ) {
      return yield* new QueryEngineValidationError({
        message: "Unsupported alert evaluation query",
        details: ["Alert evaluation supports traces, logs, and metrics timeseries queries only"],
      })
    }

    // Use the spec's bucketSeconds when present, otherwise auto-compute from
    // the time range — same as the dashboard execute path.
    const startMs = toEpochMs(request.startTime)
    const endMs = toEpochMs(request.endTime)
    const bucketSeconds = request.query.bucketSeconds ?? computeBucketSeconds(startMs, endMs)

    const byGroup = new Map<string, Array<{ value: number | null; sampleCount: number; hasData: boolean }>>()
    const pushObs = (
      groupKey: string,
      obs: { value: number | null; sampleCount: number; hasData: boolean },
    ) => {
      const list = byGroup.get(groupKey)
      if (list) list.push(obs)
      else byGroup.set(groupKey, [obs])
    }

    if (request.query.source === "traces") {
      const tracesQuery = request.query
      const opts = extractTracesOpts(request.query.filters as Record<string, unknown>)
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.tracesTimeseriesQuery({
          ...opts,
          metric: tracesQuery.metric,
          needsSampling: false,
          groupBy: tracesQuery.groupBy as readonly string[] | undefined,
          apdexThresholdMs: tracesQuery.metric === "apdex" ? tracesQuery.apdexThresholdMs : undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime, bucketSeconds },
        "Failed to evaluate traces alert query",
      )

      for (const row of rows) {
        const sampleCount = Number(row.count ?? 0)
        const value = sampleCount > 0 ? tracesAggregateValueForMetric(tracesQuery.metric, row) : null
        pushObs(row.groupName || "all", {
          value,
          sampleCount,
          hasData: sampleCount > 0,
        })
      }
    } else if (request.query.source === "logs") {
      const logsQuery = request.query
      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.logsTimeseriesQuery({
          serviceName: request.query.filters?.serviceName,
          severity: request.query.filters?.severity,
          environments: request.query.filters?.environments,
          matchModes: request.query.filters?.deploymentEnvMatchMode
            ? { deploymentEnv: request.query.filters.deploymentEnvMatchMode }
            : undefined,
          groupBy: logsQuery.groupBy as readonly string[] | undefined,
        }),
        { orgId: tenant.orgId, startTime: request.startTime, endTime: request.endTime, bucketSeconds },
        "Failed to evaluate logs alert query",
      )

      for (const row of rows) {
        const sampleCount = Number(row.count ?? 0)
        pushObs(row.groupName || "all", {
          value: sampleCount > 0 ? sampleCount : null,
          sampleCount,
          hasData: sampleCount > 0,
        })
      }
    } else {
      const metricsQuery = request.query
      const groupByAttribute = metricsQuery.groupBy?.includes("attribute")
      const groupByAttributeKey = groupByAttribute
        ? metricsQuery.filters.groupByAttributeKey
        : undefined

      const rows = yield* executeCHQuery(
        tinybird,
        tenant,
        CH.metricsTimeseriesQuery({
          metricType: metricsQuery.filters.metricType,
          serviceName: metricsQuery.filters.serviceName,
          groupByAttributeKey,
        }),
        {
          orgId: tenant.orgId,
          metricName: metricsQuery.filters.metricName,
          startTime: request.startTime,
          endTime: request.endTime,
          bucketSeconds,
        },
        "Failed to evaluate metrics alert query",
      )

      for (const row of rows) {
        const sampleCount = Number(row.dataPointCount ?? 0)
        const value = sampleCount > 0 ? metricsAggregateValueForMetric(metricsQuery.metric, row) : null
        const groupKey = composeMetricsGroupKey(
          metricsQuery.groupBy as readonly string[] | undefined,
          row.serviceName ?? "",
          row.attributeValue ?? "",
        )
        pushObs(groupKey, {
          value,
          sampleCount,
          hasData: sampleCount > 0,
        })
      }
    }

    // When the query is ungrouped (or returned no rows) ensure we still emit
    // a single "all" observation with hasData=false so the alert engine can
    // apply its no-data behavior.
    if (byGroup.size === 0) {
      byGroup.set("all", [{ value: null, sampleCount: 0, hasData: false }])
    }

    const result = reducePerGroupObservations(byGroup, request.reducer)
    yield* Effect.annotateCurrentSpan("result.groupCount", result.length)
    return result
  })

export class QueryEngineService extends Context.Service<QueryEngineService, QueryEngineServiceShape>()("QueryEngineService", {
  make: Effect.gen(function* () {
    const tinybird = yield* TinybirdService
    const edgeCache = yield* EdgeCacheService
    const executeImpl = makeQueryEngineExecute(tinybird)
    const evaluateImpl = makeQueryEngineEvaluate(tinybird)

    const recordCacheOutcome = (hit: boolean) =>
      Metric.update(
        hit ? QueryEngineMetrics.cacheHitsTotal : QueryEngineMetrics.cacheMissesTotal,
        1,
      )

    const execute = (tenant: TenantContext, request: QueryEngineExecuteRequest) =>
      withTimeout(
        Effect.gen(function* () {
          const startMs = Date.now()
          const key = buildCacheKey(tenant.orgId, request)
          const { value, hit } = yield* edgeCache.getOrCompute<
            QueryEngineExecuteResponse,
            QueryEngineValidationError | QueryEngineExecutionError | QueryEngineTimeoutError,
            never
          >(
            { bucket: "qe-execute", key, ttlSeconds: 15 },
            executeImpl(tenant, request),
          )
          yield* recordCacheOutcome(hit)
          yield* Effect.annotateCurrentSpan("cache.hit", hit)
          yield* Metric.update(QueryEngineMetrics.executeDurationMs, Date.now() - startMs)
          return value
        }).pipe(
          Effect.withSpan("QueryEngineService.cachedExecute", {
            attributes: { orgId: tenant.orgId },
          }),
        ),
      )

    const cachedEvaluate = (tenant: TenantContext, request: QueryEngineEvaluateRequest) =>
      withTimeout(
        Effect.gen(function* () {
          const key = buildEvaluateCacheKey(tenant.orgId, request)
          const { value, hit } = yield* edgeCache.getOrCompute<
            ReadonlyArray<GroupedAlertObservation>,
            QueryEngineValidationError | QueryEngineExecutionError | QueryEngineTimeoutError,
            never
          >(
            { bucket: "qe-evaluate", key, ttlSeconds: 30 },
            evaluateImpl(tenant, request),
          )
          yield* recordCacheOutcome(hit)
          yield* Effect.annotateCurrentSpan("cache.hit", hit)
          return value
        }).pipe(
          Effect.withSpan("QueryEngineService.cachedEvaluate", {
            attributes: { orgId: tenant.orgId },
          }),
        ),
      )

    const cachedDirect = <A>(
      tenant: TenantContext,
      routeName: string,
      payload: unknown,
      effect: Effect.Effect<A, QueryEngineExecutionError>,
    ): Effect.Effect<A, QueryEngineExecutionError> =>
      withTimeout(
        Effect.gen(function* () {
          const startMs = Date.now()
          const key = buildDirectRouteCacheKey(tenant.orgId, routeName, payload)
          const { value, hit } = yield* edgeCache.getOrCompute<
            A,
            QueryEngineExecutionError,
            never
          >(
            { bucket: "qe-direct", key, ttlSeconds: 15 },
            effect,
          )
          yield* recordCacheOutcome(hit)
          yield* Effect.annotateCurrentSpan("cache.hit", hit)
          yield* Metric.update(QueryEngineMetrics.executeDurationMs, Date.now() - startMs)
          return value
        }).pipe(
          Effect.withSpan("QueryEngineService.cachedDirect", {
            attributes: { orgId: tenant.orgId, routeName },
          }),
        ),
      ).pipe(
        Effect.catchTag("@maple/http/errors/QueryEngineTimeoutError", (error) =>
          Effect.fail(
            new QueryEngineExecutionError({
              message: error.message,
              causeTag: error._tag,
            }),
          ),
        ),
      )

    return {
      execute,
      evaluate: cachedEvaluate,
      cachedDirect,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
