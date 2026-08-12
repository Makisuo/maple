import { McpQueryError, optionalBooleanParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { formatTable } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { AlertRulesService } from "@/services/alerts/AlertRulesService"

const comparatorLabel: Record<string, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
}

export function registerListAlertRulesTool(server: McpToolRegistrar) {
	server.tool(
		"list_alert_rules",
		"List configured alert rules with their severity, signal type, and condition. Use list_alert_incidents to see triggered alerts.",
		Schema.Struct({
			service_names: optionalStringParam("Filter rules by one or more comma-separated service names"),
			signal_type: optionalStringParam(
				"Filter by signal type: error_rate, p95_latency, p99_latency, apdex, throughput, metric, query",
			),
			severity: optionalStringParam("Filter by severity: warning, critical"),
			enabled_only: optionalBooleanParam("Only return enabled rules (default: false)"),
		}),
		Effect.fn("McpTool.listAlertRules")(function* ({
			service_names,
			signal_type,
			severity,
			enabled_only,
		}) {
			const tenant = yield* CurrentMcpTenant
			const alerts = yield* AlertRulesService

			const result = yield* alerts.listRules(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "list_alert_rules",
							cause: error,
						}),
				),
			)

			let rules = result.rules

			if (service_names) {
				const filters = service_names
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
				rules = rules.filter((r) =>
					filters.some((serviceName) => r.serviceNames.includes(serviceName)),
				)
			}
			if (signal_type) {
				rules = rules.filter((r) => r.signalType === signal_type)
			}
			if (severity) {
				rules = rules.filter((r) => r.severity === severity)
			}
			if (enabled_only) {
				rules = rules.filter((r) => r.enabled)
			}

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				signalType: signal_type ?? "all",
				severity: severity ?? "all",
				"result.rowCount": rules.length,
			})

			const lines: string[] = [
				`## Alert Rules`,
				`Total: ${rules.length} rule${rules.length !== 1 ? "s" : ""}`,
				``,
			]

			if (rules.length === 0) {
				lines.push("No alert rules found.")
			} else {
				const headers = ["Name", "Severity", "Signal", "Condition", "Enabled", "Destinations"]
				const rows = rules.map((r) => [
					r.name,
					r.severity,
					r.signalType,
					`${comparatorLabel[r.comparator] ?? r.comparator} ${r.threshold}`,
					r.enabled ? "Yes" : "No",
					String(r.destinationIds.length),
				])
				lines.push(formatTable(headers, rows))
			}

			lines.push(
				formatNextSteps([
					"`list_alert_incidents` — see triggered alerts",
					'`create_alert_rule template="high_error_rate"` — create a new rule from template',
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_alert_rules",
					data: {
						rules: rules.map((r) => ({
							id: r.id,
							name: r.name,
							enabled: r.enabled,
							severity: r.severity,
							serviceNames: [...r.serviceNames],
							environments: [...r.environments],
							signalType: r.signalType,
							comparator: r.comparator,
							threshold: r.threshold,
							windowMinutes: r.windowMinutes,
							destinationIds: [...r.destinationIds],
							createdAt: r.createdAt,
							updatedAt: r.updatedAt,
						})),
						total: rules.length,
					},
				}),
			}
		}),
	)
}
