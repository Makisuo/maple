import {
  optionalNumberParam,
  optionalStringParam,
  McpQueryError,
  type McpToolRegistrar,
} from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { findErrors } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerFindErrorsTool(server: McpToolRegistrar) {
  server.tool(
    "find_errors",
    "Find and categorize errors by type with counts and affected services. Use error_detail to see sample traces for a specific error type.",
    Schema.Struct({
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter to a specific service"),
      environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
      limit: optionalNumberParam("Max results (default 20)"),
    }),
    ({ start_time, end_time, service, environment, limit }) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(start_time, end_time)
        const tenant = yield* resolveTenant

        const errors = yield* findErrors({
          timeRange: { startTime: st, endTime: et },
          service: service ?? undefined,
          environment: environment ?? undefined,
          limit: limit ?? 20,
        }).pipe(
          Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
          Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "errors_by_type" })),
        )

        if (errors.length === 0) {
          return { content: [{ type: "text", text: `No errors found in ${st} — ${et}` }] }
        }

        const lines: string[] = [`## Errors by Type`, ``]

        const headers = ["Error Type", "Count", "Affected Services", "Last Seen"]
        const rows = Arr.map(errors, (e) => [
          e.errorType.length > 60 ? e.errorType.slice(0, 57) + "..." : e.errorType,
          formatNumber(e.count),
          String(e.affectedServicesCount),
          e.lastSeen,
        ])

        lines.push(formatTable(headers, rows))
        lines.push(``, `Total: ${errors.length} error types`)

        const nextSteps: string[] = []
        for (const e of Arr.take(errors, 3)) {
          const short = e.errorType.length > 50 ? e.errorType.slice(0, 47) + "..." : e.errorType
          nextSteps.push(`\`error_detail error_type="${short}"\` — see sample traces and logs`)
        }
        nextSteps.push('`query_data source="traces" kind="timeseries" metric="error_rate"` — chart error rate trend')
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "find_errors",
            data: {
              timeRange: { start: st, end: et },
              errors: Arr.map(errors, (e) => ({
                errorType: e.errorType,
                count: e.count,
                affectedServicesCount: e.affectedServicesCount,
                lastSeen: e.lastSeen,
              })),
            },
          }),
        }
      }),
  )
}
