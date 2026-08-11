import { McpQueryError, requiredStringParam, validationError, type McpToolRegistrar } from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { resolveActorId } from "@/mcp/lib/resolve-actor"
import { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

export function registerHeartbeatErrorIssueTool(server: McpToolRegistrar) {
	server.tool(
		"heartbeat_error_issue",
		"Extend the lease on a claimed error issue. Call this periodically while you work; if the lease expires, the issue drops back to 'todo' and any actor can re-claim it.",
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
		}),
		Effect.fn("McpTool.heartbeatErrorIssue")(function* ({ issue_id }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}

			const actorId = yield* resolveActorId(tenant)
			const workflow = yield* ErrorIssueWorkflowService
			const issue = yield* workflow.heartbeatIssue(tenant.orgId, actorId, decodedIssueId.value).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "heartbeat_error_issue",
							cause: error,
						}),
				),
			)

			if (!issue.leaseExpiresAt) {
				return validationError("Heartbeat returned no lease expiry.")
			}

			const lines = [
				`## Lease extended`,
				`- ID: ${issue.id}`,
				`- Lease expires: ${issue.leaseExpiresAt}`,
			]

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "heartbeat_error_issue",
					data: {
						id: issue.id,
						leaseExpiresAt: issue.leaseExpiresAt,
					},
				}),
			}
		}),
	)
}
