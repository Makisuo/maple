import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { defaultTimeRange } from "../lib/time"
import { formatDurationMs, formatDurationFromMs, formatTable } from "../lib/format"
import { Effect } from "effect"

export function registerFindSlowTracesTool(server: McpToolRegistrar) {
  server.tool(
    "find_slow_traces",
    "Find the slowest traces with percentile context (P50, P95 benchmarks).",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter by service name"),
      limit: optionalNumberParam("Max results (default 10)"),
    },
    ({ start_time, end_time, service, limit }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime
        const lim = limit ?? 10

        const [tracesResult, statsResult] = yield* Effect.all(
          [
            queryTinybird("list_traces", {
              start_time: st,
              end_time: et,
              service,
              limit: lim,
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
        const traces = [...tracesResult.data].sort(
          (a, b) => Number(b.durationMicros) - Number(a.durationMicros),
        )

        if (traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found in ${st} — ${et}` }] }
        }

        const lines: string[] = [
          `=== Slowest Traces ===`,
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

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
