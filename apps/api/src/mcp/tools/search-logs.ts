import {
  optionalNumberParam,
  optionalStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { searchLogs } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerSearchLogsTool(server: McpToolRegistrar) {
  server.tool(
    "search_logs",
    "Search and filter logs by service, severity, keyword, or trace_id. Supports pagination — check hasMore in the response for additional results. Use inspect_trace to see the full trace for a log entry.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      severity: optionalStringParam("Filter by log severity level. Valid values: TRACE, DEBUG, INFO, WARN, ERROR, FATAL. Case-insensitive."),
      search: optionalStringParam("Search text in log body"),
      trace_id: optionalStringParam("Filter by trace ID"),
      span_id: optionalStringParam("Filter by span ID (scope to a specific span within a trace)"),
      offset: optionalNumberParam("Offset for pagination (default 0). Use nextOffset from previous response."),
      limit: optionalNumberParam("Max results (default 30)"),
    }),
    Effect.fn("McpTool.searchLogs")(function* ({ start_time, end_time, service, severity, search, trace_id, span_id, offset, limit }) {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const lim = limit ?? 30
        const off = offset ?? 0
        const tenant = yield* resolveTenant

        const result = yield* searchLogs({
          timeRange: { startTime: st, endTime: et },
          service: service ?? undefined,
          severity: severity ?? undefined,
          search: search ?? undefined,
          traceId: trace_id ?? undefined,
          limit: lim,
          offset: off,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "list_logs" })),
        )

        if (result.logs.length === 0) {
          return { content: [{ type: "text", text: `No logs found matching filters (${st} — ${et})` }] }
        }

        const lines: string[] = [
          `## Logs (${formatNumber(result.total)} total, showing ${result.logs.length})`,
          `Time range: ${st} — ${et}`,
        ]

        const filters: string[] = []
        if (service) filters.push(`service=${service}`)
        if (severity) filters.push(`severity=${severity}`)
        if (search) filters.push(`search="${search}"`)
        if (trace_id) filters.push(`trace_id=${trace_id}`)
        if (filters.length > 0) lines.push(`Filters: ${filters.join(", ")}`)
        lines.push(``)

        for (const log of result.logs) {
          const time = log.timestamp.split(" ")[1] ?? log.timestamp
          const sev = log.severityText.padEnd(5)
          const traceRef = log.traceId ? ` [trace:${log.traceId.slice(0, 8)}]` : ""
          lines.push(`${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 120)}${traceRef}`)
        }

        const hasMore = result.pagination.hasMore
        if (hasMore) {
          const nextOffset = off + result.logs.length
          lines.push(``, `Showing ${off + 1}–${off + result.logs.length} of ${formatNumber(result.total)}. Call again with offset=${nextOffset} for more.`)
        }

        const traceIds = [...new Set(result.logs.filter((l) => l.traceId).map((l) => l.traceId))].slice(0, 3)
        const nextSteps = traceIds.map((tid) => `\`inspect_trace trace_id="${tid}"\` — see full trace`)
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "search_logs",
            data: {
              timeRange: { start: st, end: et },
              totalCount: result.total,
              pagination: result.pagination,
              logs: result.logs.map((l) => ({ ...l })),
            },
          }),
        }
      }),
  )
}
