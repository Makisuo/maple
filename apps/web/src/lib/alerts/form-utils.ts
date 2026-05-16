import {
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
	AlertRuleTestRequest,
	AlertRuleUpsertRequest,
	HazelAlertDestinationConfig,
	HazelOAuthAlertDestinationConfig,
	PagerDutyAlertDestinationConfig,
	SlackAlertDestinationConfig,
	WebhookAlertDestinationConfig,
	type AlertComparator,
	type AlertDestinationCreateRequest,
	type AlertDestinationId,
	type AlertDestinationType,
	type AlertDestinationUpdateRequest,
	type AlertMetricAggregation,
	type AlertMetricType,
	type AlertRuleTestRequest as AlertRuleTestRequestType,
	type AlertSeverity,
	type AlertSignalType,
	type QueryBuilderQueryDraftPayload,
} from "@maple/domain/http"
import type { QueryEngineAlertReducer } from "@maple/query-engine"
import { Cause, Exit, Option } from "effect"
import { buildTimeseriesQuerySpec } from "@/lib/query-builder/model"
import { formatErrorRate, formatLatency, formatNumber } from "@/lib/format"

export type RuleFormState = {
	name: string
	enabled: boolean
	severity: AlertSeverity
	serviceNames: string[]
	excludeServiceNames: string[]
	/**
	 * Group-by dimensions to evaluate the rule per-group. Stored as the
	 * dashboard-style tokens (e.g. `service.name`, `span.name`,
	 * `attr.http.route`). Empty array means ungrouped.
	 */
	groupBy: string[]
	signalType: AlertSignalType
	comparator: AlertComparator
	threshold: string
	thresholdUpper: string
	windowMinutes: string
	minimumSampleCount: string
	consecutiveBreachesRequired: string
	consecutiveHealthyRequired: string
	renotifyIntervalMinutes: string
	metricName: string
	metricType: AlertMetricType
	metricAggregation: AlertMetricAggregation
	apdexThresholdMs: string
	/**
	 * Editing fields for the `builder_query` signal. They map 1:1 to a
	 * `QueryBuilderQueryDraftPayload` — the same draft dashboard query-builder
	 * charts use — which `buildRuleRequest` assembles at submit time.
	 */
	queryDataSource: "traces" | "logs" | "metrics"
	queryAggregation: string
	queryWhereClause: string
	/** Editing fields for the `raw_query` signal. */
	rawQuerySql: string
	rawQueryReducer: QueryEngineAlertReducer
	destinationIds: AlertDestinationId[]
}

export const signalLabels: Record<AlertSignalType, string> = {
	error_rate: "Error rate",
	p95_latency: "P95 latency",
	p99_latency: "P99 latency",
	apdex: "Apdex",
	throughput: "Throughput",
	metric: "Metric",
	builder_query: "Query builder",
	raw_query: "Raw SQL",
}

export const RAW_QUERY_REDUCER_LABELS: Record<QueryEngineAlertReducer, string> = {
	identity: "Last bucket",
	sum: "Sum",
	avg: "Average",
	min: "Minimum",
	max: "Maximum",
}

/** Default ClickHouse SQL shown when a fresh raw_query alert is created. */
export const DEFAULT_RAW_QUERY_SQL = `SELECT
  toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
  count() AS value
FROM traces
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket`

export const comparatorLabels: Record<AlertComparator, string> = {
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
	eq: "=",
	neq: "!=",
	between: "between",
	not_between: "not between",
}

/** Returns true for comparators that need a second (upper) threshold. */
export const isRangeComparator = (c: AlertComparator): c is "between" | "not_between" =>
	c === "between" || c === "not_between"

export { destinationTypeLabels } from "@/components/alerts/destination-provider"

export const metricTypeLabels: Record<AlertMetricType, string> = {
	sum: "Sum",
	gauge: "Gauge",
	histogram: "Histogram",
	exponential_histogram: "Exponential histogram",
}

