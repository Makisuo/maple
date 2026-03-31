import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  validationError,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatDurationFromMs, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { searchTraces } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerSearchTracesTool(server: McpToolRegistrar) {
  server.tool(
    "search_traces",
    "Search traces by service, duration, error status, HTTP method, span name, or custom attributes. When span_name is provided, searches at the span level (not just root spans) for accurate results. Use inspect_trace on interesting trace_ids. Use explore_attributes to discover attribute keys.",
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
      offset: optionalNumberParam("Offset for pagination (default 0). Use nextOffset from previous response."),
      limit: optionalNumberParam("Max results (default 20)"),
    }),
    (params) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)
        const lim = params.limit ?? 20
        const off = params.offset ?? 0

        if (params.attribute_value && !params.attribute_key) {
          return validationError(
            "`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
            'attribute_key="user.id" attribute_value="abc123"',
          )
        }

        const tenant = yield* resolveTenant

        const result = yield* searchTraces({
          timeRange: { startTime: st, endTime: et },
          service: params.service ?? undefined,
          spanName: params.span_name ?? undefined,
          spanNameMatchMode: params.span_name ? "contains" : undefined,
          hasError: params.has_error ?? undefined,
          minDurationMs: params.min_duration_ms ?? undefined,
          maxDurationMs: params.max_duration_ms ?? undefined,
          httpMethod: params.http_method ?? undefined,
          traceId: params.trace_id ?? undefined,
          attributeFilters: params.attribute_key
            ? [{ key: params.attribute_key, value: params.attribute_value ?? "" }]
            : undefined,
          rootOnly: params.root_only ?? false,
          limit: lim,
          offset: off,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "list_traces" })),
        )

        const spans = result.spans
        if (spans.length === 0) {
          return { content: [{ type: "text", text: `No traces found matching filters (${st} — ${et})` }] }
        }

        const hasMore = result.pagination.hasMore
        const isSpanLevel = !!(params.span_name && !params.root_only)

        const lines: string[] = [
          `## ${isSpanLevel ? "Matching Spans" : "Traces"} (showing ${off + 1}–${off + spans.length})`,
          `Time range: ${st} — ${et}`,
          ``,
        ]

        const headers = isSpanLevel
          ? ["Trace ID", "Span Name", "Service", "Duration", "Status"]
          : ["Trace ID", "Root Span", "Duration", "Service", "Error"]

        const rows = spans.map((s) =>
          isSpanLevel
            ? [
                s.traceId.slice(0, 12) + "...",
                s.spanName.length > 40 ? s.spanName.slice(0, 37) + "..." : s.spanName,
                s.serviceName,
                formatDurationFromMs(s.durationMs),
                s.statusCode === "Error" ? "Error" : "",
              ]
            : [
                s.traceId.slice(0, 12) + "...",
                s.spanName.length > 30 ? s.spanName.slice(0, 27) + "..." : s.spanName,
                formatDurationFromMs(s.durationMs),
                s.serviceName,
                s.statusCode === "Error" ? "Yes" : "",
              ],
        )

        lines.push(formatTable(headers, rows))

        if (hasMore) {
          const nextOffset = off + spans.length
          lines.push(``, `More results available. Call again with offset=${nextOffset} for the next page.`)
        }

        const nextSteps = spans.slice(0, 3).map((s) =>
          `\`inspect_trace trace_id="${s.traceId}"\` — full span tree`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "search_traces",
            data: {
              timeRange: { start: st, end: et },
              pagination: {
                offset: off,
                limit: lim,
                hasMore,
                ...(hasMore && { nextOffset: off + spans.length }),
              },
              traces: spans.map((s) => ({
                traceId: s.traceId,
                rootSpanName: s.spanName,
                durationMs: s.durationMs,
                spanCount: 1,
                services: [s.serviceName],
                hasError: s.statusCode === "Error",
              })),
            },
          }),
        }
      }),
  )
}
