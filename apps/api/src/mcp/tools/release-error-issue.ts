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
import { resolveActorId } from "../lib/resolve-actor"
import { ErrorsService } from "@/services/ErrorsService"
import { ErrorIssueId, WorkflowState } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)
const decodeWorkflowState = Schema.decodeUnknownOption(WorkflowState)

export function registerReleaseErrorIssueTool(server: McpToolRegistrar) {
  server.tool(
    "release_error_issue",
    "Release the lease on an error issue you previously claimed, optionally transitioning it to another workflow state (default: 'todo').",
    Schema.Struct({
      issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
      transition_to: optionalStringParam(
        "Workflow state to land in after release (default: 'todo')",
      ),
      note: optionalStringParam("Optional reasoning / context"),
    }),
    Effect.fn("McpTool.releaseErrorIssue")(function* ({
      issue_id,
      transition_to,
      note,
    }) {
      const tenant = yield* resolveTenant
      const decodedIssueId = decodeIssueId(issue_id)
      if (Option.isNone(decodedIssueId)) {
        return validationError(
          `Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
        )
      }
      let typedState: WorkflowState | undefined
      if (transition_to) {
        const decoded = decodeWorkflowState(transition_to)
        if (Option.isNone(decoded)) {
          return validationError(
            `Invalid transition_to: '${transition_to}'. Must be a valid workflow state.`,
          )
        }
        typedState = decoded.value
      }

      const actorId = yield* resolveActorId(tenant)
      const errors = yield* ErrorsService
      const issue = yield* errors
        .releaseIssue(tenant.orgId, actorId, decodedIssueId.value, {
          transitionTo: typedState,
          note,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "release_error_issue",
                cause: error,
              }),
          ),
        )

      const lines = [
        `## Error issue released`,
        `- ID: ${issue.id}`,
        `- State: ${issue.workflowState}`,
      ]

      return {
        content: createDualContent(lines.join("\n"), {
          tool: "release_error_issue",
          data: {
            id: issue.id,
            workflowState: issue.workflowState,
            previousLeaseHolderActorId: actorId,
          },
        }),
      }
    }),
  )
}