export const metricAggregationLabels: Record<AlertMetricAggregation, string> = {
	avg: "Average",
	min: "Minimum",
	max: "Maximum",
	sum: "Sum",
	count: "Count",
}

export function getExitErrorMessage(exit: Exit.Exit<unknown, unknown>, fallback: string): string {
	if (Exit.isSuccess(exit)) return fallback
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure instanceof Error && failure.message.trim().length > 0) return failure.message
	if (
		typeof failure === "object" &&
		failure !== null &&
		"message" in failure &&
		typeof failure.message === "string" &&
		failure.message.trim().length > 0
	) {
		return failure.message
	}
	const defect = Cause.squash(exit.cause)
	if (defect instanceof Error && defect.message.trim().length > 0) return defect.message
	return fallback
}

export function formatSignalValue(signalType: AlertSignalType, value: number | null): string {
	if (value == null || Number.isNaN(value)) return "n/a"

	switch (signalType) {
		case "error_rate":
			return formatErrorRate(value)
		case "p95_latency":
		case "p99_latency":
			return formatLatency(value)
		case "apdex":
			return value.toFixed(3)
		case "throughput":
		case "metric":
		case "builder_query":
		case "raw_query":
			return formatNumber(value)
	}
}

export function parsePositiveNumber(value: string, fallback: number): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback
	return parsed
}

export function parseNonNegativeNumber(value: string, fallback: number): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) return fallback
	return parsed
}

export function defaultRuleForm(serviceName?: string): RuleFormState {
	return {
		name: "",
		enabled: true,
		severity: "warning",
		serviceNames: serviceName ? [serviceName] : [],
		excludeServiceNames: [],
		groupBy: [],
		signalType: "error_rate",
		comparator: "gt",
		threshold: "5",
		thresholdUpper: "",
		windowMinutes: "5",
		minimumSampleCount: "50",
		consecutiveBreachesRequired: "2",
		consecutiveHealthyRequired: "2",
		renotifyIntervalMinutes: "30",
		metricName: "",
		metricType: "gauge",
		metricAggregation: "avg",
		apdexThresholdMs: "500",
		queryDataSource: "traces",
		queryAggregation: "count",
		queryWhereClause: "",
		rawQuerySql: DEFAULT_RAW_QUERY_SQL,
		rawQueryReducer: "identity",
		destinationIds: [],
	}
}

export function ruleToFormState(rule: AlertRuleDocument): RuleFormState {
	return {
		name: rule.name,
		enabled: rule.enabled,
		severity: rule.severity,
		serviceNames: rule.serviceNames?.length > 0 ? [...rule.serviceNames] : [],
		excludeServiceNames: rule.excludeServiceNames?.length > 0 ? [...rule.excludeServiceNames] : [],
		groupBy: rule.groupBy ? [...rule.groupBy] : [],
		signalType: rule.signalType,
		comparator: rule.comparator,
		threshold: String(rule.threshold),
		thresholdUpper: rule.thresholdUpper == null ? "" : String(rule.thresholdUpper),
		windowMinutes: String(rule.windowMinutes),
		minimumSampleCount: String(rule.minimumSampleCount),
		consecutiveBreachesRequired: String(rule.consecutiveBreachesRequired),
		consecutiveHealthyRequired: String(rule.consecutiveHealthyRequired),
		renotifyIntervalMinutes: String(rule.renotifyIntervalMinutes),
		metricName: rule.metricName ?? "",
		metricType: rule.metricType ?? "gauge",
		metricAggregation: rule.metricAggregation ?? "avg",
		apdexThresholdMs: rule.apdexThresholdMs == null ? "500" : String(rule.apdexThresholdMs),
		queryDataSource: rule.queryBuilderDraft?.dataSource ?? "traces",
		queryAggregation: rule.queryBuilderDraft?.aggregation ?? "count",
		queryWhereClause: rule.queryBuilderDraft?.whereClause ?? "",
		rawQuerySql: rule.rawQuerySql ?? DEFAULT_RAW_QUERY_SQL,
		rawQueryReducer: rule.rawQueryReducer ?? "identity",
		destinationIds: [...rule.destinationIds],
	}
}

