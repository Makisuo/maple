import {
	McpQueryError,
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
} from "./types"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { AlertsService } from "@/services/AlertsService"
import { AlertRuleUpsertRequest } from "@maple/domain/http"

const decodeAlertRuleRequest = Schema.decodeUnknownSync(AlertRuleUpsertRequest)

const splitCsv = (value: string): string[] =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface AlertTemplate {
	signalType: string
	comparator: string
	defaultThreshold: number
	defaults: Record<string, unknown>
}

const ALERT_TEMPLATES: Record<string, AlertTemplate> = {
	high_error_rate: {
		signalType: "error_rate",
		comparator: "gt",
		defaultThreshold: 0.05,
		defaults: {},
	},
	slow_p95: {
		signalType: "p95_latency",
		comparator: "gt",
		defaultThreshold: 1000,
		defaults: {},
	},
	slow_p99: {
		signalType: "p99_latency",
		comparator: "gt",
		defaultThreshold: 2000,
		defaults: {},
	},
	low_apdex: {
		signalType: "apdex",
		comparator: "lt",
		defaultThreshold: 0.8,
		defaults: { apdexThresholdMs: 500 },
	},
	throughput_drop: {
		signalType: "throughput",
		comparator: "lt",
		defaultThreshold: 100,
		defaults: {},
	},
}

// ---------------------------------------------------------------------------
// Build request from raw params (custom mode)
// ---------------------------------------------------------------------------

interface CreateAlertRuleParams {
	name: string
	severity?: string
	signal_type?: string
	comparator?: string
	threshold?: number
	window_minutes?: number
	destination_ids: string
	template?: string
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
}

function buildAlertRuleRequest(
	params: CreateAlertRuleParams,
): { request: Record<string, unknown> } | { error: string } {
	const destinationIds = splitCsv(params.destination_ids)

	// Resolve template or use raw params
	let signalType = params.signal_type
	let comparator = params.comparator
	let threshold = params.threshold
	let windowMinutes = params.window_minutes ?? 5
	let templateDefaults: Record<string, unknown> = {}

	if (params.template && params.template !== "custom") {
		const tmpl = ALERT_TEMPLATES[params.template]
		if (!tmpl) {
			return {
				error: `Unknown template "${params.template}". Available: ${Object.keys(ALERT_TEMPLATES).join(", ")}, custom`,
			}
		}
		signalType = tmpl.signalType
		comparator = tmpl.comparator
		threshold = params.threshold ?? tmpl.defaultThreshold
		templateDefaults = tmpl.defaults
	}

	if (!signalType)
		return {
			error: 'signal_type is required (or use a template).\n\nExample:\n  signal_type="error_rate" comparator="gt" threshold=0.05\n  OR template="high_error_rate"',
		}
	if (!comparator)
		return {
			error: 'comparator is required (or use a template). Values: gt (>), gte (>=), lt (<), lte (<=).\n\nExample:\n  comparator="gt" threshold=0.05',
		}
	if (threshold === undefined)
		return {
			error: "threshold is required (or use a template).\n\nExample:\n  threshold=0.05 (for 5% error rate)",
		}

	if (signalType === "metric") {
		if (!params.metric_name || !params.metric_type || !params.metric_aggregation) {
			return {
				error: 'signal_type=metric requires metric_name, metric_type, and metric_aggregation. Use list_metrics to discover available metrics.\n\nExample:\n  signal_type="metric" metric_name="http.server.duration" metric_type="histogram" metric_aggregation="avg"',
			}
		}
	}

	if (signalType === "apdex") {
		if (!params.apdex_threshold_ms && !templateDefaults.apdexThresholdMs) {
			return {
				error: 'signal_type=apdex requires apdex_threshold_ms (milliseconds defining satisfactory response time).\n\nExample:\n  signal_type="apdex" apdex_threshold_ms=500 comparator="lt" threshold=0.8',
			}
		}
	}

	let queryBuilderDraft: unknown
	if (signalType === "builder_query") {
		if (!params.query_builder_draft) {
			return {
				error: 'signal_type=builder_query requires query_builder_draft: a JSON string of a query-builder draft (the same shape dashboard custom-query widgets use). Example draft: {"id":"a","name":"A","dataSource":"traces","aggregation":"error_rate","whereClause":"","groupBy":["none"]}',
			}
		}
		try {
			queryBuilderDraft = JSON.parse(params.query_builder_draft)
		} catch {
			return { error: "query_builder_draft must be valid JSON" }
		}
	}

	if (signalType === "raw_query") {
		if (!params.raw_query_sql) {
			return {
				error: 'signal_type=raw_query requires raw_query_sql: ClickHouse SQL returning a numeric `value` column (optional `group`, `samples` columns). Must reference $__orgFilter and may use $__timeFilter(col), $__startTime, $__endTime, $__interval_s.',
			}
		}
		if (!params.raw_query_sql.includes("$__orgFilter")) {
			return { error: "raw_query_sql must reference $__orgFilter for org scoping" }
		}
	}

	const request: Record<string, unknown> = {
		name: params.name,
		severity: params.severity ?? "warning",
		signalType,
		comparator,
		threshold,
		windowMinutes,
		destinationIds,
		...templateDefaults,
	}

	if (params.enabled !== undefined) request.enabled = params.enabled
	if (params.service_names) request.serviceNames = splitCsv(params.service_names)
	if (params.group_by) {
		const dimensions = String(params.group_by)
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
		if (dimensions.length > 0) request.groupBy = dimensions
	}
	if (params.minimum_sample_count !== undefined) request.minimumSampleCount = params.minimum_sample_count
	if (params.consecutive_breaches !== undefined)
		request.consecutiveBreachesRequired = params.consecutive_breaches
	if (params.consecutive_healthy !== undefined)
		request.consecutiveHealthyRequired = params.consecutive_healthy
	if (params.renotify_interval_minutes !== undefined)
		request.renotifyIntervalMinutes = params.renotify_interval_minutes

	// Metric-specific fields
	if (params.metric_name) request.metricName = params.metric_name
	if (params.metric_type) request.metricType = params.metric_type
	if (params.metric_aggregation) request.metricAggregation = params.metric_aggregation

	// Apdex-specific fields
	if (params.apdex_threshold_ms !== undefined) request.apdexThresholdMs = params.apdex_threshold_ms

	// Query-specific fields
	if (queryBuilderDraft !== undefined) request.queryBuilderDraft = queryBuilderDraft
	if (params.raw_query_sql) request.rawQuerySql = params.raw_query_sql
	if (params.raw_query_reducer) request.rawQueryReducer = params.raw_query_reducer

	return { request }
}

