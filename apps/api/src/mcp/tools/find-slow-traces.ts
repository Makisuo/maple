import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatDurationMs, formatDurationFromMs, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

const SYSTEM_SPAN_PATTERNS = ["ClusterCron"]

function isSystemTrace(rootSpanName: string): boolean {
  return SYSTEM_SPAN_PATTERNS.some((pattern) => rootSpanName.includes(pattern))
}

export function registerFindSlowTracesTool(server: McpToolRegistrar) {
  server.tool(
    "find_slow_traces",
    "Find the slowest traces with percentile context (p50, p95, min, max). Use inspect_trace on slow trace_ids to find bottleneck spans.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
      limit: optionalNumberParam("Max results (default 10)"),
    }),
    ({ start_time, end_time, service, environment, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const lim = limit ?? 10

        const [tracesResult, statsResult] = yield* Effect.all(
          [
            queryTinybird("list_traces", {
              start_time: st,
              end_time: et,
              service,
              ...(environment && { deployment_env: environment }),
              limit: 500,
            }),
            queryTinybird("traces_duration_stats", {
              start_time: st,
              end_time: et,
              service,
            }),
          ],
          { concurrency: "unbounded" },
        )

        const stats = statsResult.data[0]
        const traces = [...tracesResult.data]
          .filter((t) => !isSystemTrace(t.rootSpanName))
          .sort((a, b) => Number(b.durationMicros) - Number(a.durationMicros))
          .slice(0, lim)

        if (traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found in ${st} — ${et}` }] }
        }

        const lines: string[] = [
          `## Slowest Traces`,
          `Time range: ${st} — ${et}`,
        ]

        if (stats) {
          lines.push(
            ``,
            `Duration Percentiles:`,
            `  P50: ${formatDurationFromMs(stats.p50DurationMs)}`,
            `  P95: ${formatDurationFromMs(stats.p95DurationMs)}`,
            `  Min: ${formatDurationFromMs(stats.minDurationMs)}`,
            `  Max: ${formatDurationFromMs(stats.maxDurationMs)}`,
          )
        }

        lines.push(``)

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
          `\`inspect_trace trace_id="${t.traceId}"\` — find bottleneck spans`
        )
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "find_slow_traces",
            data: {
              timeRange: { start: st, end: et },
              stats: stats
                ? {
                    p50Ms: stats.p50DurationMs,
                    p95Ms: stats.p95DurationMs,
                    minMs: stats.minDurationMs,
                    maxMs: stats.maxDurationMs,
                  }
                : undefined,
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
