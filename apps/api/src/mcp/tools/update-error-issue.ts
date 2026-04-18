import {
  McpQueryError,
  optionalStringParam,
  requiredStringParam,
  validationError,
  type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import { Schema as S } from "effect"
import {
  type ErrorIssueId,
  type ErrorIssueStatus,
  UserId,
} from "@maple/domain/http"

const decodeUserIdSync = S.decodeUnknownSync(UserId)

const validStatuses: ReadonlyArray<ErrorIssueStatus> = [
  "open",
  "resolved",
  "ignored",
  "archived",
]

export function registerUpdateErrorIssueTool(server: McpToolRegistrar) {
  server.tool(
    "update_error_issue",
    "Update a triageable error issue: change status (open/resolved/ignored/archived), set the assignee, or edit notes. Resolving an issue auto-closes any open incident; new occurrences after resolve will open a regression incident.",
    Schema.Struct({
      issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
      status: optionalStringParam(
        "New status: open, resolved, ignored, or archived",
      ),
      assigned_to: optionalStringParam("User ID / email, or empty string to unassign"),
      notes: optionalStringParam("Triage notes. Pass empty string to clear."),
    }),
    Effect.fn("McpTool.updateErrorIssue")(function* ({
      issue_id,
      status,
      assigned_to,
      notes,
    }) {
      if (status && !validStatuses.includes(status as ErrorIssueStatus)) {
        return validationError(
          `Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}.`,
        )
      }

      const tenant = yield* resolveTenant
      const errors = yield* ErrorsService

      const patch: {
        -readonly [K in keyof Parameters<typeof errors.updateIssue>[3]]: Parameters<
          typeof errors.updateIssue
        >[3][K]
      } = {}
      if (status) patch.status = status as ErrorIssueStatus
      if (assigned_to !== undefined) {
        patch.assignedTo = assigned_to === "" ? null : decodeUserIdSync(assigned_to)
      }
      if (notes !== undefined) {
        patch.notes = notes === "" ? null : notes
      }

      const issue = yield* errors
        .updateIssue(tenant.orgId, tenant.userId, issue_id as ErrorIssueId, patch)
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: "message" in error ? error.message : String(error),
                pipe: "update_error_issue",
              }),
          ),
        )

      const lines = [
        `## Error issue updated`,
        `- ID: ${issue.id}`,
        `- Status: ${issue.status}`,
        `- Service: ${issue.serviceName}`,
        `- Exception: ${issue.exceptionType}`,
        `- Assigned: ${issue.assignedTo ?? "—"}`,
        `- Notes: ${issue.notes ?? "—"}`,
      ]

      return {
        content: createDualContent(lines.join("\n"), {
          tool: "update_error_issue",
          data: {
            id: issue.id,
            status: issue.status,
            assignedTo: issue.assignedTo,
            notes: issue.notes,
            resolvedAt: issue.resolvedAt,
          },
        }),
      }
    }),
  )
}
