import {
	McpQueryError,
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
} from "./types"
import { Effect, Option, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { AlertsService } from "@/services/AlertsService"
import { AlertRuleUpsertRequest, type AlertRuleDocument } from "@maple/domain/http"

const decodeAlertRuleRequest = Schema.decodeUnknownEffect(AlertRuleUpsertRequest)
const decodeJsonValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const splitCsv = (value: string): string[] =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

const comparatorLabel: Record<string, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
}

interface UpdateAlertRuleParams {
	rule_id: string
	name?: string
	severity?: string
	signal_type?: string
	comparator?: string
	threshold?: number
	window_minutes?: number
	destination_ids?: string
	service_names?: string
	enabled?: boolean
	group_by?: string
	minimum_sample_count?: number
	consecutive_breaches?: number
	consecutive_healthy?: number
	renotify_interval_minutes?: number
	metric_name?: string
	metric_type?: string
	metric_aggregation?: string
	apdex_threshold_ms?: number
	query_builder_draft?: string
	raw_query_sql?: string
	raw_query_reducer?: string
	notification_title?: string
	notification_body?: string
}

/**
 * `AlertRuleUpsertRequest` is a full replacement, not a patch — so we seed the
 * request from the rule's current config and overlay only the params the caller
 * provided. The service's `normalizeRule` validates the merged result.
 */
function buildUpdatedRequest(
	current: AlertRuleDocument,
	params: UpdateAlertRuleParams,
): { request: Record<string, unknown> } | { error: string } {
	const request: Record<string, unknown> = {
		name: current.name,
		notes: current.notes,
		notificationTemplate: current.notificationTemplate,
		enabled: current.enabled,
		severity: current.severity,
		serviceNames: [...current.serviceNames],
		excludeServiceNames: [...current.excludeServiceNames],
		tags: [...current.tags],
		groupBy: current.groupBy ? [...current.groupBy] : null,
		signalType: current.signalType,
		comparator: current.comparator,
		threshold: current.threshold,
		thresholdUpper: current.thresholdUpper,
		windowMinutes: current.windowMinutes,
		minimumSampleCount: current.minimumSampleCount,
		consecutiveBreachesRequired: current.consecutiveBreachesRequired,
		consecutiveHealthyRequired: current.consecutiveHealthyRequired,
		renotifyIntervalMinutes: current.renotifyIntervalMinutes,
		metricName: current.metricName,
		metricType: current.metricType,
		metricAggregation: current.metricAggregation,
		apdexThresholdMs: current.apdexThresholdMs,
		queryBuilderDraft: current.queryBuilderDraft,
		rawQuerySql: current.rawQuerySql,
		rawQueryReducer: current.rawQueryReducer,
		destinationIds: [...current.destinationIds],
	}

	if (params.name !== undefined) request.name = params.name
	if (params.severity !== undefined) request.severity = params.severity
	if (params.signal_type !== undefined) request.signalType = params.signal_type
	if (params.comparator !== undefined) request.comparator = params.comparator
	if (params.threshold !== undefined) request.threshold = params.threshold
	if (params.window_minutes !== undefined) request.windowMinutes = params.window_minutes
	if (params.enabled !== undefined) request.enabled = params.enabled
	if (params.destination_ids !== undefined) request.destinationIds = splitCsv(params.destination_ids)
	if (params.service_names !== undefined) request.serviceNames = splitCsv(params.service_names)
	if (params.group_by !== undefined) request.groupBy = splitCsv(params.group_by)
	if (params.minimum_sample_count !== undefined) request.minimumSampleCount = params.minimum_sample_count
	if (params.consecutive_breaches !== undefined)
		request.consecutiveBreachesRequired = params.consecutive_breaches
	if (params.consecutive_healthy !== undefined)
		request.consecutiveHealthyRequired = params.consecutive_healthy
	if (params.renotify_interval_minutes !== undefined)
		request.renotifyIntervalMinutes = params.renotify_interval_minutes
	if (params.metric_name !== undefined) request.metricName = params.metric_name
	if (params.metric_type !== undefined) request.metricType = params.metric_type
	if (params.metric_aggregation !== undefined) request.metricAggregation = params.metric_aggregation
	if (params.apdex_threshold_ms !== undefined) request.apdexThresholdMs = params.apdex_threshold_ms
	if (params.raw_query_sql !== undefined) request.rawQuerySql = params.raw_query_sql
	if (params.raw_query_reducer !== undefined) request.rawQueryReducer = params.raw_query_reducer

	if (params.query_builder_draft !== undefined) {
		const parsed = decodeJsonValue(params.query_builder_draft)
		if (Option.isNone(parsed)) {
			return { error: "query_builder_draft must be valid JSON" }
		}
		request.queryBuilderDraft = parsed.value
	}

	// Merge notification template fields onto the existing template (null-safe).
	if (params.notification_title !== undefined || params.notification_body !== undefined) {
		const existing = current.notificationTemplate
		const notificationTemplate: Record<string, string> = {
			...(existing?.title ? { title: existing.title } : {}),
			...(existing?.body ? { body: existing.body } : {}),
		}
		if (params.notification_title !== undefined) notificationTemplate.title = params.notification_title
		if (params.notification_body !== undefined) notificationTemplate.body = params.notification_body
		request.notificationTemplate =
			Object.keys(notificationTemplate).length > 0 ? notificationTemplate : null
	}

	return { request }
}

