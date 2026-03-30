import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatDurationMs, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerErrorDetailTool(server: McpToolRegistrar) {
  server.tool(
    "error_detail",
    "Get sample traces and correlated logs for a specific error type. Optionally include a timeseries to see if the error is getting worse. Use inspect_trace on a trace_id for the full span tree.",
    Schema.Struct({
      error_type: requiredStringParam("The error type / StatusMessage to investigate"),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      include_timeseries: optionalBooleanParam("Include error count over time to see if the error is trending up or down"),
      limit: optionalNumberParam("Max sample traces (default 5)"),
    }),
    ({ error_type, start_time, end_time, service, include_timeseries, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
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

        // Fetch logs and optional timeseries in parallel
        const traceIds = traces.slice(0, 3).map((t) => t.traceId)
        const logsResults = yield* Effect.all(
          traceIds.map((tid) =>
            queryTinybird("list_logs", { trace_id: tid, limit: 10 }),
          ),
          { concurrency: "unbounded" },
        )

        // Optionally fetch error timeseries
        const timeseriesData = include_timeseries
          ? yield* queryTinybird("errors_timeseries", {
              error_type,
              start_time: st,
              end_time: et,
              ...(service && { services: service }),
              exclude_spam_patterns: getSpamPatternsParam(),
            }).pipe(Effect.map((r) => r.data))
          : undefined

        const lines: string[] = [
          `## Error Detail: "${truncate(error_type, 80)}"`,
          `Time range: ${st} — ${et}`,
          `Sample traces: ${traces.length}`,
          ``,
        ]

        for (let i = 0; i < traces.length; i++) {
          const t = traces[i]!
          const dur = formatDurationMs(t.durationMicros)
          lines.push(
            `### Trace ${i + 1}: ${t.traceId.slice(0, 16)}...`,
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

        // Show timeseries if included
        if (timeseriesData && timeseriesData.length > 0) {
          lines.push(`### Error Trend`)
          for (const point of timeseriesData) {
            const ts = String(point.bucket)
            const time = ts.includes("T") ? ts.slice(11, 19) : ts.split(" ")[1] ?? ts
            lines.push(`  ${time}: ${Number(point.count)} errors`)
          }
          lines.push(``)
        }

        const nextSteps = traces.slice(0, 3).map((t) =>
          `\`inspect_trace trace_id="${t.traceId}"\` — full span tree`
        )
        nextSteps.push(`\`search_logs service="${service ?? ""}" severity="ERROR"\` — search for related error logs`)
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "error_detail",
            data: {
              timeRange: { start: st, end: et },
              errorType: error_type,
              traces: traces.map((t, i) => ({
                traceId: t.traceId,
                rootSpanName: t.rootSpanName,
                durationMs: Number(t.durationMicros) / 1000,
                spanCount: Number(t.spanCount),
                services: t.services,
                startTime: String(t.startTime),
                errorMessage: t.errorMessage || undefined,
                logs: (i < logsResults.length ? logsResults[i]!.data.slice(0, 5) : []).map((l) => ({
                  timestamp: String(l.timestamp),
                  severityText: l.severityText || "INFO",
                  body: l.body,
                })),
              })),
            },
          }),
        }
      }),
  )
}
