import { Array as Arr, Effect, Option, pipe } from "effect"
import { TinybirdExecutor, ObservabilityError, type TinybirdExecutorShape } from "./TinybirdExecutor"
import type { SearchTracesInput, SearchTracesOutput, SpanResult } from "./types"
import { toSpanResult } from "./row-mappers"
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

    const spans = input.spanName && !input.rootOnly
      ? yield* spanLevelSearch(executor, input, limit, offset)
      : yield* rootLevelSearch(executor, input, limit, offset)

    return {
      timeRange: input.timeRange,
      spans,
      pagination: { offset, limit, hasMore: spans.length === limit },
    }
  })

const esc = escapeForSQL

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
  const optionalCondition = (value: string | number | undefined | null, toSql: (v: string) => string): Option.Option<string> =>
    value != null ? Option.some(toSql(String(value))) : Option.none()

  const conditions: string[] = [
    `OrgId = '${esc(executor.orgId)}'`,
    `Timestamp >= parseDateTimeBestEffort('${esc(input.timeRange.startTime)}')`,
    `Timestamp <= parseDateTimeBestEffort('${esc(input.timeRange.endTime)}')`,
    ...pipe(
      [
        optionalCondition(input.spanName, (name) =>
          input.spanNameMatchMode === "contains"
            ? `positionCaseInsensitive(SpanName, '${esc(name)}') > 0`
            : `SpanName = '${esc(name)}'`,
        ),
        optionalCondition(input.service, (s) => `ServiceName = '${esc(s)}'`),
        input.hasError ? Option.some(`StatusCode = 'Error'`) : Option.none(),
        optionalCondition(input.minDurationMs, (d) => `Duration >= ${d} * 1000000`),
        optionalCondition(input.maxDurationMs, (d) => `Duration <= ${d} * 1000000`),
        optionalCondition(input.httpMethod, (m) => `SpanAttributes['http.method'] = '${esc(m)}'`),
        optionalCondition(input.traceId, (id) => `TraceId = '${esc(id)}'`),
      ],
      Arr.getSomes,
    ),
  ]

  const attrConditions = pipe(
    input.attributeFilters ?? [],
    Arr.map((af) =>
      af.mode === "contains"
        ? `positionCaseInsensitive(SpanAttributes['${esc(af.key)}'], '${esc(af.value)}') > 0`
        : `SpanAttributes['${esc(af.key)}'] = '${esc(af.value)}'`,
    ),
  )

  const allConditions = [...conditions, ...attrConditions]

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
    WHERE ${allConditions.join("\n      AND ")}
    ORDER BY Timestamp DESC
    LIMIT ${limit}
    OFFSET ${offset}
    FORMAT JSON
  `

  return Effect.map(
    executor.sqlQuery(sql),
    (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<SpanResult> =>
      pipe(
        rows as any[],
        Arr.map((row) => ({
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
      ),
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
  const optionalParams: Record<string, unknown> = {
    ...(input.service && { service: input.service }),
    ...(input.spanName && { span_name: input.spanName }),
    ...(input.spanNameMatchMode === "contains" && { span_name_match_mode: "contains" }),
    ...(input.hasError && { has_error: true }),
    ...(input.minDurationMs != null && { min_duration_ms: input.minDurationMs }),
    ...(input.maxDurationMs != null && { max_duration_ms: input.maxDurationMs }),
    ...(input.httpMethod && { http_method: input.httpMethod }),
    ...(input.traceId && { trace_id: input.traceId }),
    ...(input.attributeFilters?.[0]?.key && { attribute_filter_key: input.attributeFilters[0].key }),
    ...(input.attributeFilters?.[0]?.value && { attribute_filter_value: input.attributeFilters[0].value }),
  }

  const params = {
    start_time: input.timeRange.startTime,
    end_time: input.timeRange.endTime,
    limit,
    offset,
    ...optionalParams,
  }

  return Effect.map(
    executor.query<any>("list_traces", params),
    (result: { data: ReadonlyArray<any> }): ReadonlyArray<SpanResult> =>
      pipe(result.data, Arr.map(toSpanResult)),
  )
}

/** Parse ClickHouse's toString(Map) output back into a Record. */
function parseAttributeMap(str: string): Record<string, string> {
  if (!str || str === "{}" || str === "{'':''}") return {}
  try {
    return JSON.parse(str.replace(/'/g, '"'))
  } catch {
    return {}
  }
}
