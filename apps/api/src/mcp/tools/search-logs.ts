import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { defaultTimeRange } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import { Effect } from "effect"

export function registerSearchLogsTool(server: McpToolRegistrar) {
  server.tool(
    "search_logs",
    "Search and filter logs by service, severity, time range, or body text.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      severity: optionalStringParam("Filter by severity (e.g. ERROR, WARN, INFO)"),
      search: optionalStringParam("Search text in log body"),
      trace_id: optionalStringParam("Filter by trace ID"),
      limit: optionalNumberParam("Max results (default 30)"),
    },
    ({ start_time, end_time, service, severity, search, trace_id, limit }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime
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
              limit: lim,
            }),
            queryTinybird("logs_count", {
              start_time: st,
              end_time: et,
              service,
              severity,
              search,
              trace_id,
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
          `=== Logs (${formatNumber(total)} total, showing ${logs.length}) ===`,
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

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
