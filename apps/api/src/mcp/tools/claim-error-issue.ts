import {
	McpQueryError,
	optionalNumberParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveActorId } from "../lib/resolve-actor"
import { ErrorsService } from "@/services/ErrorsService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

export function registerClaimErrorIssueTool(server: McpToolRegistrar) {
	server.tool(
		"claim_error_issue",
		"Claim a lease on an error issue so other agents don't duplicate work. Issues in 'triage' or 'todo' auto-transition to 'in_progress' on claim. Lease defaults to 30 min; call heartbeat_error_issue before it expires or the issue drops back to 'todo'.",
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			lease_duration_seconds: optionalNumberParam(
				"Lease TTL in seconds (60..7200). Default: 1800 (30 min).",
			),
		}),
		Effect.fn("McpTool.claimErrorIssue")(function* ({ issue_id, lease_duration_seconds }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			if (
				lease_duration_seconds !== undefined &&
				(lease_duration_seconds < 60 || lease_duration_seconds > 7200)
			) {
				return validationError(
					`Invalid lease_duration_seconds: ${lease_duration_seconds}. Must be between 60 and 7200.`,
				)
			}

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const leaseMs = lease_duration_seconds !== undefined ? lease_duration_seconds * 1000 : undefined

			const issue = yield* errors.claimIssue(tenant.orgId, actorId, decodedIssueId.value, leaseMs).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "claim_error_issue",
							cause: error,
						}),
				),
			)

			const lines = [
				`## Error issue claimed`,
				`- ID: ${issue.id}`,
				`- State: ${issue.workflowState}`,
				`- Lease expires: ${issue.leaseExpiresAt ?? "—"}`,
				`- Holder: ${issue.leaseHolder?.agentName ?? issue.leaseHolder?.userId ?? actorId}`,
			]

			if (!issue.leaseHolder || !issue.leaseExpiresAt || !issue.claimedAt) {
				return validationError("Claim succeeded but lease fields were not populated on the issue.")
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "claim_error_issue",
					data: {
						id: issue.id,
						workflowState: issue.workflowState,
						leaseHolderActorId: issue.leaseHolder.id,
						leaseExpiresAt: issue.leaseExpiresAt,
						claimedAt: issue.claimedAt,
					},
				}),
			}
		}),
	)
}
