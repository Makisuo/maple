import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { TraceId, SpanId } from "@maple/domain"
import { ListLogsRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  TinybirdDateTimeString,
  decodeInput,
  executeQueryEngine,
  extractCount,
  extractFacets,
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
  deploymentEnv: Schema.optional(Schema.String),
  deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
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

function transformLog(raw: Record<string, unknown>): Log {
  return {
    timestamp: String(raw.timestamp ?? ""),
    severityText: String(raw.severityText ?? ""),
    severityNumber: Number(raw.severityNumber ?? 0),
    serviceName: String(raw.serviceName ?? ""),
    body: String(raw.body ?? ""),
    traceId: raw.traceId ? toTraceId(String(raw.traceId)) : ("" as TraceId),
    spanId: raw.spanId ? toSpanId(String(raw.spanId)) : ("" as SpanId),
    logAttributes: parseAttributes(raw.logAttributes as string),
    resourceAttributes: parseAttributes(raw.resourceAttributes as string),
  }
}

export function listLogs({
  data,
}: {
  data: ListLogsInput
}) {
  return listLogsEffect({ data })
}

const listLogsEffect = Effect.fn("QueryEngine.listLogs")(function* ({
  data,
}: {
  data: ListLogsInput
}) {
    const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "listLogs")
    const limit = input.limit ?? DEFAULT_LIMIT
    const fallback = defaultLogsTimeRange()

    const logsResult = yield* runTinybirdQuery("listLogs", () =>
      Effect.gen(function* () {
        const client = yield* MapleApiAtomClient
        return yield* client.queryEngine.listLogs({
          payload: new ListLogsRequest({
            startTime: input.startTime ?? fallback.startTime,
            endTime: input.endTime ?? fallback.endTime,
            limit,
            service: input.service,
            severity: input.severity,
            minSeverity: input.minSeverity,
            traceId: input.traceId,
            spanId: input.spanId,
            cursor: input.cursor,
            search: input.search,
            deploymentEnv: input.deploymentEnv,
            deploymentEnvMatchMode: input.deploymentEnvMatchMode,
          }),
        })
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

const defaultLogsTimeRange = () => {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
  return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

const getLogsCountEffect = Effect.fn("QueryEngine.getLogsCount")(function* ({
  data,
}: {
  data: ListLogsInput
}) {
    const input = yield* decodeInput(ListLogsInputSchema, data ?? {}, "getLogsCount")
    const fallback = defaultLogsTimeRange()

    const response = yield* executeQueryEngine("queryEngine.getLogsCount", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: {
        kind: "count" as const,
        source: "logs" as const,
        filters: {
          serviceName: input.service,
          severity: input.severity,
          traceId: input.traceId,
          search: input.search,
          environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
          deploymentEnvMatchMode: input.deploymentEnvMatchMode,
        },
      },
    }))

    return {
      data: [{ total: extractCount(response) }],
    }
})

export interface FacetItem {
  name: string
  count: number
}

export interface LogsFacets {
  services: FacetItem[]
  severities: FacetItem[]
  deploymentEnvs: FacetItem[]
}

export interface LogsFacetsResponse {
  data: LogsFacets
}

const GetLogsFacetsInputSchema = Schema.Struct({
  service: Schema.optional(Schema.String),
  severity: Schema.optional(Schema.String),
  deploymentEnv: Schema.optional(Schema.String),
  deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
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

const getLogsFacetsEffect = Effect.fn("QueryEngine.getLogsFacets")(function* ({
  data,
}: {
  data: GetLogsFacetsInput
}) {
    const input = yield* decodeInput(GetLogsFacetsInputSchema, data ?? {}, "getLogsFacets")
    const fallback = defaultLogsTimeRange()

    const response = yield* executeQueryEngine("queryEngine.getLogsFacets", new QueryEngineExecuteRequest({
      startTime: input.startTime ?? fallback.startTime,
      endTime: input.endTime ?? fallback.endTime,
      query: {
        kind: "facets" as const,
        source: "logs" as const,
        filters: {
          serviceName: input.service,
          severity: input.severity,
          environments: input.deploymentEnv ? [input.deploymentEnv] : undefined,
          deploymentEnvMatchMode: input.deploymentEnvMatchMode,
        },
      },
    }))

    const facetsData = extractFacets(response)
    const services: FacetItem[] = []
    const severities: FacetItem[] = []
    const deploymentEnvs: FacetItem[] = []

    for (const row of facetsData) {
      const count = Number(row.count)
      if (row.facetType === "service" && row.name) {
        services.push({ name: row.name, count })
      } else if (row.facetType === "severity" && row.name) {
        severities.push({ name: row.name, count })
      } else if (row.facetType === "deploymentEnv" && row.name) {
        deploymentEnvs.push({ name: row.name, count })
      }
    }

    return {
      data: { services, severities, deploymentEnvs },
    }
})