/**
 * Assemble a `QueryBuilderQueryDraftPayload` from the simple builder_query form
 * fields. This is the same draft shape dashboard query-builder charts use, so
 * the alert evaluates through the identical compiler.
 */
export function buildQueryDraftFromForm(form: RuleFormState): QueryBuilderQueryDraftPayload {
	// Fold a single selected service into the where clause — builder_query draws
	// all filtering from the draft, not the rule-level service scope.
	const userWhere = form.queryWhereClause.trim()
	const whereClause =
		form.serviceNames.length === 1
			? [`service.name = "${form.serviceNames[0]}"`, userWhere].filter((s) => s.length > 0).join(" AND ")
			: userWhere
	const base = {
		id: "alert-query",
		name: "A",
		aggregation: form.queryAggregation,
		whereClause,
		groupBy: [...form.groupBy],
		addOns: {
			groupBy: form.groupBy.length > 0,
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
		},
	}
	if (form.queryDataSource === "metrics") {
		return {
			...base,
			dataSource: "metrics",
			metricName: form.metricName.trim(),
			metricType: form.metricType,
		}
	}
	return { ...base, dataSource: form.queryDataSource }
}

export function buildRuleRequest(form: RuleFormState): AlertRuleUpsertRequest {
	const signalType = form.signalType
	return new AlertRuleUpsertRequest({
		name: form.name.trim(),
		enabled: form.enabled,
		severity: form.severity,
		serviceNames: form.serviceNames.filter((s) => s.trim().length > 0),
		excludeServiceNames: form.excludeServiceNames.filter((s) => s.trim().length > 0),
		groupBy: form.groupBy.length > 0 ? form.groupBy : null,
		signalType,
		comparator: form.comparator,
		threshold: Number(form.threshold),
		thresholdUpper: isRangeComparator(form.comparator)
			? Number.isFinite(Number(form.thresholdUpper))
				? Number(form.thresholdUpper)
				: null
			: null,
		windowMinutes: parsePositiveNumber(form.windowMinutes, 5),
		minimumSampleCount: parseNonNegativeNumber(form.minimumSampleCount, 0),
		consecutiveBreachesRequired: parsePositiveNumber(form.consecutiveBreachesRequired, 2),
		consecutiveHealthyRequired: parsePositiveNumber(form.consecutiveHealthyRequired, 2),
		renotifyIntervalMinutes: parsePositiveNumber(form.renotifyIntervalMinutes, 30),
		metricName: signalType === "metric" ? form.metricName.trim() || null : null,
		metricType: signalType === "metric" ? form.metricType : null,
		metricAggregation: signalType === "metric" ? form.metricAggregation : null,
		apdexThresholdMs: signalType === "apdex" ? parsePositiveNumber(form.apdexThresholdMs, 500) : null,
		queryBuilderDraft: signalType === "builder_query" ? buildQueryDraftFromForm(form) : null,
		rawQuerySql: signalType === "raw_query" ? form.rawQuerySql.trim() || null : null,
		rawQueryReducer: signalType === "raw_query" ? form.rawQueryReducer : null,
		destinationIds: [...form.destinationIds],
	})
}

export function buildRuleTestRequest(
	form: RuleFormState,
	sendNotification: boolean,
): AlertRuleTestRequestType {
	return new AlertRuleTestRequest({
		rule: buildRuleRequest(form),
		sendNotification,
	})
}

