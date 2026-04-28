import { McpQueryError, optionalStringParam, validationError, type McpToolRegistrar } from "./types"
import { formatTable } from "../lib/format"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "../lib/query-tinybird"
import { ErrorsService } from "@/services/ErrorsService"
import { ErrorIssueId } from "@maple/domain/http"

const decodeIssueId = Schema.decodeUnknownOption(ErrorIssueId)

export function registerListErrorIncidentsTool(server: McpToolRegistrar) {
	server.tool(
		"list_error_incidents",
		"List error incidents — time-bounded flare-ups under an error issue. Each issue can have many incidents: a 'first_seen' incident when the issue opens, then 'regression' incidents if new occurrences arrive after the issue was resolved. Incidents auto-resolve after the issue is silent for ~30 min.",
		Schema.Struct({
			issue_id: optionalStringParam(
				"Optional: narrow to incidents for this issue ID. If omitted, returns org-wide open incidents.",
			),
		}),
		Effect.fn("McpTool.listErrorIncidents")(function* ({ issue_id }) {
			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				issueId: issue_id ?? "all",
			})
			const errors = yield* ErrorsService

			let issueId: ErrorIssueId | undefined
			if (issue_id) {
				const decoded = decodeIssueId(issue_id)
				if (Option.isNone(decoded)) {
					return validationError(
						`Invalid issue_id: '${issue_id}'. Must be a UUID from list_error_issues.`,
					)
				}
				issueId = decoded.value
			}

			const result = issueId
				? yield* errors.listIssueIncidents(tenant.orgId, issueId).pipe(
						Effect.mapError(
							(error) =>
								new McpQueryError({
									message: error.message,
									pipe: "list_error_incidents",
									cause: error,
								}),
						),
					)
				: yield* errors.listOpenIncidents(tenant.orgId).pipe(
						Effect.mapError(
							(error) =>
								new McpQueryError({
									message: error.message,
									pipe: "list_error_incidents",
									cause: error,
								}),
						),
					)

			const incidents = result.incidents
			const openCount = incidents.filter((i) => i.status === "open").length

			const lines: string[] = [
				`## Error Incidents`,
				`Total: ${incidents.length} (${openCount} open)`,
				``,
			]

			if (incidents.length === 0) {
				lines.push("No incidents found.")
			} else {
				const headers = ["Issue", "Status", "Reason", "Events", "Opened", "Last triggered"]
				const rows = incidents.map((i) => [
					i.issueId.slice(0, 8),
					i.status,
					i.reason,
					String(i.occurrenceCount),
					i.firstTriggeredAt.slice(0, 19),
					i.lastTriggeredAt.slice(0, 19),
				])
				lines.push(formatTable(headers, rows))
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_error_incidents",
					data: {
						incidents: incidents.map((i) => ({
							id: i.id,
							issueId: i.issueId,
							status: i.status,
							reason: i.reason,
							firstTriggeredAt: i.firstTriggeredAt,
							lastTriggeredAt: i.lastTriggeredAt,
							resolvedAt: i.resolvedAt,
							occurrenceCount: i.occurrenceCount,
						})),
						total: incidents.length,
						openCount,
					},
				}),
			}
		}),
	)
}
