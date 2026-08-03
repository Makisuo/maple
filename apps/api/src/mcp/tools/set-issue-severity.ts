import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { resolveActorId } from "@/mcp/lib/resolve-actor"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { ErrorIssueId, IssueSeverity } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)
const decodeSeverity = Schema.decodeUnknownOption(IssueSeverity)

export function registerSetIssueSeverityTool(server: McpToolRegistrar) {
	server.tool(
		"set_issue_severity",
		"Set or clear the triage severity of an issue. Severity drives escalation routing (critical/high/medium/low). API-key agents write with 'ai' precedence, so a human's manual severity is never overwritten; human sessions write a sticky manual override.",
		Schema.Struct({
			issue_id: requiredStringParam("The issue ID (from list_error_issues)"),
			severity: requiredStringParam(
				"Target severity: critical, high, medium, low — or 'none' to clear",
			),
			note: optionalStringParam("Optional reasoning / context, stored on the severity event"),
		}),
		Effect.fn("McpTool.setIssueSeverity")(function* ({ issue_id, severity, note }) {
			const tenant = yield* resolveTenant
			const decodedIssueId = decodeIssueId(issue_id)
			if (Option.isNone(decodedIssueId)) {
				return validationError(
					`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
				)
			}
			// `none` clears the severity (null); any other value must decode to a
			// valid IssueSeverity or we bail with a validation error.
			const decodedSeverity: Option.Option<IssueSeverity | null> =
				severity === "none" ? Option.some(null) : decodeSeverity(severity)
			if (Option.isNone(decodedSeverity)) {
				return validationError(
					`Invalid severity: '${severity}'. Must be one of: critical, high, medium, low, none.`,
				)
			}
			const target = decodedSeverity.value

			const actorId = yield* resolveActorId(tenant)
			// API-key-backed agent identities write with "ai" precedence so they
			// never clobber a human's manual override; interactive user sessions
			// write the sticky manual override itself.
			const source = tenant.actorId ? ("ai" as const) : ("manual" as const)
			const errors = yield* ErrorsService
			const issue = yield* errors
				.setSeverity(tenant.orgId, actorId, decodedIssueId.value, target, { note, source })
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "set_issue_severity",
								cause: error,
							}),
					),
				)

			const applied = issue.severity === target
			const lines = [
				applied ? `## Issue severity updated` : `## Severity not applied (manual override in place)`,
				`- ID: ${issue.id}`,
				`- Severity: ${issue.severity ?? "unset"}${issue.severitySource ? ` (${issue.severitySource})` : ""}`,
				`- State: ${issue.workflowState}`,
				`- Service: ${issue.serviceName}`,
				note ? `- Note: ${note}` : null,
			].filter((l): l is string => l !== null)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "set_issue_severity",
					data: {
						id: issue.id,
						severity: issue.severity,
						severitySource: issue.severitySource,
						applied,
					},
				}),
			}
		}),
	)
}
