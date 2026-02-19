import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest, type QuerySpec } from "@maple/domain"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { formatForTinybird } from "@/lib/time-utils"
import {
  buildFormulaResults,
  type FormulaDraft,
  type QueryRunResult,
  type TimeseriesPoint,
} from "@/components/query-builder/formula-results"
import {
  buildTimeseriesQuerySpec,
  type QueryBuilderMetricType,
} from "@/lib/query-builder/model"
import {
  decodeInput,
  type TinybirdApiError,
  TinybirdApiError as TinybirdApiErrorClass,
} from "@/api/tinybird/effect-utils"

const dateTimeString = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
)

const METRIC_TYPES_TUPLE = [
  "sum",
  "gauge",
  "histogram",
  "exponential_histogram",
] as const

const COMPARISON_MODES = ["none", "previous_period"] as const

const DEFAULT_STRATEGY = {
  enableEmptyRangeFallback: true,
  fallbackWindowSeconds: [24 * 60 * 60, 7 * 24 * 60 * 60, 31 * 24 * 60 * 60],
  maxFallbackRangeSeconds: 31 * 24 * 60 * 60,
} as const

const QueryDraftSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  dataSource: Schema.Literal("traces", "logs", "metrics"),
  signalSource: Schema.Literal("default", "meter"),
  metricName: Schema.String,
  metricType: Schema.Literal(...METRIC_TYPES_TUPLE),
  whereClause: Schema.String,
  aggregation: Schema.String,
  stepInterval: Schema.String,
  orderByDirection: Schema.Literal("desc", "asc"),
  addOns: Schema.Struct({
    groupBy: Schema.Boolean,
    having: Schema.Boolean,
    orderBy: Schema.Boolean,
    limit: Schema.Boolean,
    legend: Schema.Boolean,
  }),
  groupBy: Schema.String,
  having: Schema.String,
  orderBy: Schema.String,
  limit: Schema.String,
  legend: Schema.String,
})

const FormulaSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  expression: Schema.String,
  legend: Schema.String,
})

const ComparisonSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literal(...COMPARISON_MODES)),
  includePercentChange: Schema.optional(Schema.Boolean),
})

const StrategySchema = Schema.Struct({
  enableEmptyRangeFallback: Schema.optional(Schema.Boolean),
  fallbackWindowSeconds: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)))),
  ),
  maxFallbackRangeSeconds: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
})

const QueryBuilderTimeseriesInputSchema = Schema.Struct({
  startTime: dateTimeString,
  endTime: dateTimeString,
  queries: Schema.mutable(Schema.Array(QueryDraftSchema)),
  formulas: Schema.optional(Schema.mutable(Schema.Array(FormulaSchema))),
  comparison: Schema.optional(ComparisonSchema),
  strategy: Schema.optional(StrategySchema),
  debug: Schema.optional(Schema.Boolean),
})

export type QueryBuilderTimeseriesInput = Schema.Schema.Type<typeof QueryBuilderTimeseriesInputSchema>

interface QueryExecutionAttempt {
  startTime: string
  endTime: string
  kind: "primary" | "fallback"
  points: number
  hasSeries: boolean
  error?: string
}

interface QueryExecutionDebug {
  queryId: string
  queryName: string
  source: string
  spec: QuerySpec | null
  attempts: QueryExecutionAttempt[]
  fallbackUsed: boolean
}

interface QueryBuilderTimeseriesDebug {
  primaryWindow: {
    startTime: string
    endTime: string
  }
  comparison: {
    mode: "none" | "previous_period"
    includePercentChange: boolean
    shiftedByMs: number
    previousStartTime: string | null
    previousEndTime: string | null
  }
  strategy: {
    enableEmptyRangeFallback: boolean
    fallbackWindowSeconds: number[]
    maxFallbackRangeSeconds: number
  }
  queries: QueryExecutionDebug[]
  previousQueries: QueryExecutionDebug[]
}

export interface QueryBuilderTimeseriesResponse {
  data: Array<Record<string, string | number>>
  debug?: QueryBuilderTimeseriesDebug
}

const decodeQueryEngineRequest = Schema.decodeUnknownSync(QueryEngineExecuteRequest)
const toEpochMs = (value: string): number => new Date(value.replace(" ", "T") + "Z").getTime()