export function registerUpdateAlertRuleTool(server: McpToolRegistrar) {
	server.tool(
		"update_alert_rule",
		"Update an existing alert rule. Only provide the fields you want to change — every other field keeps its current value. " +
			"Use list_alert_rules to find rule IDs and destination IDs, or get_alert_rule to inspect the current config first.",
		Schema.Struct({
			rule_id: requiredStringParam("Alert rule ID to update (use list_alert_rules to find IDs)"),
			name: optionalStringParam("New rule name"),
			severity: optionalStringParam("Alert severity: warning or critical"),
			threshold: optionalNumberParam(
				"Threshold value. E.g. 0.05 for 5% error rate, 1000 for 1s latency",
			),
			window_minutes: optionalNumberParam("Evaluation window in minutes"),
			service_names: optionalStringParam(
				"Comma-separated service names to scope the alert to (replaces the current scope)",
			),
			enabled: optionalBooleanParam("Whether the rule is enabled"),
			destination_ids: optionalStringParam(
				"Comma-separated destination IDs to notify (replaces the current destinations; use list_alert_rules to find IDs)",
			),
			signal_type: optionalStringParam(
				"Signal type: error_rate, p95_latency, p99_latency, apdex, throughput, metric, builder_query, raw_query",
			),
			comparator: optionalStringParam("Comparison operator: gt (>), gte (>=), lt (<), lte (<=)"),
			group_by: optionalStringParam(
				"Comma-separated dimensions to evaluate the alert per-group (replaces the current grouping). " +
					"Built-in tokens: service.name, span.name, status.code, http.method, severity. Attribute keys: attr.<key>.",
			),
			minimum_sample_count: optionalNumberParam("Minimum sample count before evaluating"),
			consecutive_breaches: optionalNumberParam("Consecutive breaches before alerting"),
			consecutive_healthy: optionalNumberParam("Consecutive healthy evaluations before resolving"),
			renotify_interval_minutes: optionalNumberParam("Re-notification interval in minutes"),
			metric_name: optionalStringParam("Metric name (for signal_type=metric)"),
			metric_type: optionalStringParam(
				"Metric type: sum, gauge, histogram, exponential_histogram (for signal_type=metric)",
			),
			metric_aggregation: optionalStringParam(
				"Metric aggregation: avg, min, max, sum, count (for signal_type=metric)",
			),
			apdex_threshold_ms: optionalNumberParam(
				"Apdex threshold in milliseconds (for signal_type=apdex)",
			),
			query_builder_draft: optionalStringParam(
				"JSON string of a query-builder draft (for signal_type=builder_query).",
			),
			raw_query_sql: optionalStringParam(
				"ClickHouse SQL returning a numeric `value` column (for signal_type=raw_query). Must reference $__orgFilter and $__timeFilter(col).",
			),
			raw_query_reducer: optionalStringParam(
				"How to collapse raw_query result rows into one value: identity, sum, avg, min, max.",
			),
			notification_title: optionalStringParam(
				"Custom notification title template. Supports {{ variable }} substitution.",
			),
			notification_body: optionalStringParam(
				"Custom notification body template (Markdown). Supports {{ variable }} substitution.",
			),
		}),
		Effect.fn("McpTool.updateAlertRule")(function* (params) {
			const tenant = yield* resolveTenant
			const alerts = yield* AlertsService

			const list = yield* alerts.listRules(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "update_alert_rule",
							cause: error,
						}),
				),
			)

			const current = list.rules.find((r) => r.id === params.rule_id)
			if (!current) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Alert rule not found: ${params.rule_id}. Use list_alert_rules to find available rule IDs.`,
						},
					],
				}
			}

			const built = buildUpdatedRequest(current, params)
			if ("error" in built) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: built.error }],
				}
			}

			const decoded = yield* decodeAlertRuleRequest(built.request).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: `Invalid alert rule: ${String(error)}`,
							pipeName: "update_alert_rule",
							cause: error,
						}),
				),
			)

			const rule = yield* alerts
				.updateRule(tenant.orgId, tenant.userId, tenant.roles, current.id, decoded)
				.pipe(
					Effect.catchTag("@maple/http/errors/AlertValidationError", (error) =>
						Effect.fail(
							new McpQueryError({
								message: `${error._tag}: ${error.message}\n${error.details.join("\n")}`,
								pipeName: "update_alert_rule",
								cause: error,
							}),
						),
					),
					Effect.catchTags({
						"@maple/http/errors/AlertForbiddenError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: `${error._tag}: ${error.message}`,
									pipeName: "update_alert_rule",
									cause: error,
								}),
							),
						"@maple/http/errors/AlertPersistenceError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: `${error._tag}: ${error.message}`,
									pipeName: "update_alert_rule",
									cause: error,
								}),
							),
						"@maple/http/errors/AlertNotFoundError": (error) =>
							Effect.fail(
								new McpQueryError({
									message: `${error._tag}: ${error.message}`,
									pipeName: "update_alert_rule",
									cause: error,
								}),
							),
					}),
				)

			const lines: string[] = [
				`## Alert Rule Updated`,
				`ID: ${rule.id}`,
				`Name: ${rule.name}`,
				`Severity: ${rule.severity}`,
				`Signal: ${rule.signalType}`,
				`Condition: ${comparatorLabel[rule.comparator] ?? rule.comparator} ${rule.threshold}`,
				`Window: ${rule.windowMinutes}m`,
				`Enabled: ${rule.enabled ? "Yes" : "No"}`,
				`Destinations: ${rule.destinationIds.length}`,
			]

			if (rule.serviceNames.length > 0) {
				lines.splice(3, 0, `Service Names: ${rule.serviceNames.join(", ")}`)
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "update_alert_rule",
					data: {
						rule: {
							id: rule.id,
							name: rule.name,
							enabled: rule.enabled,
							severity: rule.severity,
							serviceNames: [...rule.serviceNames],
							signalType: rule.signalType,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
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
