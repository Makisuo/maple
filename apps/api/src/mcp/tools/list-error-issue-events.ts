import {
  McpQueryError,
  optionalNumberParam,
  requiredStringParam,
  validationError,
  type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { formatTable } from "../lib/format"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

export function registerListErrorIssueEventsTool(server: McpToolRegistrar) {
  server.tool(
    "list_error_issue_events",
    "List the audit-log events for an issue (state transitions, claims, comments, agent notes, fix proposals) in reverse-chronological order.",
    Schema.Struct({
      issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
      limit: optionalNumberParam("Max events (default 100, max 500)"),
    }),
    Effect.fn("McpTool.listErrorIssueEvents")(function* ({ issue_id, limit }) {
      const tenant = yield* resolveTenant
      const decodedIssueId = decodeIssueId(issue_id)
      if (Option.isNone(decodedIssueId)) {
        return validationError(
          `Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
        )
      }

      const errors = yield* ErrorsService
      const response = yield* errors
        .listIssueEvents(tenant.orgId, decodedIssueId.value, { limit })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_error_issue_events",
                cause: error,
              }),
          ),
        )

      const events = response.events

      const lines: string[] = [
        `## Issue events`,
        `Total: ${events.length}`,
        ``,
      ]

      if (events.length === 0) {
        lines.push("No events recorded for this issue.")
      } else {
        const headers = ["Time", "Type", "From", "To", "Actor"]
        const rows = events.map((e) => [
          e.createdAt.slice(0, 19),
          e.type,
          e.fromState ?? "—",
          e.toState ?? "—",
          e.actor
            ? e.actor.type === "agent"
              ? `agent:${e.actor.agentName ?? "?"}`
              : e.actor.userId ?? "user"
            : "system",
        ])
        lines.push(formatTable(headers, rows))
      }

      return {
        content: createDualContent(lines.join("\n"), {
          tool: "list_error_issue_events",
          data: {
            issueId: decodedIssueId.value,
            events: events.map((e) => ({
              id: e.id,
              type: e.type,
              fromState: e.fromState,
              toState: e.toState,
              actorId: e.actor?.id ?? null,
              createdAt: e.createdAt,
              payload: e.payload,
            })),
            total: events.length,
          },
        }),
      }
    }),
  )
}
