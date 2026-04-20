import {
  McpQueryError,
  optionalNumberParam,
  optionalStringParam,
  validationError,
  type McpToolRegistrar,
} from "./types"
import { formatNumber, formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import { WorkflowState } from "@maple/domain/http"

const decodeWorkflowState = Schema.decodeUnknownOption(WorkflowState)

export function registerListErrorIssuesTool(server: McpToolRegistrar) {
  server.tool(
    "list_error_issues",
    "List persistent, triageable error issues (grouped by exception fingerprint) with workflow state, counts, and assignment. Each issue persists across occurrences so state/notes/assignee survive new events. Workflow states: triage, todo, in_progress, in_review, done, cancelled, wontfix.",
    Schema.Struct({
      workflow_state: optionalStringParam(
        "Filter by workflow state: triage, todo, in_progress, in_review, done, cancelled, wontfix (default: all non-archived)",
      ),
      service: optionalStringParam("Filter by service name"),
      limit: optionalNumberParam("Max results (default 50)"),
      include_archived: optionalStringParam(
        "Pass '1' to include archived issues in results",
      ),
    }),
    Effect.fn("McpTool.listErrorIssues")(function* ({
      workflow_state,
      service,
      limit,
      include_archived,
    }) {
      const tenant = yield* resolveTenant
      yield* Effect.annotateCurrentSpan({
        orgId: tenant.orgId,
        workflowState: workflow_state ?? "all",
        service: service ?? "all",
        limit: limit ?? 50,
      })
      const errors = yield* ErrorsService

      let typedState: WorkflowState | undefined
      if (workflow_state) {
        const decoded = decodeWorkflowState(workflow_state)
        if (Option.isNone(decoded)) {
          return validationError(
            `Invalid workflow_state: '${workflow_state}'. Must be one of: triage, todo, in_progress, in_review, done, cancelled, wontfix.`,
          )
        }
        typedState = decoded.value
      }

      const result = yield* errors
        .listIssues(tenant.orgId, {
          workflowState: typedState,
          service,
          limit: limit ?? 50,
          includeArchived: include_archived === "1",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_error_issues",
                cause: error,
              }),
          ),
        )

      yield* Effect.annotateCurrentSpan("resultCount", result.issues.length)

      const issues = result.issues

      const lines: string[] = [`## Error Issues`, `Total: ${issues.length}`, ``]

      if (issues.length === 0) {
        lines.push("No error issues found.")
      } else {
        const headers = [
          "ID",
          "State",
          "Priority",
          "Service",
          "Exception",
          "Events",
          "Last seen",
          "Assigned",
          "Holder",
        ]
        const rows = issues.map((i) => [
          i.id.slice(0, 8),
          i.hasOpenIncident ? `${i.workflowState} (incident)` : i.workflowState,
          String(i.priority),
          i.serviceName,
          truncate(`${i.exceptionType}: ${i.exceptionMessage}`, 50),
          formatNumber(i.occurrenceCount),
          i.lastSeenAt.slice(0, 19),
          i.assignedActor
            ? i.assignedActor.type === "agent"
              ? `agent:${i.assignedActor.agentName ?? "?"}`
              : i.assignedActor.userId ?? "user"
            : "—",
          i.leaseHolder
            ? i.leaseHolder.type === "agent"
              ? `agent:${i.leaseHolder.agentName ?? "?"}`
              : i.leaseHolder.userId ?? "user"
            : "—",
        ])
        lines.push(formatTable(headers, rows))
      }

      const triageIds = issues
        .filter((i) => i.workflowState === "triage")
        .slice(0, 3)
        .map((i) => i.id)
      const nextSteps: string[] = []
      for (const id of triageIds) {
        nextSteps.push(`\`claim_error_issue issue_id="${id}"\` — pick up this issue`)
        nextSteps.push(
          `\`transition_error_issue issue_id="${id}" to_state="todo"\` — move to backlog`,
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
              workflowState: i.workflowState,
              priority: i.priority,
              serviceName: i.serviceName,
              exceptionType: i.exceptionType,
              exceptionMessage: i.exceptionMessage,
              topFrame: i.topFrame,
              occurrenceCount: i.occurrenceCount,
              firstSeenAt: i.firstSeenAt,
              lastSeenAt: i.lastSeenAt,
              assignedActor: i.assignedActor
                ? {
                    id: i.assignedActor.id,
                    type: i.assignedActor.type,
                    userId: i.assignedActor.userId,
                    agentName: i.assignedActor.agentName,
                    model: i.assignedActor.model,
                    capabilities: i.assignedActor.capabilities,
                  }
                : null,
              leaseHolder: i.leaseHolder
                ? {
                    id: i.leaseHolder.id,
                    type: i.leaseHolder.type,
                    userId: i.leaseHolder.userId,
                    agentName: i.leaseHolder.agentName,
                    model: i.leaseHolder.model,
                    capabilities: i.leaseHolder.capabilities,
                  }
                : null,
              leaseExpiresAt: i.leaseExpiresAt,
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
