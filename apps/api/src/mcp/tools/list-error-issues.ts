import {
	McpQueryError,
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { formatNumber, formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { IssueKind, IssueSeverity, WORKFLOW_STATE_ORDER, WorkflowState } from "@maple/domain/http"

const decodeWorkflowState = Schema.decodeUnknownOption(WorkflowState)
const decodeSeverity = Schema.decodeUnknownOption(IssueSeverity)
const decodeKind = Schema.decodeUnknownOption(IssueKind)

/**
 * One-cell summary of whether this issue has been fixed before.
 *
 * `regression_count` alone reads as a number with no meaning; pairing it with
 * the date it was last resolved is what tells an agent to read the event log
 * before starting a fresh investigation.
 */
const describeFixHistory = (issue: {
	readonly regressionCount: number
	readonly lastResolvedAt: string | null
}): string => {
	if (issue.regressionCount === 0) return issue.lastResolvedAt === null ? "—" : "fixed once"
	const when = issue.lastResolvedAt === null ? "" : `, last fixed ${issue.lastResolvedAt.slice(0, 10)}`
	return `regressed ${issue.regressionCount}x${when}`
}

export function registerListErrorIssuesTool(server: McpToolRegistrar) {
	server.tool(
		"list_error_issues",
		`List persistent, triageable error issues (grouped by exception fingerprint) with workflow state, counts, and assignment. Each issue persists across occurrences so state/notes/assignee survive new events. Workflow states: ${WORKFLOW_STATE_ORDER.join(", ")}. A "regressed" issue was fixed before and started firing again — read its events before investigating it as new.`,
		Schema.Struct({
			workflow_state: optionalStringParam(
				`Filter by workflow state: ${WORKFLOW_STATE_ORDER.join(", ")} (default: all non-archived)`,
			),
			severity: optionalStringParam(
				"Filter by triage severity: critical, high, medium, low, or 'unset' for untriaged issues",
			),
			kind: optionalStringParam(
				"Filter by issue kind: error (fingerprint groups) or alert (alert-rule incidents)",
			),
			service: optionalStringParam("Filter by service name"),
			last_seen_after: optionalTimeParam(
				'Only issues that received an occurrence after this time (YYYY-MM-DD HH:mm:ss). The way to ask "what fired recently" without paging the whole backlog.',
			),
			compact: optionalBooleanParam(
				"Narrow table and payload: id, state, severity, service, exception, events, last seen, fingerprint. Omits assignment, lease and notes.",
			),
			limit: optionalNumberParam("Max results (default 50)"),
			include_archived: optionalStringParam("Pass '1' to include archived issues in results"),
		}),
		Effect.fn("McpTool.listErrorIssues")(function* ({
			workflow_state,
			severity,
			kind,
			service,
			last_seen_after,
			compact,
			limit,
			include_archived,
		}) {
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				workflowState: workflow_state ?? "all",
				severity: severity ?? "all",
				service: service ?? "all",
				lastSeenAfter: last_seen_after ?? "none",
				compact: compact === true,
				limit: limit ?? 50,
			})
			const readModels = yield* ErrorIssueReadModelsService

			let typedState: WorkflowState | undefined
			if (workflow_state) {
				const decoded = decodeWorkflowState(workflow_state)
				if (Option.isNone(decoded)) {
					return validationError(
						`Invalid workflow_state: '${workflow_state}'. Must be one of: ${WORKFLOW_STATE_ORDER.join(", ")}.`,
					)
				}
				typedState = decoded.value
			}

			let typedSeverity: IssueSeverity | "unset" | undefined
			if (severity) {
				if (severity === "unset") {
					typedSeverity = "unset"
				} else {
					const decoded = decodeSeverity(severity)
					if (Option.isNone(decoded)) {
						return validationError(
							`Invalid severity: '${severity}'. Must be one of: critical, high, medium, low, unset.`,
						)
					}
					typedSeverity = decoded.value
				}
			}

			let typedKind: IssueKind | undefined
			if (kind) {
				const decoded = decodeKind(kind)
				if (Option.isNone(decoded)) {
					return validationError(`Invalid kind: '${kind}'. Must be one of: error, alert.`)
				}
				typedKind = decoded.value
			}

			const result = yield* readModels
				.listIssues(tenant.orgId, {
					workflowState: typedState,
					severity: typedSeverity,
					kind: typedKind,
					service,
					startTime: last_seen_after ?? undefined,
					limit: limit ?? 50,
					includeArchived: include_archived === "1",
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new McpQueryError({
								message: error.message,
								pipeName: "list_error_issues",
								cause: error,
							}),
					),
				)

			yield* Effect.annotateCurrentSpan("result.rowCount", result.issues.length)

			const issues = result.issues

			const lines: string[] = [`## Error Issues`, `Total: ${issues.length}`, ``]

			if (issues.length === 0) {
				lines.push("No error issues found.")
			} else if (compact) {
				const headers = [
					"Issue ID",
					"State",
					"Severity",
					"Service",
					"Exception",
					"Events",
					"Last seen",
					"Fingerprint",
				]
				const rows = issues.map((i) => [
					i.id,
					i.hasOpenIncident ? `${i.workflowState} (incident)` : i.workflowState,
					i.severity ?? "—",
					i.serviceName,
					truncate(i.errorLabel || `${i.exceptionType}: ${i.exceptionMessage}`, 50),
					formatNumber(i.occurrenceCount),
					i.lastSeenAt.slice(0, 19),
					i.fingerprintHash,
				])
				lines.push(formatTable(headers, rows))
			} else {
				const headers = [
					// Full id, not a prefix. The 8-char truncation this used to render was
					// being pasted into error_detail as if it were a fingerprint — a
					// different identity space — where it died as a UInt64 parse error.
					"Issue ID",
					"Kind",
					"State",
					"Severity",
					"Priority",
					"Service",
					"Exception",
					"Events",
					// An agent that cannot see an issue was fixed before will investigate
					// it as if it were new. This column is the whole reason the same bug
					// used to get fixed more than once.
					"History",
					"Last seen",
					"Assigned",
					"Holder",
					// The warehouse identity, so an issue can go straight to error_detail
					// instead of being re-derived through find_errors.
					"Fingerprint",
				]
				const rows = issues.map((i) => [
					i.id,
					i.kind,
					i.hasOpenIncident ? `${i.workflowState} (incident)` : i.workflowState,
					i.severity ?? "—",
					String(i.priority),
					i.serviceName,
					truncate(i.errorLabel || `${i.exceptionType}: ${i.exceptionMessage}`, 50),
					formatNumber(i.occurrenceCount),
					describeFixHistory(i),
					i.lastSeenAt.slice(0, 19),
					i.assignedActor
						? i.assignedActor.type === "agent"
							? `agent:${i.assignedActor.agentName ?? "?"}`
							: (i.assignedActor.userId ?? "user")
						: "—",
					i.leaseHolder
						? i.leaseHolder.type === "agent"
							? `agent:${i.leaseHolder.agentName ?? "?"}`
							: (i.leaseHolder.userId ?? "user")
						: "—",
					i.fingerprintHash,
				])
				lines.push(formatTable(headers, rows))
			}

			const regressed = issues.filter((i) => i.workflowState === "regressed")
			const triageIds = issues
				.filter((i) => i.workflowState === "triage")
				.slice(0, 3)
				.map((i) => i.id)
			const nextSteps: string[] = []
			for (const issue of regressed.slice(0, 3)) {
				nextSteps.push(
					`\`list_error_issue_events issue_id="${issue.id}"\` — this issue was fixed ${
						issue.lastResolvedAt === null ? "before" : `on ${issue.lastResolvedAt.slice(0, 10)}`
					} and regressed; read what was already tried before investigating it as new`,
				)
			}
			const topError = issues.find((i) => i.kind === "error")
			if (topError) {
				nextSteps.push(
					`\`error_detail fingerprint="${topError.fingerprintHash}"\` — sample traces for the most recent issue`,
				)
			}
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
						compact: compact === true,
						issues: compact
							? issues.map((i) => ({
									id: i.id,
									kind: i.kind,
									fingerprintHash: i.fingerprintHash,
									workflowState: i.workflowState,
									severity: i.severity,
									serviceName: i.serviceName,
									errorLabel: i.errorLabel,
									occurrenceCount: i.occurrenceCount,
									firstSeenAt: i.firstSeenAt,
									lastSeenAt: i.lastSeenAt,
									regressionCount: i.regressionCount,
									lastResolvedAt: i.lastResolvedAt,
									hasOpenIncident: i.hasOpenIncident,
								}))
							: issues.map((i) => ({
									id: i.id,
									kind: i.kind,
									fingerprintHash: i.fingerprintHash,
									workflowState: i.workflowState,
									priority: i.priority,
									severity: i.severity,
									severitySource: i.severitySource,
									serviceName: i.serviceName,
									errorLabel: i.errorLabel,
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