const comparatorLabel: Record<string, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
}

export function registerCreateAlertRuleTool(server: McpToolRegistrar) {
	server.tool(
		"create_alert_rule",
		"Create an alert rule. Use a template for common cases (high_error_rate, slow_p95, slow_p99, low_apdex, throughput_drop) or template='custom' for full control. " +
			"Templates auto-fill signal_type, comparator, and a sensible default threshold. " +
			"Use list_alert_rules to find destination_ids.",
		Schema.Struct({
			name: requiredStringParam("Rule name"),
			destination_ids: requiredStringParam(
				"Comma-separated destination IDs to notify (use list_alert_rules to find IDs)",
			),
			template: optionalStringParam(
				"Template to auto-fill signal_type, comparator, and threshold. " +
					"high_error_rate: error_rate > 0.05 (5%). slow_p95: p95_latency > 1s. slow_p99: p99_latency > 2s. " +
					"low_apdex: apdex < 0.8. throughput_drop: throughput < 100rpm. " +
					"Use 'custom' for full control over signal_type/comparator/threshold. Default: custom.",
			),
			severity: optionalStringParam("Alert severity: warning or critical (default: warning)"),
			threshold: optionalNumberParam(
				"Threshold value (overrides template default). E.g. 0.05 for 5% error rate, 1000 for 1s latency",
			),
			window_minutes: optionalNumberParam("Evaluation window in minutes (default: 5)"),
			service_names: optionalStringParam("Comma-separated service names to scope the alert to"),
			enabled: optionalBooleanParam("Whether the rule is enabled (default: true)"),
			// Custom-mode params (used when template is 'custom' or omitted)
			signal_type: optionalStringParam(
				"Signal type (for custom): error_rate, p95_latency, p99_latency, apdex, throughput, metric, builder_query, raw_query",
			),
			comparator: optionalStringParam(
				"Comparison operator (for custom): gt (>), gte (>=), lt (<), lte (<=)",
			),
			group_by: optionalStringParam(
				"Comma-separated dimensions to evaluate the alert per-group. Built-in tokens: service.name, span.name, status.code, http.method, severity. Attribute keys (traces/metrics): attr.<key>. Examples: 'service.name', 'service.name,attr.http.route'.",
			),
			minimum_sample_count: optionalNumberParam("Minimum sample count before evaluating (default: 0)"),
			consecutive_breaches: optionalNumberParam("Consecutive breaches before alerting (default: 1)"),
			consecutive_healthy: optionalNumberParam(
				"Consecutive healthy evaluations before resolving (default: 1)",
			),
			renotify_interval_minutes: optionalNumberParam(
				"Re-notification interval in minutes (default: 60)",
			),
			metric_name: optionalStringParam("Metric name (required when signal_type=metric)"),
			metric_type: optionalStringParam(
				"Metric type: sum, gauge, histogram, exponential_histogram (required when signal_type=metric)",
			),
			metric_aggregation: optionalStringParam(
				"Metric aggregation: avg, min, max, sum, count (required when signal_type=metric)",
			),
			apdex_threshold_ms: optionalNumberParam(
				"Apdex threshold in milliseconds (required when signal_type=apdex)",
			),
			query_builder_draft: optionalStringParam(
				"JSON string of a query-builder draft (required when signal_type=builder_query). Same shape as dashboard custom-query widgets: { id, name, dataSource, aggregation, whereClause, groupBy, ... }.",
			),
			raw_query_sql: optionalStringParam(
				"ClickHouse SQL returning a numeric `value` column, optional `group`/`samples` columns (required when signal_type=raw_query). Must reference $__orgFilter; supports $__timeFilter(col), $__startTime, $__endTime, $__interval_s.",
			),
			raw_query_reducer: optionalStringParam(
				"How to collapse raw_query result rows into one value: identity, sum, avg, min, max (default: identity).",
			),
		}),
		Effect.fn("McpTool.createAlertRule")(function* (params) {
			const built = buildAlertRuleRequest(params)
			if ("error" in built) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: built.error }],
				}
			}

			const decoded = yield* Effect.try({
				try: () => decodeAlertRuleRequest(built.request),
				catch: (error) =>
					new McpQueryError({
						message: `Invalid alert rule: ${String(error)}`,
						pipe: "create_alert_rule",
					}),
			})

			const tenant = yield* resolveTenant
			const alerts = yield* AlertsService

			const rule = yield* alerts.createRule(tenant.orgId, tenant.userId, tenant.roles, decoded).pipe(
				Effect.mapError((error) => {
					const details = "details" in error ? `\n${(error.details as string[]).join("\n")}` : ""
					return new McpQueryError({
						message: `${error._tag}: ${error.message}${details}`,
						pipe: "create_alert_rule",
					})
				}),
			)

			const lines: string[] = [
				`## Alert Rule Created`,
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
					tool: "create_alert_rule",
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
