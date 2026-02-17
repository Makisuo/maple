import {
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { defaultTimeRange } from "../lib/time"
import { formatDurationFromMs, formatPercent, formatNumber, truncate } from "../lib/format"
import { Effect } from "effect"

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
  server.tool(
    "diagnose_service",
    "Deep investigation of a single service: health metrics, top errors, recent logs, slow traces, and Apdex score.",
    {
      service_name: requiredStringParam("The service name to diagnose"),
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
    },
    ({ service_name, start_time, end_time }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime

        const [overviewResult, errorsResult, logsResult, tracesResult, apdexResult] =
          yield* Effect.all(
            [
              queryTinybird("service_overview", { start_time: st, end_time: et }),
              queryTinybird("errors_by_type", {
                start_time: st,
                end_time: et,
                services: service_name,
                limit: 10,
                exclude_spam_patterns: getSpamPatternsParam(),
              }),
              queryTinybird("list_logs", {
                start_time: st,
                end_time: et,
                service: service_name,
                limit: 15,
              }),
              queryTinybird("list_traces", {
                start_time: st,
                end_time: et,
                service: service_name,
                limit: 5,
              }),
              queryTinybird("service_apdex_time_series", {
                service_name,
                start_time: st,
                end_time: et,
                bucket_seconds: 300,
              }),
            ],
            { concurrency: "unbounded" },
          )

        // Aggregate service overview rows for this service
        const svcRows = overviewResult.data.filter(
          (r) => r.serviceName === service_name,
        )
        let throughput = 0
        let errorCount = 0
        let weightedP50 = 0
        let weightedP95 = 0
        let weightedP99 = 0
        for (const r of svcRows) {
          const tp = Number(r.throughput)
          throughput += tp
          errorCount += Number(r.errorCount)
          weightedP50 += r.p50LatencyMs * tp
          weightedP95 += r.p95LatencyMs * tp
          weightedP99 += r.p99LatencyMs * tp
        }
        const errorRate = throughput > 0 ? (errorCount / throughput) * 100 : 0
        const p50 = throughput > 0 ? weightedP50 / throughput : 0
        const p95 = throughput > 0 ? weightedP95 / throughput : 0
        const p99 = throughput > 0 ? weightedP99 / throughput : 0

        // Compute average Apdex
        const apdexValues = apdexResult.data.filter(
          (a) => Number(a.totalCount) > 0,
        )
        const avgApdex =
          apdexValues.length > 0
            ? apdexValues.reduce((sum, a) => sum + a.apdexScore, 0) /
              apdexValues.length
            : 0

        const lines: string[] = [
          `=== Diagnosis: ${service_name} ===`,
          `Time range: ${st} — ${et}`,
          ``,
          `Health Metrics:`,
          `  Throughput: ${formatNumber(throughput)} spans`,
          `  Error Rate: ${formatPercent(errorRate)} (${formatNumber(errorCount)} errors)`,
          `  P50 Latency: ${formatDurationFromMs(p50)}`,
          `  P95 Latency: ${formatDurationFromMs(p95)}`,
          `  P99 Latency: ${formatDurationFromMs(p99)}`,
          `  Apdex Score: ${avgApdex.toFixed(3)}`,
        ]

        // Errors
        if (errorsResult.data.length > 0) {
          lines.push(``, `Top Errors:`)
          for (const e of errorsResult.data) {
            lines.push(
              `  - ${truncate(e.errorType, 80)} (${formatNumber(e.count)}x)`,
            )
          }
        } else {
          lines.push(``, `No errors found for this service.`)
        }

        // Recent traces
        if (tracesResult.data.length > 0) {
          lines.push(``, `Recent Traces:`)
          for (const t of tracesResult.data) {
            const dur = Number(t.durationMicros) / 1000
            const err = Number(t.hasError) ? " [Error]" : ""
            lines.push(
              `  ${t.traceId.slice(0, 12)}... ${t.rootSpanName} (${formatDurationFromMs(dur)})${err}`,
            )
          }
        }

        // Recent logs
        if (logsResult.data.length > 0) {
          lines.push(``, `Recent Logs:`)
          for (const log of logsResult.data) {
            const ts = String(log.timestamp)
            const time = ts.split(" ")[1] ?? ts
            const sev = (log.severityText || "INFO").padEnd(5)
            lines.push(`  ${time} [${sev}] ${truncate(log.body, 100)}`)
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