export function isRulePreviewReady(form: RuleFormState): boolean {
	if (form.name.trim().length === 0) return false
	if (!Number.isFinite(Number(form.threshold))) return false
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) {
		return false
	}
	if (form.signalType === "builder_query" && form.queryDataSource === "metrics") {
		return form.metricName.trim().length > 0
	}
	if (form.signalType === "raw_query") {
		return form.rawQuerySql.trim().length > 0 && form.rawQuerySql.includes("$__orgFilter")
	}
	return true
}

/** Map signal type to the query engine source and metric fields */
export function signalToQueryParams(form: RuleFormState): {
	source: "traces" | "logs" | "metrics"
	metric: string
	filters: Record<string, unknown>
	apdexThresholdMs?: number
} | null {
	const baseFilters = form.serviceNames.length === 1 ? { serviceName: form.serviceNames[0] } : {}

	switch (form.signalType) {
		case "error_rate":
			return {
				source: "traces",
				metric: "error_rate",
				filters: { ...baseFilters, rootSpansOnly: true },
			}
		case "p95_latency":
			return {
				source: "traces",
				metric: "p95_duration",
				filters: { ...baseFilters, rootSpansOnly: true },
			}
		case "p99_latency":
			return {
				source: "traces",
				metric: "p99_duration",
				filters: { ...baseFilters, rootSpansOnly: true },
			}
		case "throughput":
			return { source: "traces", metric: "count", filters: { ...baseFilters, rootSpansOnly: true } }
		case "apdex":
			return {
				source: "traces",
				metric: "apdex",
				filters: { ...baseFilters, rootSpansOnly: true },
				apdexThresholdMs: parsePositiveNumber(form.apdexThresholdMs, 500),
			}
		case "metric": {
			if (!form.metricName.trim() || !form.metricType) return null
			return {
				source: "metrics",
				metric: form.metricAggregation,
				filters: {
					metricName: form.metricName.trim(),
					metricType: form.metricType,
					...baseFilters,
				},
			}
		}
		case "builder_query": {
			// Compile the draft with the shared query-builder compiler and read
			// back the resolved source/metric/filters for the preview chart.
			const built = buildTimeseriesQuerySpec(buildQueryDraftFromForm(form))
			if (built.error != null || built.query == null || built.query.kind !== "timeseries") {
				return null
			}
			const spec = built.query
			return {
				source: spec.source,
				metric: "metric" in spec ? spec.metric : "count",
				filters: (spec.filters as Record<string, unknown> | undefined) ?? {},
			}
		}
		case "raw_query":
			// Raw SQL alerts have no structured spec; the preview chart is skipped.
			return null
	}
}

/** Flatten timeseries points into chart-ready rows, scoped to selected services. */
export function flattenAlertChartData(
	points: { bucket: string; series: Record<string, number> }[],
	serviceNames: readonly string[],
): Record<string, unknown>[] {
	return points.map((point) => {
		const base: Record<string, unknown> = { bucket: point.bucket }
		if (serviceNames.length > 1) {
			for (const svc of serviceNames) {
				if (svc in point.series) base[svc] = point.series[svc]
			}
		} else if (serviceNames.length === 1) {
			base[serviceNames[0]!] = point.series[serviceNames[0]!] ?? 0
		} else {
			Object.assign(base, point.series)
		}
		return base
	})
}

/* -------------------------------------------------------------------------- */
/*  Destination Form Helpers                                                  */
/* -------------------------------------------------------------------------- */

export type DestinationFormState = {
	type: AlertDestinationType
	name: string
	enabled: boolean
	channelLabel: string
	webhookUrl: string
	integrationKey: string
	url: string
	signingSecret: string
	hazelWebhookUrl: string
	hazelOrganizationId: string
	hazelOrganizationName: string
	hazelOrganizationLogoUrl: string | null
	hazelChannelId: string
	hazelChannelName: string
}

