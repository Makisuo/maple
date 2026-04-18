import {
  McpQueryError,
  optionalStringParam,
  requiredStringParam,
  validationError,
  type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import {
  ErrorIssueId,
  ErrorIssueStatus,
  UserId,
} from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)
const decodeIssueStatus = Schema.decodeUnknownOption(ErrorIssueStatus)
const decodeUserId = Schema.decodeUnknownOption(UserId)

export function registerUpdateErrorIssueTool(server: McpToolRegistrar) {
  server.tool(
    "update_error_issue",
    "Update a triageable error issue: change status (open/resolved/ignored/archived), set the assignee, or edit notes. Resolving an issue auto-closes any open incident; new occurrences after resolve will open a regression incident.",
    Schema.Struct({
      issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
      status: optionalStringParam(
        "New status: open, resolved, ignored, or archived",
      ),
      assigned_to: optionalStringParam("User ID, or empty string to unassign"),
      notes: optionalStringParam("Triage notes. Pass empty string to clear."),
    }),
    Effect.fn("McpTool.updateErrorIssue")(function* ({
      issue_id,
      status,
      assigned_to,
      notes,
    }) {
      const tenant = yield* resolveTenant
      yield* Effect.annotateCurrentSpan({
        orgId: tenant.orgId,
        issueId: issue_id,
        action: status ?? "patch",
      })
      const errors = yield* ErrorsService

      const decodedIssueId = decodeIssueId(issue_id)
      if (Option.isNone(decodedIssueId)) {
        return validationError(
          `Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
        )
      }
      const issueId = decodedIssueId.value

      let typedStatus: ErrorIssueStatus | undefined
      if (status) {
        const decoded = decodeIssueStatus(status)
        if (Option.isNone(decoded)) {
          return validationError(
            `Invalid status: '${status}'. Must be one of: open, resolved, ignored, archived.`,
          )
        }
        typedStatus = decoded.value
      }

      let typedAssignedTo: UserId | null | undefined
      if (assigned_to !== undefined) {
        if (assigned_to === "") {
          typedAssignedTo = null
        } else {
          const decoded = decodeUserId(assigned_to)
          if (Option.isNone(decoded)) {
            return validationError(
              `Invalid assigned_to: '${assigned_to}'. Must be a non-empty user id.`,
            )
          }
          typedAssignedTo = decoded.value
        }
      }

      const patch: {
        status?: ErrorIssueStatus
        assignedTo?: UserId | null
        notes?: string | null
      } = {}
      if (typedStatus !== undefined) patch.status = typedStatus
      if (typedAssignedTo !== undefined) patch.assignedTo = typedAssignedTo
      if (notes !== undefined) patch.notes = notes === "" ? null : notes

      const issue = yield* errors
        .updateIssue(tenant.orgId, tenant.userId, issueId, patch)
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "update_error_issue",
                cause: error,
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
