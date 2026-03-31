import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatDurationFromMs, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { errorDetail } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

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
        const tenant = yield* resolveTenant

        const result = yield* errorDetail({
          errorType: error_type,
          timeRange: { startTime: st, endTime: et },
          service: service ?? undefined,
          includeTimeseries: include_timeseries ?? false,
          limit: limit ?? 5,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "error_detail_traces" })),
        )

        if (result.traces.length === 0) {
          return { content: [{ type: "text", text: `No traces found for error type "${error_type}" in ${st} — ${et}` }] }
        }

        const lines: string[] = [
          `## Error Detail: "${truncate(error_type, 80)}"`,
          `Time range: ${st} — ${et}`,
          `Sample traces: ${result.traces.length}`,
          ``,
        ]

        for (let i = 0; i < result.traces.length; i++) {
          const t = result.traces[i]!
          lines.push(
            `### Trace ${i + 1}: ${t.traceId.slice(0, 16)}...`,
            `  Root span: ${t.rootSpanName}`,
            `  Duration: ${formatDurationFromMs(t.durationMs)}`,
            `  Spans: ${t.spanCount}`,
            `  Services: ${t.services.join(", ")}`,
            `  Time: ${t.startTime}`,
          )
          if (t.errorMessage) {
            lines.push(`  Error: ${truncate(t.errorMessage, 120)}`)
          }
          if (t.logs.length > 0) {
            lines.push(`  Logs (${t.logs.length}):`)
            for (const log of t.logs) {
              const time = log.timestamp.split(" ")[1] ?? log.timestamp
              const sev = log.severityText.padEnd(5)
              lines.push(`    ${time} [${sev}] ${truncate(log.body, 90)}`)
            }
          }
          lines.push(``)
        }

        if (result.timeseries && result.timeseries.length > 0) {
          lines.push(`### Error Trend`)
          for (const point of result.timeseries) {
            const time = point.bucket.includes("T") ? point.bucket.slice(11, 19) : point.bucket.split(" ")[1] ?? point.bucket
            lines.push(`  ${time}: ${point.count} errors`)
          }
          lines.push(``)
        }

        const nextSteps = result.traces.slice(0, 3).map((t) =>
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
              traces: result.traces.map((t) => ({
                traceId: t.traceId,
                rootSpanName: t.rootSpanName,
                durationMs: t.durationMs,
                spanCount: t.spanCount,
                services: [...t.services],
                startTime: t.startTime,
                errorMessage: t.errorMessage || undefined,
                logs: t.logs.map((l) => ({ ...l })),
              })),
            },
          }),
        }
      }),
  )
}
