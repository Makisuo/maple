import {
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { defaultTimeRange } from "../lib/time"
import { formatDurationMs, truncate } from "../lib/format"
import { Effect } from "effect"

export function registerErrorDetailTool(server: McpToolRegistrar) {
  server.tool(
    "error_detail",
    "Investigate a specific error type: shows sample traces with their metadata and correlated logs.",
    {
      error_type: requiredStringParam("The error type / StatusMessage to investigate"),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      limit: optionalNumberParam("Max sample traces (default 5)"),
    },
    ({ error_type, start_time, end_time, service, limit }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime
        const lim = limit ?? 5

        const tracesResult = yield* queryTinybird("error_detail_traces", {
          error_type,
          start_time: st,
          end_time: et,
          services: service,
          limit: lim,
          exclude_spam_patterns: getSpamPatternsParam(),
        })

        const traces = tracesResult.data
        if (traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found for error type "${error_type}" in ${st} — ${et}` }] }
        }

        // Fetch logs for the first few trace IDs
        const traceIds = traces.slice(0, 3).map((t) => t.traceId)
        const logsResults = yield* Effect.all(
          traceIds.map((tid) =>
            queryTinybird("list_logs", { trace_id: tid, limit: 10 }),
          ),
          { concurrency: "unbounded" },
        )

        const lines: string[] = [
          `=== Error Detail: "${truncate(error_type, 80)}" ===`,
          `Time range: ${st} — ${et}`,
          `Sample traces: ${traces.length}`,
          ``,
        ]

        for (let i = 0; i < traces.length; i++) {
          const t = traces[i]!
          const dur = formatDurationMs(t.durationMicros)
          lines.push(
            `--- Trace ${i + 1}: ${t.traceId.slice(0, 16)}... ---`,
            `  Root span: ${t.rootSpanName}`,
            `  Duration: ${dur}`,
            `  Spans: ${Number(t.spanCount)}`,
            `  Services: ${t.services.join(", ")}`,
            `  Time: ${t.startTime}`,
          )

          if (t.errorMessage) {
            lines.push(`  Error: ${truncate(t.errorMessage, 120)}`)
          }

          // Show logs if available
          if (i < logsResults.length) {
            const logs = logsResults[i]!.data
            if (logs.length > 0) {
              lines.push(`  Logs (${logs.length}):`)
              for (const log of logs.slice(0, 5)) {
                const ts = String(log.timestamp)
                const time = ts.split(" ")[1] ?? ts
                const sev = (log.severityText || "INFO").padEnd(5)
                lines.push(`    ${time} [${sev}] ${truncate(log.body, 90)}`)
              }
              if (logs.length > 5) {
                lines.push(`    ... and ${logs.length - 5} more`)
              }
            }
          }

          lines.push(``)
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