export function defaultDestinationForm(type: AlertDestinationType = "slack"): DestinationFormState {
	return {
		type,
		name: "",
		enabled: true,
		channelLabel: "",
		webhookUrl: "",
		integrationKey: "",
		url: "",
		signingSecret: "",
		hazelWebhookUrl: "",
		hazelOrganizationId: "",
		hazelOrganizationName: "",
		hazelOrganizationLogoUrl: null,
		hazelChannelId: "",
		hazelChannelName: "",
	}
}

export function destinationToFormState(destination: AlertDestinationDocument): DestinationFormState {
	return {
		type: destination.type,
		name: destination.name,
		enabled: destination.enabled,
		channelLabel: destination.channelLabel ?? "",
		webhookUrl: "",
		integrationKey: "",
		url: "",
		signingSecret: "",
		hazelWebhookUrl: "",
		hazelOrganizationId: "",
		hazelOrganizationName: "",
		hazelOrganizationLogoUrl: null,
		hazelChannelId: "",
		hazelChannelName: "",
	}
}

export function buildDestinationCreatePayload(form: DestinationFormState): AlertDestinationCreateRequest {
	switch (form.type) {
		case "slack": {
			const channelLabel = form.channelLabel.trim()
			return new SlackAlertDestinationConfig({
				type: "slack",
				name: form.name.trim(),
				enabled: form.enabled,
				webhookUrl: form.webhookUrl.trim(),
				...(channelLabel ? { channelLabel } : {}),
			})
		}
		case "pagerduty":
			return new PagerDutyAlertDestinationConfig({
				type: "pagerduty",
				name: form.name.trim(),
				enabled: form.enabled,
				integrationKey: form.integrationKey.trim(),
			})
		case "webhook": {
			const signingSecret = form.signingSecret.trim()
			return new WebhookAlertDestinationConfig({
				type: "webhook",
				name: form.name.trim(),
				enabled: form.enabled,
				url: form.url.trim(),
				...(signingSecret ? { signingSecret } : {}),
			})
		}
		case "hazel": {
			const signingSecret = form.signingSecret.trim()
			return new HazelAlertDestinationConfig({
				type: "hazel",
				name: form.name.trim(),
				enabled: form.enabled,
				webhookUrl: form.hazelWebhookUrl.trim(),
				...(signingSecret ? { signingSecret } : {}),
			})
		}
		case "hazel-oauth": {
			const logoUrl = form.hazelOrganizationLogoUrl
			return new HazelOAuthAlertDestinationConfig({
				type: "hazel-oauth",
				name: form.name.trim(),
				enabled: form.enabled,
				hazelOrganizationId: form.hazelOrganizationId.trim(),
				hazelOrganizationName: form.hazelOrganizationName.trim(),
				...(logoUrl !== null && logoUrl.trim().length > 0
					? { hazelOrganizationLogoUrl: logoUrl.trim() }
					: {}),
				hazelChannelId: form.hazelChannelId.trim(),
				hazelChannelName: form.hazelChannelName.trim(),
			})
		}
	}
}

export function buildDestinationUpdatePayload(form: DestinationFormState): AlertDestinationUpdateRequest {
	switch (form.type) {
		case "slack":
			return {
				type: "slack",
				name: form.name.trim() || undefined,
				enabled: form.enabled,
				channelLabel: form.channelLabel.trim() || undefined,
				webhookUrl: form.webhookUrl.trim() || undefined,
			}
		case "pagerduty":
			return {
				type: "pagerduty",
				name: form.name.trim() || undefined,
				enabled: form.enabled,
				integrationKey: form.integrationKey.trim() || undefined,
			}
		case "webhook":
			return {
				type: "webhook",
				name: form.name.trim() || undefined,
				enabled: form.enabled,
				url: form.url.trim() || undefined,
				signingSecret: form.signingSecret.trim() || undefined,
			}
		case "hazel":
			return {
				type: "hazel",
				name: form.name.trim() || undefined,
				enabled: form.enabled,
				webhookUrl: form.hazelWebhookUrl.trim() || undefined,
				signingSecret: form.signingSecret.trim() || undefined,
			}
		case "hazel-oauth":
			return {
				type: "hazel-oauth",
				name: form.name.trim() || undefined,
				enabled: form.enabled,
				hazelOrganizationId: form.hazelOrganizationId.trim() || undefined,
				hazelOrganizationName: form.hazelOrganizationName.trim() || undefined,
				hazelOrganizationLogoUrl:
					form.hazelOrganizationLogoUrl === null
						? null
						: form.hazelOrganizationLogoUrl.trim() || undefined,
				hazelChannelId: form.hazelChannelId.trim() || undefined,
				hazelChannelName: form.hazelChannelName.trim() || undefined,
			}
	}
}

