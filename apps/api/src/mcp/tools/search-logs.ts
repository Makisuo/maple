import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerSearchLogsTool(server: McpToolRegistrar) {
  server.tool(
    "search_logs",
    "Search and filter logs by service, severity, keyword, or trace_id. Use inspect_trace to see the full trace for a log entry.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      severity: optionalStringParam("Filter by severity (e.g. ERROR, WARN, INFO)"),
      search: optionalStringParam("Search text in log body"),
      trace_id: optionalStringParam("Filter by trace ID"),
      span_id: optionalStringParam("Filter by span ID (scope to a specific span within a trace)"),
      limit: optionalNumberParam("Max results (default 30)"),
    }),
    ({ start_time, end_time, service, severity, search, trace_id, span_id, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const lim = limit ?? 30

        const [logsResult, countResult] = yield* Effect.all(
          [
            queryTinybird("list_logs", {
              start_time: st,
              end_time: et,
              service,
              severity,
              search,
              trace_id,
              ...(span_id && { span_id }),
              limit: lim,
            }),
            queryTinybird("logs_count", {
              start_time: st,
              end_time: et,
              service,
              severity,
              search,
              trace_id,
              ...(span_id && { span_id }),
            }),
          ],
          { concurrency: "unbounded" },
        )

        const total = countResult.data[0] ? Number(countResult.data[0].total) : 0
        const logs = logsResult.data

        if (logs.length === 0) {
          return { content: [{ type: "text", text: `No logs found matching filters (${st} — ${et})` }] }
        }

        const lines: string[] = [
          `## Logs (${formatNumber(total)} total, showing ${logs.length})`,
          `Time range: ${st} — ${et}`,
        ]

        const filters: string[] = []
        if (service) filters.push(`service=${service}`)
        if (severity) filters.push(`severity=${severity}`)
        if (search) filters.push(`search="${search}"`)
        if (trace_id) filters.push(`trace_id=${trace_id}`)
        if (filters.length > 0) lines.push(`Filters: ${filters.join(", ")}`)

        lines.push(``)

        for (const log of logs) {
          const ts = String(log.timestamp)
          const time = ts.split(" ")[1] ?? ts
          const sev = (log.severityText || "INFO").padEnd(5)
          const svc = log.serviceName
          const body = truncate(log.body, 120)
          const traceRef = log.traceId ? ` [trace:${log.traceId.slice(0, 8)}]` : ""
          lines.push(`${time} [${sev}] ${svc}: ${body}${traceRef}`)
        }

        if (total > logs.length) {
          lines.push(``, `... ${formatNumber(total - logs.length)} more logs not shown`)
        }

        const traceIds = [...new Set(logs.filter((l) => l.traceId).map((l) => l.traceId))].slice(0, 3)
        const nextSteps = traceIds.map((tid) =>
          `\`inspect_trace trace_id="${tid}"\` — see full trace`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "search_logs",
            data: {
              timeRange: { start: st, end: et },
              totalCount: total,
              logs: logs.map((l) => ({
                timestamp: String(l.timestamp),
                severityText: l.severityText || "INFO",
                serviceName: l.serviceName,
                body: l.body,
                traceId: l.traceId || undefined,
                spanId: l.spanId || undefined,
              })),
              filters: {
                ...(service && { service }),
                ...(severity && { severity }),
                ...(search && { search }),
                ...(trace_id && { traceId: trace_id }),
              },
            },
          }),
        }
      }),
  )
}
