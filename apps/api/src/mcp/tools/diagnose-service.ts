import {
  optionalStringParam,
  requiredStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatDurationFromMs, formatPercent, formatNumber, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { diagnoseService } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
  server.tool(
    "diagnose_service",
    "Deep investigation of one service: health metrics, Apdex, top errors, recent traces and logs. Use after list_services identifies a problem service.",
    Schema.Struct({
      service_name: requiredStringParam("The service name to diagnose"),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    ({ service_name, start_time, end_time, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const tenant = yield* resolveTenant

        const result = yield* diagnoseService({
          serviceName: service_name,
          timeRange: { startTime: st, endTime: et },
          environment: environment ?? undefined,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "service_overview" })),
        )

        const h = result.health
        const lines: string[] = [
          `## Diagnosis: ${service_name}`,
          `Time range: ${st} — ${et}`,
          ``,
          `Health Metrics:`,
          `  Throughput: ${formatNumber(h.throughput)} spans`,
          `  Error Rate: ${formatPercent(h.errorRate)} (${formatNumber(h.errorCount)} errors)`,
          `  P50 Latency: ${formatDurationFromMs(h.p50Ms)}`,
          `  P95 Latency: ${formatDurationFromMs(h.p95Ms)}`,
          `  P99 Latency: ${formatDurationFromMs(h.p99Ms)}`,
          `  Apdex Score: ${h.apdex.toFixed(3)}`,
        ]

        if (result.topErrors.length > 0) {
          lines.push(``, `Top Errors:`)
          for (const e of result.topErrors) {
            lines.push(`  - ${truncate(e.errorType, 80)} (${formatNumber(e.count)}x)`)
          }
        } else {
          lines.push(``, `No errors found for this service.`)
        }

        if (result.recentTraces.length > 0) {
          lines.push(``, `Recent Traces:`)
          for (const t of result.recentTraces) {
            const err = t.hasError ? " [Error]" : ""
            lines.push(`  ${t.traceId.slice(0, 12)}... ${t.rootSpanName} (${formatDurationFromMs(t.durationMs)})${err}`)
          }
        }

        if (result.recentLogs.length > 0) {
          lines.push(``, `Recent Logs:`)
          for (const log of result.recentLogs) {
            const time = log.timestamp.split(" ")[1] ?? log.timestamp
            const sev = log.severityText.padEnd(5)
            lines.push(`  ${time} [${sev}] ${truncate(log.body, 100)}`)
          }
        }

        const nextSteps: string[] = []
        if (result.topErrors.length > 0) {
          nextSteps.push(`\`find_errors service="${service_name}"\` — see all error types`)
        }
        if (h.p95Ms > 500) {
          nextSteps.push(`\`find_slow_traces service="${service_name}"\` — find slow traces`)
        }
        for (const t of Arr.take(Arr.filter(result.recentTraces, (t) => t.hasError), 2)) {
          nextSteps.push(`\`inspect_trace trace_id="${t.traceId}"\` — inspect error trace`)
        }
        nextSteps.push(`\`service_map service_name="${service_name}"\` — see upstream/downstream dependencies`)
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "diagnose_service",
            data: {
              serviceName: service_name,
              timeRange: { start: st, end: et },
              health: h,
              topErrors: [...result.topErrors],
              recentTraces: Arr.map(result.recentTraces, (t) => ({
                traceId: t.traceId,
                rootSpanName: t.rootSpanName,
                durationMs: t.durationMs,
                spanCount: 1,
                services: [],
                hasError: t.hasError,
              })),
              recentLogs: Arr.map(result.recentLogs, (l) => ({ ...l })),
            },
          }),
        }
      }),
  )
}
