import {
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatPercent, formatDurationFromMs, formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { createDualContent } from "../lib/structured-output"
import { Effect, Layer, Schema } from "effect"
import { listServices } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"
import { McpQueryError } from "./types"

export function registerListServicesTool(server: McpToolRegistrar) {
  server.tool(
    "list_services",
    "List all active services with key metrics (throughput, error rate, P95 latency). Use as an entry point to discover services before drilling down with diagnose_service or get_service_top_operations.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss UTC)"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
    }),
    ({ start_time, end_time, environment }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const tenant = yield* resolveTenant

        const services = yield* listServices({
          timeRange: { startTime: st, endTime: et },
          environment: environment ?? undefined,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "service_overview" })),
        )

        const lines: string[] = [
          `## Services`,
          `Time range: ${st} — ${et}`,
          `Total: ${services.length} service${services.length !== 1 ? "s" : ""}`,
          ``,
        ]

        if (services.length === 0) {
          lines.push("No active services found in this time range.")
        } else {
          const headers = ["Service", "Throughput (rpm)", "Error Rate", "P95 Latency"]
          const rows = services.map((s) => [
            s.name,
            formatNumber(s.throughput),
            formatPercent(s.errorRate),
            formatDurationFromMs(s.p95Ms),
          ])
          lines.push(formatTable(headers, rows))
        }

        const nextSteps: string[] = []
        for (const s of services.slice(0, 3)) {
          nextSteps.push(`\`diagnose_service service_name="${s.name}"\` — deep-dive into ${s.name}`)
        }
        if (services.length > 0) {
          nextSteps.push(`\`get_service_top_operations service_name="<name>"\` — see top endpoints for a service`)
        }
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_services",
            data: {
              timeRange: { start: st, end: et },
              total: services.length,
              services: services.map((s) => ({
                name: s.name,
                throughput: s.throughput,
                errorRate: s.errorRate,
                p95Ms: s.p95Ms,
              })),
            },
          }),
        }
      }),
  )
}
