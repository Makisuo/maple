import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatDurationMs, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerSearchTracesTool(server: McpToolRegistrar) {
  server.tool(
    "search_traces",
    "Search traces by service, duration, error status, HTTP method, or span name. Use inspect_trace on interesting trace_ids.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      has_error: optionalBooleanParam("Filter traces with errors only"),
      min_duration_ms: optionalNumberParam("Minimum duration in milliseconds"),
      max_duration_ms: optionalNumberParam("Maximum duration in milliseconds"),
      http_method: optionalStringParam("Filter by HTTP method (GET, POST, etc.)"),
      span_name: optionalStringParam("Filter by root span name (substring match, case-insensitive)"),
      limit: optionalNumberParam("Max results (default 20)"),
    }),
    (params) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)

        const result = yield* queryTinybird("list_traces", {
          start_time: st,
          end_time: et,
          service: params.service,
          has_error: params.has_error,
          min_duration_ms: params.min_duration_ms,
          max_duration_ms: params.max_duration_ms,
          http_method: params.http_method,
          span_name: params.span_name,
          span_name_match_mode: params.span_name ? "contains" : undefined,
          limit: params.limit ?? 20,
        })

        const traces = result.data
        if (traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found matching filters (${st} — ${et})` }] }
        }

        const lines: string[] = [
          `## Traces (showing ${traces.length})`,
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

        const nextSteps = traces.slice(0, 3).map((t) =>
          `\`inspect_trace trace_id="${t.traceId}"\` — full span tree`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "search_traces",
            data: {
              timeRange: { start: st, end: et },
              traces: traces.map((t) => ({
                traceId: t.traceId,
                rootSpanName: t.rootSpanName,
                durationMs: Number(t.durationMicros) / 1000,
                spanCount: Number(t.spanCount),
                services: t.services,
                hasError: Boolean(Number(t.hasError)),
              })),
            },
          }),
        }
      }),
  )
}
