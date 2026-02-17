import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { defaultTimeRange } from "../lib/time"
import { formatDurationMs, formatTable } from "../lib/format"
import { Effect } from "effect"

export function registerSearchTracesTool(server: McpToolRegistrar) {
  server.tool(
    "search_traces",
    "Search and filter traces by service, duration, error status, HTTP method, and more.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      has_error: optionalBooleanParam("Filter traces with errors only"),
      min_duration_ms: optionalNumberParam("Minimum duration in milliseconds"),
      max_duration_ms: optionalNumberParam("Maximum duration in milliseconds"),
      http_method: optionalStringParam("Filter by HTTP method (GET, POST, etc.)"),
      span_name: optionalStringParam("Filter by root span name"),
      limit: optionalNumberParam("Max results (default 20)"),
    },
    (params) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = params.start_time ?? startTime
        const et = params.end_time ?? endTime

        const result = yield* queryTinybird("list_traces", {
          start_time: st,
          end_time: et,
          service: params.service,
          has_error: params.has_error,
          min_duration_ms: params.min_duration_ms,
          max_duration_ms: params.max_duration_ms,
          http_method: params.http_method,
          span_name: params.span_name,
          limit: params.limit ?? 20,
        })

        const traces = result.data
        if (traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found matching filters (${st} — ${et})` }] }
        }

        const lines: string[] = [
          `=== Traces (showing ${traces.length}) ===`,
          `Time range: ${st} — ${et}`,
          ``,
        ]

        const headers = ["Trace ID", "Root Span", "Duration", "Spans", "Services", "Error"]
        const rows = traces.map((t) => [
          t.traceId.slice(0, 12) + "...",
          t.rootSpanName.length > 30 ? t.rootSpanName.slice(0, 27) + "..." : t.rootSpanName,
          formatDurationMs(t.durationMicros),
          String(Number(t.spanCount)),
          t.services.join(", "),
          Number(t.hasError) ? "Yes" : "",
        ])

        lines.push(formatTable(headers, rows))

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
