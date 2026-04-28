import { McpQueryError, optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { AlertsService } from "@/services/AlertsService"

const comparatorLabel: Record<string, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
}

export function registerListAlertIncidentsTool(server: McpToolRegistrar) {
	server.tool(
		"list_alert_incidents",
		"List triggered alert incidents with their status, severity, group identity, and observed values.",
		Schema.Struct({
			status: optionalStringParam("Filter by status: open, resolved (default: all)"),
			severity: optionalStringParam("Filter by severity: warning, critical"),
			group_key: optionalStringParam("Filter incidents by exact group key"),
			limit: optionalNumberParam("Max results to return (default 50)"),
		}),
		Effect.fn("McpTool.listAlertIncidents")(function* ({ status, severity, group_key, limit }) {
			const tenant = yield* resolveTenant
			const alerts = yield* AlertsService

			const result = yield* alerts.listIncidents(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "list_alert_incidents",
						}),
				),
			)

			let incidents = result.incidents

			if (status) {
				incidents = incidents.filter((i) => i.status === status)
			}
			if (severity) {
				incidents = incidents.filter((i) => i.severity === severity)
			}
			if (group_key) {
				incidents = incidents.filter((i) => i.groupKey === group_key)
			}

			const maxResults = limit ?? 50
			incidents = incidents.slice(0, maxResults)

			const openCount = incidents.filter((i) => i.status === "open").length
			const resolvedCount = incidents.filter((i) => i.status === "resolved").length

			const lines: string[] = [
				`## Alert Incidents`,
				`Total: ${incidents.length} (${openCount} open, ${resolvedCount} resolved)`,
				``,
			]

			if (incidents.length === 0) {
				lines.push("No alert incidents found.")
			} else {
				const headers = [
					"Rule",
					"Severity",
					"Status",
					"Group",
					"Signal",
					"Condition",
					"Value",
					"Triggered",
				]
				const rows = incidents.map((i) => [
					truncate(i.ruleName, 30),
					i.severity,
					i.status,
					i.groupKey ?? "all",
					i.signalType,
					`${comparatorLabel[i.comparator] ?? i.comparator} ${i.threshold}`,
					i.lastObservedValue != null ? String(i.lastObservedValue) : "—",
					i.firstTriggeredAt.slice(0, 19),
				])
				lines.push(formatTable(headers, rows))
			}

			const openIncidents = incidents.filter((inc) => inc.status === "open")
			const nextSteps: string[] = []
			const affectedGroups = [
				...new Set(openIncidents.filter((inc) => inc.groupKey).map((inc) => inc.groupKey)),
			].slice(0, 3)
			for (const groupKey of affectedGroups) {
				nextSteps.push(`\`get_incident_timeline group_key="${groupKey}"\` — inspect this alert group`)
			}
			if (nextSteps.length === 0) {
				nextSteps.push("`list_alert_rules` — review alert configuration")
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_alert_incidents",
					data: {
						incidents: incidents.map((i) => ({
							id: i.id,
							ruleId: i.ruleId,
							ruleName: i.ruleName,
							groupKey: i.groupKey,
							signalType: i.signalType,
							severity: i.severity,
							status: i.status,
							threshold: i.threshold,
							comparator: i.comparator,
							firstTriggeredAt: i.firstTriggeredAt,
							resolvedAt: i.resolvedAt,
							lastObservedValue: i.lastObservedValue,
						})),
						total: incidents.length,
						openCount,
						resolvedCount,
					},
				}),
			}
		}),
	)
}
