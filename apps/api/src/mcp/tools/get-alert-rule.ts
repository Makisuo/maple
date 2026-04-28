import { McpQueryError, requiredStringParam, type McpToolRegistrar } from "./types"
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

export function registerGetAlertRuleTool(server: McpToolRegistrar) {
	server.tool(
		"get_alert_rule",
		"Get full configuration details of a specific alert rule including thresholds, service filters, evaluation settings, and notification destinations. Use list_alert_rules to find rule IDs.",
		Schema.Struct({
			rule_id: requiredStringParam("Alert rule ID"),
		}),
		Effect.fn("McpTool.getAlertRule")(function* ({ rule_id }) {
			const tenant = yield* resolveTenant
			const alerts = yield* AlertsService

			const result = yield* alerts.listRules(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipe: "get_alert_rule",
						}),
				),
			)

			const rule = result.rules.find((r) => r.id === rule_id)

			if (!rule) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Alert rule not found: ${rule_id}. Use list_alert_rules to find available rule IDs.`,
						},
					],
				}
			}

			const lines: string[] = [
				`## Alert Rule: ${rule.name}`,
				`ID: ${rule.id}`,
				`Status: ${rule.enabled ? "Enabled" : "Disabled"}`,
				`Severity: ${rule.severity}`,
				`Signal: ${rule.signalType}`,
				`Condition: ${comparatorLabel[rule.comparator] ?? rule.comparator} ${rule.threshold}`,
				`Window: ${rule.windowMinutes}m`,
				``,
			]

			// Scope
			lines.push(`### Scope`)
			if (rule.serviceNames.length > 0) {
				lines.push(`Service Names: ${rule.serviceNames.join(", ")}`)
			} else {
				lines.push(`Service Names: All services`)
			}
			if (rule.excludeServiceNames.length > 0) {
				lines.push(`Exclude: ${rule.excludeServiceNames.join(", ")}`)
			}
			if (rule.groupBy && rule.groupBy.length > 0) {
				lines.push(`Group By: ${rule.groupBy.join(", ")}`)
			}
			lines.push(``)

			// Evaluation
			lines.push(`### Evaluation`)
			lines.push(`Minimum Sample Count: ${rule.minimumSampleCount}`)
			lines.push(`Consecutive Breaches Required: ${rule.consecutiveBreachesRequired}`)
			lines.push(`Consecutive Healthy Required: ${rule.consecutiveHealthyRequired}`)
			lines.push(`Renotify Interval: ${rule.renotifyIntervalMinutes}m`)
			lines.push(``)

			// Signal-specific fields
			if (rule.metricName || rule.metricType || rule.metricAggregation) {
				lines.push(`### Metric Configuration`)
				if (rule.metricName) lines.push(`Metric Name: ${rule.metricName}`)
				if (rule.metricType) lines.push(`Metric Type: ${rule.metricType}`)
				if (rule.metricAggregation) lines.push(`Metric Aggregation: ${rule.metricAggregation}`)
				lines.push(``)
			}

			if (rule.apdexThresholdMs) {
				lines.push(`### Apdex Configuration`)
				lines.push(`Apdex Threshold: ${rule.apdexThresholdMs}ms`)
				lines.push(``)
			}

			if (rule.queryDataSource || rule.queryAggregation || rule.queryWhereClause) {
				lines.push(`### Query Configuration`)
				if (rule.queryDataSource) lines.push(`Data Source: ${rule.queryDataSource}`)
				if (rule.queryAggregation) lines.push(`Aggregation: ${rule.queryAggregation}`)
				if (rule.queryWhereClause) lines.push(`Where Clause: ${rule.queryWhereClause}`)
				lines.push(``)
			}

			// Notifications
			lines.push(`### Notifications`)
			if (rule.destinationIds.length > 0) {
				lines.push(`Destination IDs: ${rule.destinationIds.join(", ")}`)
			} else {
				lines.push(`No notification destinations configured.`)
			}

			lines.push(
				formatNextSteps([
					"`list_alert_incidents` — see triggered alerts for this rule",
					'`get_incident_timeline rule_id="<id>"` — inspect incident history for this rule',
				]),
			)

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_alert_rule",
					data: {
						rule: {
							id: rule.id,
							name: rule.name,
							enabled: rule.enabled,
							severity: rule.severity,
							serviceNames: [...rule.serviceNames],
							excludeServiceNames: [...rule.excludeServiceNames],
							groupBy: rule.groupBy ? [...rule.groupBy] : null,
							signalType: rule.signalType,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
							minimumSampleCount: rule.minimumSampleCount,
							consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
							consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
							renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
							metricName: rule.metricName,
							metricType: rule.metricType,
							metricAggregation: rule.metricAggregation,
							apdexThresholdMs: rule.apdexThresholdMs,
							queryDataSource: rule.queryDataSource,
							queryAggregation: rule.queryAggregation,
							queryWhereClause: rule.queryWhereClause,
							destinationIds: [...rule.destinationIds],
							createdAt: rule.createdAt,
							updatedAt: rule.updatedAt,
						},
					},
				}),
			}
		}),
	)
}
