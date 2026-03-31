import { Effect } from "effect"
import { TinybirdExecutor, ObservabilityError, type TinybirdExecutorShape } from "./TinybirdExecutor"
import type { SearchTracesInput, SearchTracesOutput, SpanResult } from "./types"
import { escapeForSQL } from "./sql-utils"

/**
 * Search for spans matching the given criteria.
 *
 * When `spanName` is provided (and `rootOnly` is not true), queries the raw
 * `traces` table directly to find matching spans. This avoids the unreliable
 * EXISTS subquery in the `list_traces` pipe and returns the **matched span**
 * data instead of root span summaries.
 *
 * When searching by root-level fields only (service, error, duration), falls
 * back to the `list_traces` Tinybird pipe for fast MV-backed queries.
 */
export const searchTraces = (
  input: SearchTracesInput,
): Effect.Effect<SearchTracesOutput, ObservabilityError, TinybirdExecutor> =>
  Effect.gen(function* () {
    const executor = yield* TinybirdExecutor
    const limit = input.limit ?? 20
    const offset = input.offset ?? 0

    // Span-level search: query raw traces table via SQL
    if (input.spanName && !input.rootOnly) {
      const spans = yield* spanLevelSearch(executor, input, limit, offset)
      return {
        timeRange: input.timeRange,
        spans,
        pagination: { offset, limit, hasMore: spans.length === limit },
      }
    }

    // Root-level search: use list_traces pipe (MV-backed, fast)
    const result = yield* rootLevelSearch(executor, input, limit, offset)
    return {
      timeRange: input.timeRange,
      spans: result,
      pagination: { offset, limit, hasMore: result.length === limit },
    }
  })

/**
 * Query the raw `traces` table directly for span-level filtering.
 * Returns matched span data, not root span summaries.
 */
const spanLevelSearch = (
  executor: TinybirdExecutorShape,
  input: SearchTracesInput,
  limit: number,
  offset: number,
): Effect.Effect<ReadonlyArray<SpanResult>, ObservabilityError> => {
  const conditions: string[] = [
    `OrgId = '${escapeForSQL(executor.orgId)}'`,
  ]

  conditions.push(`Timestamp >= parseDateTimeBestEffort('${escapeForSQL(input.timeRange.startTime)}')`)
  conditions.push(`Timestamp <= parseDateTimeBestEffort('${escapeForSQL(input.timeRange.endTime)}')`)

  if (input.spanName) {
    const escaped = escapeForSQL(input.spanName)
    if (input.spanNameMatchMode === "contains") {
      conditions.push(`positionCaseInsensitive(SpanName, '${escaped}') > 0`)
    } else {
      conditions.push(`SpanName = '${escaped}'`)
    }
  }

  if (input.service) {
    conditions.push(`ServiceName = '${escapeForSQL(input.service)}'`)
  }

  if (input.hasError) {
    conditions.push(`StatusCode = 'Error'`)
  }

  if (input.minDurationMs != null) {
    conditions.push(`Duration >= ${input.minDurationMs} * 1000000`)
  }

  if (input.maxDurationMs != null) {
    conditions.push(`Duration <= ${input.maxDurationMs} * 1000000`)
  }

  if (input.httpMethod) {
    conditions.push(`SpanAttributes['http.method'] = '${escapeForSQL(input.httpMethod)}'`)
  }

  if (input.traceId) {
    conditions.push(`TraceId = '${escapeForSQL(input.traceId)}'`)
  }

  if (input.attributeFilters) {
    for (const af of input.attributeFilters) {
      const key = escapeForSQL(af.key)
      const value = escapeForSQL(af.value)
      if (af.mode === "contains") {
        conditions.push(`positionCaseInsensitive(SpanAttributes['${key}'], '${value}') > 0`)
      } else {
        conditions.push(`SpanAttributes['${key}'] = '${value}'`)
      }
    }
  }

  const sql = `
    SELECT
      TraceId as traceId,
      SpanId as spanId,
      SpanName as spanName,
      ServiceName as serviceName,
      Duration / 1000000 as durationMs,
      StatusCode as statusCode,
      StatusMessage as statusMessage,
      toString(SpanAttributes) as attributesStr,
      toString(Timestamp) as timestamp
    FROM traces
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY Timestamp DESC
    LIMIT ${limit}
    OFFSET ${offset}
    FORMAT JSON
  `

  return Effect.map(
    executor.sqlQuery(sql),
    (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<SpanResult> =>
      rows.map((row: any) => ({
        traceId: row.traceId,
        spanId: row.spanId,
        spanName: row.spanName,
        serviceName: row.serviceName,
        durationMs: Number(row.durationMs),
        statusCode: row.statusCode,
        statusMessage: row.statusMessage ?? "",
        attributes: parseAttributeMap(row.attributesStr),
        timestamp: row.timestamp,
      })),
  )
}

/**
 * Root-level search using the `list_traces` Tinybird pipe.
 * Fast (MV-backed) but limited to root span filtering.
 */
const rootLevelSearch = (
  executor: TinybirdExecutorShape,
  input: SearchTracesInput,
  limit: number,
  offset: number,
): Effect.Effect<ReadonlyArray<SpanResult>, ObservabilityError> => {
  const params: Record<string, unknown> = {
    start_time: input.timeRange.startTime,
    end_time: input.timeRange.endTime,
    limit,
    offset,
  }

  if (input.service) params.service = input.service
  if (input.spanName) {
    params.span_name = input.spanName
    if (input.spanNameMatchMode === "contains") {
      params.span_name_match_mode = "contains"
    }
  }
  if (input.hasError) params.has_error = true
  if (input.minDurationMs != null) params.min_duration_ms = input.minDurationMs
  if (input.maxDurationMs != null) params.max_duration_ms = input.maxDurationMs
  if (input.httpMethod) params.http_method = input.httpMethod
  if (input.traceId) params.trace_id = input.traceId

  if (input.attributeFilters?.[0]) {
    params.attribute_filter_key = input.attributeFilters[0].key
    params.attribute_filter_value = input.attributeFilters[0].value
  }

  return Effect.map(
    executor.query<any>("list_traces", params),
    (result: { data: ReadonlyArray<any> }): ReadonlyArray<SpanResult> =>
      result.data.map((t: any) => ({
        traceId: t.traceId,
        spanId: "",
        spanName: t.rootSpanName ?? "",
        serviceName: (t.services as string[])?.[0] ?? "",
        durationMs: Number(t.durationMicros) / 1000,
        statusCode: Number(t.hasError) ? "Error" : "Ok",
        statusMessage: "",
        attributes: {},
        timestamp: String(t.startTime ?? ""),
      })),
  )
}

/**
 * Parse ClickHouse's toString(Map) output back into a Record.
 * Format: {'key1':'val1','key2':'val2'}
 */
function parseAttributeMap(str: string): Record<string, string> {
  if (!str || str === "{}" || str === "{'':''}" ) return {}
  try {
    // ClickHouse toString(Map) produces {'k':'v','k2':'v2'}
    // Convert to valid JSON: {"k":"v","k2":"v2"}
    const json = str.replace(/'/g, '"')
    return JSON.parse(json)
  } catch {
    return {}
  }
}
