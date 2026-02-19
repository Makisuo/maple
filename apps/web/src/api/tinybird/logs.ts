import { Effect, Schema } from "effect"
import { getTinybird, type ListLogsOutput } from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
  type TinybirdApiError,
} from "@/api/tinybird/effect-utils"

const ListLogsInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(1000)),
  ),
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  minSeverity: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(255)),
  ),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  search: Schema.optional(Schema.String),
})

export type ListLogsInput = Schema.Schema.Type<typeof ListLogsInputSchema>

const DEFAULT_LIMIT = 100

export interface Log {
  timestamp: string
  severityText: string
  severityNumber: number
  serviceName: string
  body: string
  traceId: string
  spanId: string
  logAttributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export interface LogsResponse {
  data: Log[]
  meta: {
    limit: number
    total: number
    cursor: string | null
  }
}

export interface LogsCountResponse {
  data: Array<{ total: number }>
}

function parseAttributes(value: string | null | undefined): Record<string, string> {
  if (!value) return {}
  const parsed = JSON.parse(value)
  return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
}

function transformLog(raw: ListLogsOutput): Log {
  return {
    timestamp: String(raw.timestamp),
    severityText: raw.severityText,
    severityNumber: Number(raw.severityNumber),
    serviceName: raw.serviceName,
    body: raw.body,
    traceId: raw.traceId,
    spanId: raw.spanId,
    logAttributes: parseAttributes(raw.logAttributes),
    resourceAttributes: parseAttributes(raw.resourceAttributes),
  }
}

export function listLogs({
  data,
}: {
  data: ListLogsInput
}): Effect.Effect<LogsResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "listLogs")
    const limit = input.limit ?? DEFAULT_LIMIT
    const tinybird = getTinybird()

    const [logsResult, countResult] = yield* Effect.all([
      runTinybirdQuery("list_logs", () =>
        tinybird.query.list_logs({
          limit,
          service: input.service,
          severity: input.severity,
          min_severity: input.minSeverity,
          start_time: input.startTime,
          end_time: input.endTime,
          trace_id: input.traceId,
          span_id: input.spanId,
          cursor: input.cursor,
          search: input.search,
        }),
      ),
      runTinybirdQuery("logs_count", () =>
        tinybird.query.logs_count({
          service: input.service,
          severity: input.severity,
          start_time: input.startTime,
          end_time: input.endTime,
          trace_id: input.traceId,
          search: input.search,
        }),
      ),
    ])

    const total = Number(countResult.data[0]?.total ?? 0)
    const logs = logsResult.data.map(transformLog)
    const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null

    return {
      data: logs,
      meta: {
        limit,
        total,
        cursor,
      },
    }
  })
}

export function getLogsCount({
  data,
}: {
  data: ListLogsInput
}): Effect.Effect<LogsCountResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "getLogsCount")
    const tinybird = getTinybird()

    const countResult = yield* runTinybirdQuery("logs_count", () =>
      tinybird.query.logs_count({
        service: input.service,
        severity: input.severity,
        start_time: input.startTime,
        end_time: input.endTime,
        trace_id: input.traceId,
        search: input.search,
      }),
    )

    return {
      data: [{ total: Number(countResult.data[0]?.total ?? 0) }],
    }
  })
}

export interface FacetItem {
  name: string
  count: number
}

export interface LogsFacets {
  services: FacetItem[]
  severities: FacetItem[]
}

export interface LogsFacetsResponse {
  data: LogsFacets
}

const GetLogsFacetsInputSchema = Schema.Struct({
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  startTime: Schema.optional(TinybirdDateTimeString),
  endTime: Schema.optional(TinybirdDateTimeString),
})

export type GetLogsFacetsInput = Schema.Schema.Type<typeof GetLogsFacetsInputSchema>

export function getLogsFacets({
  data,
}: {
  data: GetLogsFacetsInput
}): Effect.Effect<LogsFacetsResponse, TinybirdApiError> {
  return Effect.gen(function* () {
    const input = yield* decodeInput(GetLogsFacetsInputSchema, data ?? {}, "getLogsFacets")
    const tinybird = getTinybird()

    const result = yield* runTinybirdQuery("logs_facets", () =>
      tinybird.query.logs_facets({
        service: input.service,
        severity: input.severity,
        start_time: input.startTime,
        end_time: input.endTime,
      }),
    )

    const services: FacetItem[] = []
    const severities: FacetItem[] = []

    for (const row of result.data) {
      const count = Number(row.count)
      if (row.facetType === "service" && row.serviceName) {
        services.push({ name: row.serviceName, count })
      } else if (row.facetType === "severity" && row.severityText) {
        severities.push({ name: row.severityText, count })
      }
    }

    return {
      data: { services, severities },
    }
  })
}
