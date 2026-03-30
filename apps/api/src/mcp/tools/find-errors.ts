import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

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

        const result = yield* queryTinybird("errors_by_type", {
          start_time: st,
          end_time: et,
          services: service,
          ...(environment && { deployment_envs: environment }),
          limit: limit ?? 20,
          exclude_spam_patterns: getSpamPatternsParam(),
        })

        if (result.data.length === 0) {
          return { content: [{ type: "text", text: `No errors found in ${st} — ${et}` }] }
        }

        const lines: string[] = [
          `## Errors by Type`,
          ``,
        ]

        const headers = ["Error Type", "Count", "Services", "Last Seen"]
        const rows = result.data.map((e) => [
          e.errorType.length > 60 ? e.errorType.slice(0, 57) + "..." : e.errorType,
          formatNumber(e.count),
          e.affectedServices.join(", "),
          String(e.lastSeen),
        ])

        lines.push(formatTable(headers, rows))
        lines.push(``, `Total: ${result.data.length} error types`)

        const nextSteps: string[] = []
        for (const e of result.data.slice(0, 3)) {
          const errorTypeShort = e.errorType.length > 50 ? e.errorType.slice(0, 47) + "..." : e.errorType
          nextSteps.push(`\`error_detail error_type="${errorTypeShort}"\` — see sample traces and logs`)
        }
        nextSteps.push('`query_data source="traces" kind="timeseries" metric="error_rate"` — chart error rate trend')
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "find_errors",
            data: {
              timeRange: { start: st, end: et },
              errors: result.data.map((e) => ({
                errorType: e.errorType,
                count: Number(e.count),
                affectedServices: e.affectedServices,
                lastSeen: String(e.lastSeen),
              })),
            },
          }),
        }
      }),
  )
}