/* -------------------------------------------------------------------------- */
/*  Rule Toggle Helper                                                        */
/* -------------------------------------------------------------------------- */

export function buildRuleToggleRequest(rule: AlertRuleDocument): AlertRuleUpsertRequest {
	return new AlertRuleUpsertRequest({
		...rule,
		enabled: !rule.enabled,
		serviceNames: rule.serviceNames?.length > 0 ? [...rule.serviceNames] : undefined,
		excludeServiceNames: rule.excludeServiceNames?.length > 0 ? [...rule.excludeServiceNames] : undefined,
		metricName: rule.metricName ?? null,
		metricType: rule.metricType ?? null,
		metricAggregation: rule.metricAggregation ?? null,
		apdexThresholdMs: rule.apdexThresholdMs ?? null,
		destinationIds: [...rule.destinationIds],
	})
}

/* -------------------------------------------------------------------------- */
/*  Incident Stats                                                            */
/* -------------------------------------------------------------------------- */

export function computeIncidentStats(incidents: AlertIncidentDocument[]) {
	const totalTriggered = incidents.length
	const resolvedIncidents = incidents.filter((i) => i.resolvedAt && i.firstTriggeredAt)
	const avgResolutionMs =
		resolvedIncidents.length > 0
			? resolvedIncidents.reduce((sum, i) => {
					const start = new Date(i.firstTriggeredAt).getTime()
					const end = new Date(i.resolvedAt!).getTime()
					return sum + (end - start)
				}, 0) / resolvedIncidents.length
			: 0

	const avgResolution =
		avgResolutionMs > 0
			? avgResolutionMs < 60_000
				? `${Math.round(avgResolutionMs / 1000)}s`
				: avgResolutionMs < 3_600_000
					? `${(avgResolutionMs / 60_000).toFixed(1)}m`
					: `${(avgResolutionMs / 3_600_000).toFixed(1)}h`
			: "—"

	const groupCounts: Record<string, number> = {}
	for (const i of incidents) {
		const groupKey = i.groupKey ?? "all"
		groupCounts[groupKey] = (groupCounts[groupKey] ?? 0) + 1
	}
	const topContributors = Object.entries(groupCounts)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 5)

	return { totalTriggered, avgResolution, topContributors }
}

/* -------------------------------------------------------------------------- */
/*  Shared Formatters                                                         */
/* -------------------------------------------------------------------------- */

export function formatAlertDateTime(value: string | null): string {
	if (!value) return "Never"
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

export function formatAlertDateTimeFull(value: string | null): string {
	if (!value) return "—"
	return new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

export function formatAlertDuration(startStr: string | null, endStr: string | null): string {
	if (!startStr) return "—"
	const start = new Date(startStr).getTime()
	const end = endStr ? new Date(endStr).getTime() : Date.now()
	const diffMs = end - start
	if (diffMs < 0) return "—"
	const mins = Math.floor(diffMs / 60_000)
	if (mins < 60) return `${mins}m`
	const hours = Math.floor(mins / 60)
	const remainMins = mins % 60
	if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
	const days = Math.floor(hours / 24)
	return `${days}d ${hours % 24}h`
}
