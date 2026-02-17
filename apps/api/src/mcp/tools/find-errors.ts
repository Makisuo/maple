import {
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { queryTinybird } from "../lib/query-tinybird"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { defaultTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { Effect } from "effect"

export function registerFindErrorsTool(server: McpToolRegistrar) {
  server.tool(
    "find_errors",
    "Find and categorize errors by type, with counts, affected services, and timestamps.",
    {
      start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
      end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
      service: optionalStringParam("Filter to a specific service"),
      limit: optionalNumberParam("Max results (default 20)"),
    },
    ({ start_time, end_time, service, limit }) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = start_time ?? startTime
        const et = end_time ?? endTime

        const result = yield* queryTinybird("errors_by_type", {
          start_time: st,
          end_time: et,
          services: service,
          limit: limit ?? 20,
          exclude_spam_patterns: getSpamPatternsParam(),
        })

        if (result.data.length === 0) {
          return { content: [{ type: "text", text: `No errors found in ${st} — ${et}` }] }
        }

        const lines: string[] = [
          `=== Errors by Type (${st} — ${et}) ===`,
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

        return { content: [{ type: "text", text: lines.join("\n") }] }
      }),
  )
}
