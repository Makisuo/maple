import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveActorId } from "@/mcp/lib/resolve-actor"
import { ErrorsService } from "@/services/errors/ErrorsService"
import {
	ErrorIssueId,
	MACHINE_OWNED_WORKFLOW_STATES,
	WORKFLOW_STATE_ORDER,
	WorkflowState,
	describeWorkflowTransitions,
} from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)
const decodeWorkflowState = Schema.decodeUnknownOption(WorkflowState)
/** What a caller may ask for — machine-owned states are not offered. */
const SELECTABLE_STATES = WORKFLOW_STATE_ORDER.filter((state) => !MACHINE_OWNED_WORKFLOW_STATES.has(state))

export function registerTransitionErrorIssueTool(server: McpToolRegistrar) {
	server.tool(
		"transition_error_issue",
		`Move an error issue to a new workflow state. Valid transitions: ${describeWorkflowTransitions()}.`,
		Schema.Struct({
			issue_id: requiredStringParam("The error issue ID (from list_error_issues)"),
			to_state: requiredStringParam(`Target workflow state: ${SELECTABLE_STATES.join(", ")}`),
			note: optionalStringParam("Optional reasoning / context, stored on the event"),
			snooze_until: optionalStringParam(
				"ISO datetime for 'wontfix' transition. The issue re-opens as 'triage' if new events arrive after this time.",
			),
		}),
		Effect.fn("McpTool.transitionErrorIssue")(function* ({ issue_id, to_state, note, snooze_until }) {
			const tenant = yield* CurrentMcpTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			const decodedState = decodeWorkflowState(to_state)
			if (Option.isNone(decodedState)) {
				return validationError(
					`Invalid to_state: '${to_state}'. Must be one of: ${SELECTABLE_STATES.join(", ")}.`,
				)
			}
			// `regressed` is an observation the errors tick makes, not a state an
			// agent asserts — and the next tick would overwrite the claim anyway.
			if (MACHINE_OWNED_WORKFLOW_STATES.has(decodedState.value)) {
				return validationError(
					`'${to_state}' is set by the errors tick when a resolved issue fires from a build that was not running when it was fixed. Move the issue to one of: ${SELECTABLE_STATES.join(", ")}.`,
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
								pipeName: "transition_error_issue",
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
