import { Effect, Schema } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import { getTinybird, type ListLogsOutput } from "@/lib/tinybird"
import {
  TinybirdDateTimeString,
  decodeInput,
  runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)

const ListLogsInputSchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  ),
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  minSeverity: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255)),
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
  traceId: TraceId
  spanId: SpanId
  logAttributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export interface LogsResponse {
  data: Log[]
  meta: {
    limit: number
    cursor: string | null
  }
}

function parseAttributes(value: string | null | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function transformLog(raw: ListLogsOutput): Log {
  return {
    timestamp: String(raw.timestamp),
    severityText: raw.severityText,
    severityNumber: Number(raw.severityNumber),
    serviceName: raw.serviceName,
    body: raw.body,
    traceId: raw.traceId ? toTraceId(raw.traceId) : ("" as TraceId),
    spanId: raw.spanId ? toSpanId(raw.spanId) : ("" as SpanId),
    logAttributes: parseAttributes(raw.logAttributes),
    resourceAttributes: parseAttributes(raw.resourceAttributes),
  }
}

export function listLogs({
  data,
}: {
  data: ListLogsInput
}) {
  return listLogsEffect({ data })
}

const listLogsEffect = Effect.fn("Tinybird.listLogs")(function* ({
  data,
}: {
  data: ListLogsInput
}) {
    const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "listLogs")
    const limit = input.limit ?? DEFAULT_LIMIT
    const tinybird = getTinybird()

    const logsResult = yield* runTinybirdQuery("list_logs", () =>
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
    )

    const logs = logsResult.data.map(transformLog)
    const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null

    return {
      data: logs,
      meta: {
        limit,
        cursor,
      },
    }
})

export function getLogsCount({
  data,
}: {
  data: ListLogsInput
}) {
  return getLogsCountEffect({ data })
}

const getLogsCountEffect = Effect.fn("Tinybird.getLogsCount")(function* ({
  data,
}: {
  data: ListLogsInput
}) {
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
}) {
  return getLogsFacetsEffect({ data })
}

const getLogsFacetsEffect = Effect.fn("Tinybird.getLogsFacets")(function* ({
  data,
}: {
  data: GetLogsFacetsInput
}) {
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
