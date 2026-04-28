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

export function registerTransitionErrorIssueTool(server: McpToolRegistrar) {
	server.tool(
		"transition_error_issue",
		"Move an error issue to a new workflow state. Valid transitions: triage→(todo|in_progress|cancelled|wontfix); todo→(triage|in_progress|cancelled|wontfix); in_progress→(triage|todo|in_review|cancelled|wontfix); in_review→(triage|in_progress|done|cancelled|wontfix); done→(triage|in_progress|cancelled|wontfix); wontfix→(triage|cancelled).",
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			to_state: requiredStringParam(
				"Target workflow state: triage, todo, in_progress, in_review, done, cancelled, wontfix",
			),
			note: optionalStringParam("Optional reasoning / context, stored on the event"),
			snooze_until: optionalStringParam(
				"ISO datetime for 'wontfix' transition. The issue re-opens as 'triage' if new events arrive after this time.",
			),
		}),
		Effect.fn("McpTool.transitionErrorIssue")(function* ({ issue_id, to_state, note, snooze_until }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			const decodedState = decodeWorkflowState(to_state)
			if (Option.isNone(decodedState)) {
				return validationError(
					`Invalid to_state: '${to_state}'. Must be one of: triage, todo, in_progress, in_review, done, cancelled, wontfix.`,
				)
			}

			const actorId = yield* resolveActorId(tenant)
			const errors = yield* ErrorsService
			const issue = yield* errors
				.transitionIssue(tenant.orgId, actorId, decodedIssueId.value, decodedState.value, {
					note,
					snoozeUntil: snooze_until,
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipe: "transition_error_issue",
								cause: error,
							}),
					),
				)

			const lines = [
				`## Error issue transitioned`,
				`- ID: ${issue.id}`,
				`- State: ${issue.workflowState}`,
				`- Service: ${issue.serviceName}`,
				`- Exception: ${issue.exceptionType}`,
				note ? `- Note: ${note}` : null,
			].filter((l): l is string => l !== null)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "transition_error_issue",
					data: {
						id: issue.id,
						workflowState: issue.workflowState,
						fromState: "",
						toState: issue.workflowState,
						assignedActorId: issue.assignedActor?.id ?? null,
						leaseHolderActorId: issue.leaseHolder?.id ?? null,
						snoozeUntil: issue.snoozeUntil,
					},
				}),
			}
		}),
	)
}
