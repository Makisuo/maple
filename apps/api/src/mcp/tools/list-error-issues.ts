import {
  McpQueryError,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatNumber, formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import type { ErrorIssueStatus } from "@maple/domain/http"

export function registerListErrorIssuesTool(server: McpToolRegistrar) {
  server.tool(
    "list_error_issues",
    "List persistent, triageable error issues (grouped by exception fingerprint) with status, counts, and assignment. Each issue persists across occurrences so status/notes/assignee survive new events.",
    Schema.Struct({
      status: optionalStringParam(
        "Filter by status: open, resolved, ignored, archived (default: all)",
      ),
      service: optionalStringParam("Filter by service name"),
      limit: optionalNumberParam("Max results (default 50)"),
    }),
    Effect.fn("McpTool.listErrorIssues")(function* ({ status, service, limit }) {
      const tenant = yield* resolveTenant
      const errors = yield* ErrorsService

      const result = yield* errors
        .listIssues(tenant.orgId, {
          status: status as ErrorIssueStatus | undefined,
          service,
          limit: limit ?? 50,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({ message: error.message, pipe: "list_error_issues" }),
          ),
        )

      const issues = result.issues

      const lines: string[] = [`## Error Issues`, `Total: ${issues.length}`, ``]

      if (issues.length === 0) {
        lines.push("No error issues found.")
      } else {
        const headers = [
          "ID",
          "Status",
          "Service",
          "Exception",
          "Events",
          "Last seen",
          "Assigned",
        ]
        const rows = issues.map((i) => [
          i.id.slice(0, 8),
          i.hasOpenIncident ? `${i.status} (incident)` : i.status,
          i.serviceName,
          truncate(`${i.exceptionType}: ${i.exceptionMessage}`, 50),
          formatNumber(i.occurrenceCount),
          i.lastSeenAt.slice(0, 19),
          i.assignedTo ?? "—",
        ])
        lines.push(formatTable(headers, rows))
      }

      const openIds = issues
        .filter((i) => i.status === "open")
        .slice(0, 3)
        .map((i) => i.id)
      const nextSteps: string[] = []
      for (const id of openIds) {
        nextSteps.push(`\`get_error_issue issue_id="${id}"\` — see samples, timeseries, incidents`)
        nextSteps.push(
          `\`update_error_issue issue_id="${id}" status="resolved"\` — mark fixed`,
        )
      }
      lines.push(formatNextSteps(nextSteps))

      return {
        content: createDualContent(lines.join("\n"), {
          tool: "list_error_issues",
          data: {
            issues: issues.map((i) => ({
              id: i.id,
              fingerprintHash: i.fingerprintHash,
              status: i.status,
              serviceName: i.serviceName,
              exceptionType: i.exceptionType,
              exceptionMessage: i.exceptionMessage,
              topFrame: i.topFrame,
              occurrenceCount: i.occurrenceCount,
              firstSeenAt: i.firstSeenAt,
              lastSeenAt: i.lastSeenAt,
              assignedTo: i.assignedTo,
              notes: i.notes,
              hasOpenIncident: i.hasOpenIncident,
            })),
            total: issues.length,
          },
        }),
      }
    }),
  )
}
