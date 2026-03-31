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
    "Search traces by service, duration, error status, HTTP method, span name, or custom attributes. Use inspect_trace on interesting trace_ids. Use explore_attributes to discover attribute keys.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name (searches all spans in the trace, not just root)"),
      has_error: optionalBooleanParam("Filter traces with errors only"),
      min_duration_ms: optionalNumberParam("Minimum duration in milliseconds"),
      max_duration_ms: optionalNumberParam("Maximum duration in milliseconds"),
      http_method: optionalStringParam("Filter by HTTP method (GET, POST, etc.)"),
      span_name: optionalStringParam("Filter by span name (searches all spans, substring match, case-insensitive)"),
      trace_id: optionalStringParam("Find a specific trace by ID"),
      attribute_key: optionalStringParam("Filter by span attribute key (e.g. user.id, request.id)"),
      attribute_value: optionalStringParam("Filter by span attribute value (requires attribute_key)"),
      root_only: optionalBooleanParam("Only match root spans for service/span_name filters (default: false, searches all spans)"),
      limit: optionalNumberParam("Max results (default 20)"),
    }),
    (params) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)

        if (params.attribute_value && !params.attribute_key) {
          return {
            isError: true,
            content: [{ type: "text", text: "`attribute_value` requires `attribute_key`." }],
          }
        }

        // Default: search all spans in the trace. root_only=true restricts to root span only.
        const rootOnly = params.root_only === true

        const result = yield* queryTinybird("list_traces", {
          start_time: st,
          end_time: et,
          ...(params.service && (rootOnly
            ? { service: params.service }
            : { any_service: params.service }
          )),
          has_error: params.has_error,
          min_duration_ms: params.min_duration_ms,
          max_duration_ms: params.max_duration_ms,
          http_method: params.http_method,
          ...(params.span_name && (rootOnly
            ? { span_name: params.span_name, span_name_match_mode: "contains" }
            : { any_span_name: params.span_name, any_span_name_match_mode: "contains" }
          )),
          ...(params.trace_id && { trace_id: params.trace_id }),
          ...(params.attribute_key && { attribute_filter_key: params.attribute_key }),
          ...(params.attribute_value && { attribute_filter_value: params.attribute_value }),
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