function computeAutoBucketSeconds(startTime: string, endTime: string): number {
  const startMs = toEpochMs(startTime)
  const endMs = toEpochMs(endTime)
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 60
  }

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

function resolveTimeseriesBucketSpec(spec: QuerySpec, startTime: string, endTime: string): QuerySpec {
  if (spec.kind !== "timeseries" || spec.bucketSeconds) {
    return spec
  }

  return {
    ...spec,
    bucketSeconds: computeAutoBucketSeconds(startTime, endTime),
  } satisfies QuerySpec
}

function resolveExecutionSpecForWindow(
  spec: QuerySpec,
  window: { startTime: string; endTime: string; kind: "primary" | "fallback" },
): QuerySpec {
  const resolved = resolveTimeseriesBucketSpec(spec, window.startTime, window.endTime)
  if (resolved.kind !== "timeseries") {
    return resolved
  }

  if (window.kind !== "fallback") {
    return resolved
  }

  const autoBucketSeconds = computeAutoBucketSeconds(window.startTime, window.endTime)
  const selectedBucketSeconds = Math.max(resolved.bucketSeconds ?? autoBucketSeconds, autoBucketSeconds)
  return {
    ...resolved,
    bucketSeconds: selectedBucketSeconds,
  }
}

function hasAnySeriesData(points: TimeseriesPoint[]): boolean {
  return points.some((point) => Object.keys(point.series).length > 0)
}

function countSuccessfulQuerySeries(results: QueryRunResult[]): number {
  return results.filter(
    (result) => result.status === "success" && hasAnySeriesData(result.data),
  ).length
}

function noQueryDataMessage(queryResults: QueryRunResult[]): string {
  const firstQueryError = queryResults.find(
    (result) => typeof result.error === "string" && result.error.length > 0,
  )?.error

  return firstQueryError ?? "No query data found in selected time range"
}

function shiftBucket(bucket: string, offsetMs: number): string {
  const parsed = new Date(bucket).getTime()
  if (Number.isNaN(parsed)) {
    return bucket
  }

  return new Date(parsed + offsetMs).toISOString()
}

function shiftResultPoints(points: TimeseriesPoint[], offsetMs: number): TimeseriesPoint[] {
  return points.map((point) => ({
    bucket: shiftBucket(point.bucket, offsetMs),
    series: { ...point.series },
  }))
}

function resolveStrategy(
  input: QueryBuilderTimeseriesInput,
): {
  enableEmptyRangeFallback: boolean
  fallbackWindowSeconds: number[]
  maxFallbackRangeSeconds: number
} {
  const uniqueWindows = new Set(
    (input.strategy?.fallbackWindowSeconds ?? DEFAULT_STRATEGY.fallbackWindowSeconds).filter(
      (seconds) => Number.isFinite(seconds) && seconds > 0,
    ),
  )

  return {
    enableEmptyRangeFallback:
      input.strategy?.enableEmptyRangeFallback ?? DEFAULT_STRATEGY.enableEmptyRangeFallback,
    fallbackWindowSeconds: [...uniqueWindows].sort((left, right) => left - right),
    maxFallbackRangeSeconds:
      input.strategy?.maxFallbackRangeSeconds ?? DEFAULT_STRATEGY.maxFallbackRangeSeconds,
  }
}

function buildExecutionWindows(
  startTime: string,
  endTime: string,
  strategy: ReturnType<typeof resolveStrategy>,
  allowFallback: boolean,
): Array<{ startTime: string; endTime: string; kind: "primary" | "fallback" }> {
  const startMs = toEpochMs(startTime)
  const endMs = toEpochMs(endTime)
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return [{ startTime, endTime, kind: "primary" }]
  }

  const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
  const windows: Array<{ startTime: string; endTime: string; kind: "primary" | "fallback" }> = [
    { startTime, endTime, kind: "primary" },
  ]

  if (!allowFallback || !strategy.enableEmptyRangeFallback) {
    return windows
  }

  const seen = new Set([`${startTime}|${endTime}`])
  for (const seconds of strategy.fallbackWindowSeconds) {
    if (seconds <= rangeSeconds || seconds > strategy.maxFallbackRangeSeconds) {
      continue
    }

    const windowStartMs = endMs - seconds * 1000
    const nextStart = formatForTinybird(new Date(windowStartMs))
    const nextEnd = formatForTinybird(new Date(endMs))
    const key = `${nextStart}|${nextEnd}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    windows.push({
      startTime: nextStart,
      endTime: nextEnd,
      kind: "fallback",
    })
  }

  return windows
}

async function executeTimeseriesQuery(
  startTime: string,
  endTime: string,
  spec: QuerySpec,
): Promise<TimeseriesPoint[]> {
  const payload = decodeQueryEngineRequest({
    startTime,
    endTime,
    query: spec,
  })

  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* MapleApiAtomClient
      return yield* client.queryEngine.execute({ payload })
    }).pipe(Effect.provide(MapleApiAtomClient.layer)),
  )

  if (response.result.kind !== "timeseries") {
    return Promise.reject(new Error("Unexpected non-timeseries result"))
  }

  return response.result.data.map((point) => ({
    bucket: point.bucket,
    series: { ...point.series },
  }))
}

async function executeTimeseriesQueryWithFallback(
  startTime: string,
  endTime: string,
  spec: QuerySpec,
  strategy: ReturnType<typeof resolveStrategy>,
  allowFallback: boolean,
): Promise<{
  points: TimeseriesPoint[]
  attempts: QueryExecutionAttempt[]
  fallbackUsed: boolean
}> {
  return executeTimeseriesQueryWithFallbackUsing(
    startTime,
    endTime,
    spec,
    strategy,
    allowFallback,
    executeTimeseriesQuery,
  )
}

async function executeTimeseriesQueryWithFallbackUsing(
  startTime: string,
  endTime: string,
  spec: QuerySpec,
  strategy: ReturnType<typeof resolveStrategy>,
  allowFallback: boolean,
  executeFn: (
    startTime: string,
    endTime: string,
    spec: QuerySpec,
  ) => Promise<TimeseriesPoint[]>,
): Promise<{
  points: TimeseriesPoint[]
  attempts: QueryExecutionAttempt[]
  fallbackUsed: boolean
}> {
  const windows = buildExecutionWindows(startTime, endTime, strategy, allowFallback)
  const attempts: QueryExecutionAttempt[] = []
  let lastPoints: TimeseriesPoint[] = []

  for (const [index, window] of windows.entries()) {
    const windowSpec = resolveExecutionSpecForWindow(spec, window)

    try {
      const points = await executeFn(window.startTime, window.endTime, windowSpec)
      const hasSeries = hasAnySeriesData(points)

      attempts.push({
        startTime: window.startTime,
        endTime: window.endTime,
        kind: window.kind,
        points: points.length,
        hasSeries,
      })
      lastPoints = points

      if (hasSeries) {
        return {
          points,
          attempts,
          fallbackUsed: index > 0,
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Query execution failed"

      attempts.push({
        startTime: window.startTime,
        endTime: window.endTime,
        kind: window.kind,
        points: 0,
        hasSeries: false,
        error: message,
      })

      if (window.kind === "primary") {
        return Promise.reject(error)
      }
    }
  }

  return {
    points: lastPoints,
    attempts,
    fallbackUsed: false,
  }
}

function toDisplayNameById(
  entries: Array<{ id: string; name: string; legend: string }>
): Map<string, string> {
  const map = new Map<string, string>()

  for (const entry of entries) {
    const trimmedLegend = entry.legend.trim()
    map.set(entry.id, trimmedLegend || entry.name)
  }

  return map
}

function toSeriesDescriptor(
  result: QueryRunResult,
  displayName: string,
  rawGroupName: string,
): {
  stableGroupKey: string
  seriesLabel: string
} {
  const normalizedGroupName = rawGroupName.trim() || "unnamed"
  const isAllGroup = normalizedGroupName.toLowerCase() === "all"
  const isFormulaSelfNamed =
    result.source === "formula" && normalizedGroupName === displayName

  if (isAllGroup || isFormulaSelfNamed) {
    return {
      stableGroupKey: "__all__",
      seriesLabel: displayName,
    }
  }

  return {
    stableGroupKey: normalizedGroupName,
    seriesLabel: `${displayName}: ${normalizedGroupName}`,
  }
}

function mergeQueryRunResults(
  results: QueryRunResult[],
  displayNameById: Map<string, string>,
  options?: {
    seriesSuffix?: string
    usedSeriesNames?: Set<string>
  },
): {
  rowsByBucket: Map<string, Record<string, string | number>>
  seriesNameByStableKey: Map<string, string>
  seriesNames: string[]
} {
  const rowsByBucket = new Map<string, Record<string, string | number>>()
  const usedSeriesNames = options?.usedSeriesNames ?? new Set<string>()
  const seriesNameByStableKey = new Map<string, string>()
  const seriesNames: string[] = []
  const suffix = options?.seriesSuffix ?? ""

  const uniqueName = (base: string): string => {
    if (!usedSeriesNames.has(base)) {
      usedSeriesNames.add(base)
      return base
    }

    let suffix = 2
    while (usedSeriesNames.has(`${base} (${suffix})`)) {
      suffix += 1
    }

    const next = `${base} (${suffix})`
    usedSeriesNames.add(next)
    return next
  }

  for (const result of results) {
    if (result.status !== "success") {
      continue
    }

    if (result.data.length === 0 || !hasAnySeriesData(result.data)) {
      continue
    }

    const preferredName = displayNameById.get(result.queryId) ?? result.queryName

    for (const point of result.data) {
      const row = rowsByBucket.get(point.bucket) ?? { bucket: point.bucket }
      if (Object.keys(point.series).length > 0) {
        for (const [groupName, rawValue] of Object.entries(point.series)) {
          const value =
            typeof rawValue === "number" ? rawValue : Number(rawValue)
          if (!Number.isFinite(value)) {
            continue
          }

          const descriptor = toSeriesDescriptor(
            result,
            preferredName,
            groupName,
          )
          const stableKey = `${result.queryId}::${descriptor.stableGroupKey}`
          let seriesName = seriesNameByStableKey.get(stableKey)

          if (!seriesName) {
            seriesName = uniqueName(`${descriptor.seriesLabel}${suffix}`)
            seriesNameByStableKey.set(stableKey, seriesName)
            seriesNames.push(seriesName)
          }

          row[seriesName] = value
        }
      }
      rowsByBucket.set(point.bucket, row)
    }
  }

  for (const row of rowsByBucket.values()) {
    for (const seriesName of seriesNames) {
      if (typeof row[seriesName] !== "number") {
        row[seriesName] = 0
      }
    }
  }

  return {
    rowsByBucket,
    seriesNameByStableKey,
    seriesNames,
  }
}

function combineRows(
  mergedSets: Array<{
    rowsByBucket: Map<string, Record<string, string | number>>
    seriesNames: string[]
  }>,
): Array<Record<string, string | number>> {
  const rowsByBucket = new Map<string, Record<string, string | number>>()
  const allSeriesNames = new Set<string>()

  for (const merged of mergedSets) {
    for (const seriesName of merged.seriesNames) {
      allSeriesNames.add(seriesName)
    }

    for (const [bucket, row] of merged.rowsByBucket.entries()) {
      const existing = rowsByBucket.get(bucket) ?? { bucket }
      rowsByBucket.set(bucket, { ...existing, ...row })
    }
  }

  for (const row of rowsByBucket.values()) {
    for (const seriesName of allSeriesNames) {
      if (typeof row[seriesName] !== "number") {
        row[seriesName] = 0
      }
    }
  }

  return [...rowsByBucket.values()].sort((left, right) =>
    String(left.bucket).localeCompare(String(right.bucket)),
  )
}

function appendPercentChangeSeries(
  rows: Array<Record<string, string | number>>,
  currentSeriesByStableKey: Map<string, string>,
  previousSeriesByStableKey: Map<string, string>,
): void {
  for (const [stableKey, currentSeriesName] of currentSeriesByStableKey.entries()) {
    const previousSeriesName = previousSeriesByStableKey.get(stableKey)
    if (!previousSeriesName) {
      continue
    }

    const deltaSeriesName = `${currentSeriesName} (%Δ)`
    for (const row of rows) {
      const current = row[currentSeriesName]
      const previous = row[previousSeriesName]

      const currentValue =
        typeof current === "number" && Number.isFinite(current) ? current : 0
      const previousValue =
        typeof previous === "number" && Number.isFinite(previous) ? previous : 0

      row[deltaSeriesName] =
        previousValue === 0
          ? 0
          : ((currentValue - previousValue) / Math.abs(previousValue)) * 100
    }
  }
}

async function runQueryWindow(
  startTime: string,
  endTime: string,
  enabledQueries: QueryBuilderTimeseriesInput["queries"],
  formulas: FormulaDraft[],
  strategy: ReturnType<typeof resolveStrategy>,
  allowFallback: boolean,
): Promise<{
  queryResults: QueryRunResult[]
  allResults: QueryRunResult[]
  debug: QueryExecutionDebug[]
}> {
  const debug: QueryExecutionDebug[] = []

  const queryResults = await Promise.all(
    enabledQueries.map(async (query): Promise<QueryRunResult> => {
      const built = buildTimeseriesQuerySpec({
        ...query,
        metricType: query.metricType as QueryBuilderMetricType,
      })

      if (!built.query) {
        debug.push({
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          spec: null,
          attempts: [],
          fallbackUsed: false,
        })

        return {
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          status: "error",
          error: built.error ?? "Failed to build query",
          warnings: built.warnings,
          data: [],
        }
      }

      const querySpec = resolveTimeseriesBucketSpec(built.query, startTime, endTime)

      try {
        const execution = await executeTimeseriesQueryWithFallback(
          startTime,
          endTime,
          querySpec,
          strategy,
          allowFallback,
        )
        debug.push({
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          spec: querySpec,
          attempts: execution.attempts,
          fallbackUsed: execution.fallbackUsed,
        })

        const warnings = [...built.warnings]
        if (execution.fallbackUsed) {
          const selectedAttempt = execution.attempts[execution.attempts.length - 1]
          warnings.push(
            `No data in requested range; used fallback window ${selectedAttempt.startTime} -> ${selectedAttempt.endTime}`,
          )
        }

        return {
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          status: "success",
          error: null,
          warnings,
          data: execution.points,
        }
      } catch (error) {
        debug.push({
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          spec: querySpec,
          attempts: [],
          fallbackUsed: false,
        })

        return {
          queryId: query.id,
          queryName: query.name,
          source: query.dataSource,
          status: "error",
          error: error instanceof Error ? error.message : "Query execution failed",
          warnings: built.warnings,
          data: [],
        }
      }
    }),
  )

  const formulaResults =
    countSuccessfulQuerySeries(queryResults) > 0
      ? buildFormulaResults(formulas, queryResults)
      : []
  return {
    queryResults,
    allResults: [...queryResults, ...formulaResults],
    debug,
  }
}

function shiftRunResults(results: QueryRunResult[], shiftMs: number): QueryRunResult[] {
  return results.map((result) => ({
    ...result,
    data: shiftResultPoints(result.data, shiftMs),
  }))
}

export const __testables = {
  computeAutoBucketSeconds,
  resolveTimeseriesBucketSpec,
  resolveExecutionSpecForWindow,
  buildExecutionWindows,
  resolveStrategy,
  executeTimeseriesQueryWithFallbackUsing,
  noQueryDataMessage,
  countSuccessfulQuerySeries,
  mergeQueryRunResults,
  appendPercentChangeSeries,
}

async function getQueryBuilderTimeseriesInternal(
  input: QueryBuilderTimeseriesInput,
): Promise<QueryBuilderTimeseriesResponse> {

  const formulas: FormulaDraft[] = (input.formulas ?? []).map((formula) => ({
    id: formula.id,
    name: formula.name,
    expression: formula.expression,
    legend: formula.legend,
  }))
  const strategy = resolveStrategy(input)
  const comparison = {
    mode: input.comparison?.mode ?? "none",
    includePercentChange: input.comparison?.includePercentChange ?? true,
  } as const

  const enabledQueries = input.queries.filter((query) => query.enabled)
  if (enabledQueries.length === 0) {
    throw new Error("No enabled queries to run")
  }

  try {
    const currentWindow = await runQueryWindow(
      input.startTime,
      input.endTime,
      enabledQueries,
      formulas,
      strategy,
      true,
    )
    const successfulQueryCount = countSuccessfulQuerySeries(currentWindow.queryResults)
    if (successfulQueryCount === 0) {
      throw new Error(noQueryDataMessage(currentWindow.queryResults))
    }

    const allResults = currentWindow.allResults

    const successfulCount = allResults.filter(
      (result) => result.status === "success" && hasAnySeriesData(result.data),
    ).length

    if (successfulCount === 0) {
      const firstError = allResults.find((result) => result.error)?.error
      throw new Error(firstError ?? "No successful query results")
    }

    const displayNameById = toDisplayNameById([
      ...enabledQueries,
      ...formulas.map((formula) => ({
        id: formula.id,
        name: formula.name,
        legend: formula.legend,
      })),
    ])
    const usedSeriesNames = new Set<string>()
    const mergedCurrent = mergeQueryRunResults(allResults, displayNameById, {
      usedSeriesNames,
    })
    const mergedSets = [mergedCurrent]
    let mergedPrevious:
      | {
          rowsByBucket: Map<string, Record<string, string | number>>
          seriesNameByStableKey: Map<string, string>
          seriesNames: string[]
        }
      | null = null

    const startMs = toEpochMs(input.startTime)
    const endMs = toEpochMs(input.endTime)
    const shiftMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : 0
    let previousStartTime: string | null = null
    let previousEndTime: string | null = null
    let previousDebug: QueryExecutionDebug[] = []

    if (comparison.mode === "previous_period" && shiftMs > 0) {
      previousStartTime = formatForTinybird(new Date(startMs - shiftMs))
      previousEndTime = formatForTinybird(new Date(endMs - shiftMs))

      const previousWindow = await runQueryWindow(
        previousStartTime,
        previousEndTime,
        enabledQueries,
        formulas,
        strategy,
        false,
      )
      previousDebug = previousWindow.debug

      const shiftedPreviousResults = shiftRunResults(previousWindow.allResults, shiftMs)
      mergedPrevious = mergeQueryRunResults(shiftedPreviousResults, displayNameById, {
        seriesSuffix: " (prev)",
        usedSeriesNames,
      })
      mergedSets.push(mergedPrevious)
    }

    const mergedRows = combineRows(mergedSets)
    if (
      comparison.mode === "previous_period" &&
      comparison.includePercentChange &&
      mergedPrevious
    ) {
      appendPercentChangeSeries(
        mergedRows,
        mergedCurrent.seriesNameByStableKey,
        mergedPrevious.seriesNameByStableKey,
      )
    }

    const debugInfo: QueryBuilderTimeseriesDebug = {
      primaryWindow: {
        startTime: input.startTime,
        endTime: input.endTime,
      },
      comparison: {
        mode: comparison.mode,
        includePercentChange: comparison.includePercentChange,
        shiftedByMs: shiftMs > 0 ? shiftMs : 0,
        previousStartTime,
        previousEndTime,
      },
      strategy: {
        enableEmptyRangeFallback: strategy.enableEmptyRangeFallback,
        fallbackWindowSeconds: strategy.fallbackWindowSeconds,
        maxFallbackRangeSeconds: strategy.maxFallbackRangeSeconds,
      },
      queries: currentWindow.debug,
      previousQueries: previousDebug,
    }

    if (input.debug === true) {
      console.info("[QueryBuilder] timeseries execution", debugInfo)
    }

    return {
      data: mergedRows,
      ...(input.debug === true ? { debug: debugInfo } : {}),
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to fetch query-builder timeseries")
  }
}

export function getQueryBuilderTimeseries({
  data,
}: {
  data: QueryBuilderTimeseriesInput
}): Effect.Effect<QueryBuilderTimeseriesResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(
      QueryBuilderTimeseriesInputSchema,
      data,
      "getQueryBuilderTimeseries",
    )

    return yield* Effect.tryPromise({
      try: () => getQueryBuilderTimeseriesInternal(input),
      catch: (cause) =>
        new TinybirdApiErrorClass({
          operation: "getQueryBuilderTimeseries",
          stage: "query",
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to fetch query-builder timeseries",
          cause,
        }),
    })
  })
}
