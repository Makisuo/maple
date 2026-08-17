import {
	AlertCheckDocument,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
	AlertRulePreviewFiringSpan,
	AlertRulePreviewPoint,
	AlertRulePreviewResponse,
	AlertRulePreviewSeries,
	HazelChannelId,
	HazelOrganizationId,
	IsoDateTimeString,
	UserId,
	type AlertComparator,
	type AlertDeliveryStatus,
	type AlertDestinationId,
	type AlertDestinationType,
	type AlertEventType,
	type AlertSeverity,
	type AlertSignalType,
	type QueryBuilderQueryDraftPayload,
} from "@maple/domain/http"
import type {
	V2AlertCheck,
	V2AlertDelivery,
	V2AlertDestinationCreateParams,
	V2AlertDestinationUpdateParams,
	V2AlertRuleCreateParams,
	V2AlertRulePreviewResult,
	V2AlertRuleTestParams,
} from "@maple/domain/http/v2"
import type { QueryEngineAlertReducer } from "@maple/query-engine"
import { Exit, Schema } from "effect"
import { errorMessage } from "@/lib/error-toast"
import {
	buildTimeseriesQuerySpec,
	createQueryDraft,
	type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"
import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"

const asHazelOrganizationId = Schema.decodeUnknownSync(HazelOrganizationId)
const asHazelChannelId = Schema.decodeUnknownSync(HazelChannelId)
const asUserId = Schema.decodeUnknownSync(UserId)

// v2 timestamps arrive as plain ISO strings; the v1 domain documents brand them.
const asIso = (value: string) => IsoDateTimeString.make(value)
const asIsoOrNull = (value: string | null) => (value === null ? null : asIso(value))

export type RuleFormState = {
	name: string
	/** Optional free-text note — runbook links, ownership, why the rule exists. */
	notes: string
	enabled: boolean
	severity: AlertSeverity
	serviceNames: string[]
	excludeServiceNames: string[]
	/**
	 * Deployment environments the rule is scoped to. Empty means every
	 * environment. Not submitted for `builder_query` / `raw_query`, whose queries
	 * carry their own filters.
	 */
	environments: string[]
	/** Free-form tags used to group and filter rules in the alerts list. */
	tags: string[]
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
	apdexThresholdMs: string
	/**
	 * The normalized query-builder draft. It is the sole editable query state and
	 * is submitted verbatim after the wire payload is normalized on read.
	 */
	queryBuilderDraft: QueryBuilderQueryDraft
	/** Editing fields for the `raw_query` signal. */
	rawQuerySql: string
	rawQueryReducer: QueryEngineAlertReducer
	destinationIds: AlertDestinationId[]
	/**
	 * Custom notification message. Empty strings mean "use the built-in format".
	 * `title` + Markdown `body` support `{{ variable }}` substitution; channels
	 * render them per their dialect (Slack Block Kit, Discord embed, …).
	 */
	notificationTitle: string
	notificationBody: string
}

export const signalLabels: Record<AlertSignalType, string> = {
	error_rate: "Error rate",
	p95_latency: "P95 latency",
	p99_latency: "P99 latency",
	apdex: "Apdex",
	throughput: "Throughput",
	builder_query: "Query builder",
	raw_query: "Raw SQL",
} satisfies Record<AlertSignalType, string>

export const RAW_QUERY_REDUCER_LABELS: Record<QueryEngineAlertReducer, string> = {
	identity: "Last bucket",
	sum: "Sum",
	avg: "Average",
	min: "Minimum",
	max: "Maximum",
} satisfies Record<QueryEngineAlertReducer, string>

/** Default ClickHouse SQL shown when a fresh raw_query alert is created. */
const DEFAULT_RAW_QUERY_SQL = `SELECT
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
} satisfies Record<AlertComparator, string>

/** Returns true for comparators that need a second (upper) threshold. */
export const isRangeComparator = (c: AlertComparator): c is "between" | "not_between" =>
	c === "between" || c === "not_between"

export { destinationTypeLabels } from "@/components/alerts/destination-provider"

export function getExitErrorMessage(exit: unknown, fallback: string): string {
	if (!Exit.isExit(exit) || Exit.isSuccess(exit)) return fallback
	return errorMessage(exit, fallback)
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
		case "builder_query":
		case "raw_query":
			return formatNumber(value)
	}
}

/**
 * Threshold unit conversion at the form↔domain boundary.
 *
 * The domain stores `error_rate` thresholds as a 0–1 ratio (matching the query
 * engine's `countIf(Error)/count()` and the evaluation comparison). The form
 * lets users enter a percent (e.g. `5` = 5%), so we divide by 100 on submit and
 * multiply by 100 on load. All other signals pass through unchanged.
 */
export function formThresholdToDomain(signalType: AlertSignalType, value: string): number {
	const n = Number(value)
	return signalType === "error_rate" ? n / 100 : n
}

export function domainThresholdToForm(signalType: AlertSignalType, value: number): string {
	return signalType === "error_rate" ? String(value * 100) : String(value)
}

function parsePositiveNumber(value: string, fallback: number): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback
	return parsed
}

function parseNonNegativeNumber(value: string, fallback: number): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) return fallback
	return parsed
}

export function normalizeRuleQueryDraft(draft: QueryBuilderQueryDraftPayload | null): QueryBuilderQueryDraft {
	const base = createQueryDraft(0)
	if (draft == null) return base

	const shared = {
		...base,
		...draft,
		enabled: draft.enabled ?? base.enabled,
		hidden: draft.hidden ?? base.hidden,
		whereClause: draft.whereClause ?? base.whereClause,
		stepInterval: draft.stepInterval ?? base.stepInterval,
		orderByDirection: draft.orderByDirection ?? base.orderByDirection,
		addOns: { ...base.addOns, ...draft.addOns },
		groupBy: [...(draft.groupBy ?? base.groupBy)],
		having: draft.having ?? base.having,
		orderBy: draft.orderBy ?? base.orderBy,
		limit: draft.limit ?? base.limit,
		legend: draft.legend ?? base.legend,
	}

	if (draft.dataSource === "metrics") {
		return {
			...shared,
			dataSource: "metrics",
			signalSource: draft.signalSource ?? "default",
			metricName: draft.metricName ?? "",
			metricType: draft.metricType ?? "gauge",
			isMonotonic: draft.isMonotonic ?? draft.metricType === "sum",
		}
	}
	return draft.dataSource === "logs"
		? { ...shared, dataSource: "logs" }
		: { ...shared, dataSource: "traces" }
}

export function defaultRuleForm(serviceName?: string): RuleFormState {
	const queryBuilderDraft = createQueryDraft(0)
	return {
		name: "",
		notes: "",
		enabled: true,
		severity: "warning",
		serviceNames: serviceName ? [serviceName] : [],
		excludeServiceNames: [],
		environments: [],
		tags: [],
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
		apdexThresholdMs: "500",
		queryBuilderDraft,
		rawQuerySql: DEFAULT_RAW_QUERY_SQL,
		rawQueryReducer: "identity",
		destinationIds: [],
		notificationTitle: "",
		notificationBody: "",
	}
}

export function ruleToFormState(rule: AlertRuleDocument): RuleFormState {
	const queryBuilderDraft = normalizeRuleQueryDraft(rule.queryBuilderDraft)
	return {
		name: rule.name,
		notes: rule.notes ?? "",
		enabled: rule.enabled,
		severity: rule.severity,
		serviceNames: rule.serviceNames?.length > 0 ? [...rule.serviceNames] : [],
		excludeServiceNames: rule.excludeServiceNames?.length > 0 ? [...rule.excludeServiceNames] : [],
		environments: rule.environments?.length > 0 ? [...rule.environments] : [],
		tags: rule.tags?.length > 0 ? [...rule.tags] : [],
		groupBy: rule.groupBy ? [...rule.groupBy] : [],
		signalType: rule.signalType,
		comparator: rule.comparator,
		threshold: domainThresholdToForm(rule.signalType, rule.threshold),
		thresholdUpper:
			rule.thresholdUpper == null ? "" : domainThresholdToForm(rule.signalType, rule.thresholdUpper),
		windowMinutes: String(rule.windowMinutes),
		minimumSampleCount: String(rule.minimumSampleCount),
		consecutiveBreachesRequired: String(rule.consecutiveBreachesRequired),
		consecutiveHealthyRequired: String(rule.consecutiveHealthyRequired),
		renotifyIntervalMinutes: String(rule.renotifyIntervalMinutes),
		apdexThresholdMs: rule.apdexThresholdMs == null ? "500" : String(rule.apdexThresholdMs),
		queryBuilderDraft,
		rawQuerySql: rule.rawQuerySql ?? DEFAULT_RAW_QUERY_SQL,
		rawQueryReducer: rule.rawQueryReducer ?? "identity",
		destinationIds: [...rule.destinationIds],
		notificationTitle: rule.notificationTemplate?.title ?? "",
		notificationBody: rule.notificationTemplate?.body ?? "",
	}
}

export function rawSqlHasValueColumn(sql: string): boolean {
	const trimmed = sql.trim()
	if (trimmed.length === 0) return false

	if (/\bas\s+["`]?value["`]?\b/i.test(trimmed)) return true

	const firstFrom = trimmed.search(/\bfrom\b/i)
	const selectHead = firstFrom >= 0 ? trimmed.slice(0, firstFrom) : trimmed.slice(0, 500)
	return /(?:\bselect\b|,)\s*["`]?value["`]?\s*(?:,|$)/i.test(selectHead)
}

export function deriveRuleQueryIssues(form: RuleFormState): string[] {
	const issues: string[] = []
	if (form.signalType === "builder_query") {
		const built = buildTimeseriesQuerySpec(form.queryBuilderDraft)
		if (built.error != null || built.query == null) {
			issues.push(`Query: ${built.error ?? "failed to build query"}`)
		}
	}
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length > 0 && !rawSqlHasValueColumn(sql)) {
			issues.push("SQL value column")
		}
	}
	return issues
}

/**
 * Assemble the v2 `POST /v2/alerts/rules` body from the form. Field names are
 * the v2 snake_case wire spelling; IDs stay the internal branded values — the
 * derived client's `PublicId` codecs encode them to `alrt_…`/`dest_…` on the
 * wire. `query_builder_draft` is passed verbatim (opaque passthrough, validated
 * server-side against the full draft schema).
 */
export function buildRuleCreateParamsV2(form: RuleFormState): V2AlertRuleCreateParams {
	const signalType = form.signalType
	const queryOwnsScope = signalType === "builder_query" || signalType === "raw_query"
	const notificationTitle = form.notificationTitle.trim()
	const notificationBody = form.notificationBody.trim()
	const notificationTemplate =
		notificationTitle.length > 0 || notificationBody.length > 0
			? {
					...(notificationTitle.length > 0 ? { title: notificationTitle } : undefined),
					...(notificationBody.length > 0 ? { body: notificationBody } : undefined),
				}
			: null
	return {
		name: form.name.trim(),
		notes: form.notes.trim() || null,
		enabled: form.enabled,
		severity: form.severity,
		tags: form.tags,
		service_names: queryOwnsScope ? [] : form.serviceNames.filter((s) => s.trim().length > 0),
		exclude_service_names: queryOwnsScope
			? []
			: form.excludeServiceNames.filter((s) => s.trim().length > 0),
		environments: queryOwnsScope ? [] : form.environments.filter((s) => s.trim().length > 0),
		group_by: queryOwnsScope ? null : form.groupBy.length > 0 ? form.groupBy : null,
		signal_type: signalType,
		comparator: form.comparator,
		threshold: formThresholdToDomain(signalType, form.threshold),
		threshold_upper: isRangeComparator(form.comparator)
			? Number.isFinite(Number(form.thresholdUpper))
				? formThresholdToDomain(signalType, form.thresholdUpper)
				: null
			: null,
		window_minutes: parsePositiveNumber(form.windowMinutes, 5),
		minimum_sample_count: parseNonNegativeNumber(form.minimumSampleCount, 0),
		consecutive_breaches_required: parsePositiveNumber(form.consecutiveBreachesRequired, 2),
		consecutive_healthy_required: parsePositiveNumber(form.consecutiveHealthyRequired, 2),
		renotify_interval_minutes: parsePositiveNumber(form.renotifyIntervalMinutes, 30),
		apdex_threshold_ms: signalType === "apdex" ? parsePositiveNumber(form.apdexThresholdMs, 500) : null,
		query_builder_draft:
			signalType === "builder_query"
				? Object.fromEntries(Object.entries(form.queryBuilderDraft))
				: null,
		raw_query_sql: signalType === "raw_query" ? form.rawQuerySql.trim() || null : null,
		raw_query_reducer: signalType === "raw_query" ? form.rawQueryReducer : null,
		// Dedupe so the same destination is never persisted twice (e.g. when editing a
		// rule that already had duplicates). The server is authoritative (normalizeRule),
		// but keeping the request clean avoids a needless write-then-normalize round trip.
		destination_ids: [...new Set(form.destinationIds)],
		notification_template: notificationTemplate,
	}
}

export function buildRuleTestParamsV2(form: RuleFormState, sendNotification: boolean): V2AlertRuleTestParams {
	return {
		rule: buildRuleCreateParamsV2(form),
		send_notification: sendNotification,
	}
}

export function isRulePreviewReady(form: RuleFormState): boolean {
	if (form.name.trim().length === 0) return false
	if (!Number.isFinite(Number(form.threshold))) return false
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) {
		return false
	}
	if (form.signalType === "builder_query") return deriveRuleQueryIssues(form).length === 0
	if (form.signalType === "raw_query") {
		return (
			form.rawQuerySql.trim().length > 0 &&
			form.rawQuerySql.includes("$__orgFilter") &&
			deriveRuleQueryIssues(form).length === 0
		)
	}
	return deriveRuleQueryIssues(form).length === 0
}

/* -------------------------------------------------------------------------- */
/*  Destination Form Helpers                                                  */
/* -------------------------------------------------------------------------- */

export type DestinationFormState = {
	type: AlertDestinationType
	name: string
	enabled: boolean
	/** Discord incoming-webhook URL. */
	webhookUrl: string
	/**
	 * Slack (bot) destination: the channel the installed Maple bot posts to.
	 * `slackChannelId` is the Slack channel id (`C0789CHAN`), `slackChannelName`
	 * its display name (`incidents`). No webhook/secret — the bot token is
	 * resolved from the org's Slack workspace at dispatch.
	 */
	slackChannelId: string
	slackChannelName: string
	integrationKey: string
	url: string
	signingSecret: string
	hazelOrganizationId: string
	hazelOrganizationName: string
	hazelOrganizationLogoUrl: string | null
	hazelChannelId: string
	hazelChannelName: string
	/** Selected workspace-member recipients (email type only). */
	memberUserIds: string[]
}

export const MAX_EMAIL_MEMBER_RECIPIENTS = 10

/** Defaults to `slack-bot` — the tile the dialog lists first. */
export function defaultDestinationForm(type: AlertDestinationType = "slack-bot"): DestinationFormState {
	return {
		type,
		name: "",
		enabled: true,
		webhookUrl: "",
		slackChannelId: "",
		slackChannelName: "",
		integrationKey: "",
		url: "",
		signingSecret: "",
		hazelOrganizationId: "",
		hazelOrganizationName: "",
		hazelOrganizationLogoUrl: null,
		hazelChannelId: "",
		hazelChannelName: "",
		memberUserIds: [],
	}
}

export function destinationToFormState(destination: AlertDestinationDocument): DestinationFormState {
	return {
		type: destination.type,
		name: destination.name,
		enabled: destination.enabled,
		webhookUrl: "",
		// slack-bot hydrates `channelLabel` as `#name`; keep the current channel
		// visible on edit (its id isn't returned — an empty id keeps the stored one).
		slackChannelId: "",
		slackChannelName:
			destination.type === "slack-bot" ? (destination.channelLabel?.replace(/^#/, "") ?? "") : "",
		integrationKey: "",
		url: "",
		signingSecret: "",
		hazelOrganizationId: "",
		hazelOrganizationName: "",
		hazelOrganizationLogoUrl: null,
		hazelChannelId: "",
		hazelChannelName: "",
		memberUserIds: destination.memberUserIds != null ? [...destination.memberUserIds] : [],
	}
}

export function buildDestinationCreateParamsV2(form: DestinationFormState): V2AlertDestinationCreateParams {
	switch (form.type) {
		case "slack-bot": {
			const channelName = form.slackChannelName.trim()
			return {
				type: "slack-bot",
				name: form.name.trim(),
				enabled: form.enabled,
				channel_id: form.slackChannelId.trim(),
				...(channelName ? { channel_name: channelName } : undefined),
			}
		}
		case "pagerduty":
			return {
				type: "pagerduty",
				name: form.name.trim(),
				enabled: form.enabled,
				integration_key: form.integrationKey.trim(),
			}
		case "webhook": {
			const signingSecret = form.signingSecret.trim()
			return {
				type: "webhook",
				name: form.name.trim(),
				enabled: form.enabled,
				url: form.url.trim(),
				...(signingSecret ? { signing_secret: signingSecret } : undefined),
			}
		}
		case "hazel-oauth": {
			const logoUrl = form.hazelOrganizationLogoUrl
			return {
				type: "hazel-oauth",
				name: form.name.trim(),
				enabled: form.enabled,
				hazel_organization_id: asHazelOrganizationId(form.hazelOrganizationId.trim()),
				hazel_organization_name: form.hazelOrganizationName.trim(),
				...(logoUrl !== null && logoUrl.trim().length > 0
					? { hazel_organization_logo_url: logoUrl.trim() }
					: undefined),
				hazel_channel_id: asHazelChannelId(form.hazelChannelId.trim()),
				hazel_channel_name: form.hazelChannelName.trim(),
			}
		}
		case "discord":
			return {
				type: "discord",
				name: form.name.trim(),
				enabled: form.enabled,
				webhook_url: form.webhookUrl.trim(),
			}
		case "email":
			return {
				type: "email",
				name: form.name.trim(),
				enabled: form.enabled,
				member_user_ids: form.memberUserIds.map((userId) => asUserId(userId)),
			}
	}
}

/**
 * v2 PATCH semantics: omitted keys are left unchanged, so blank form fields
 * (secrets the user didn't re-enter) are dropped from the payload entirely.
 */
export function buildDestinationUpdateParamsV2(form: DestinationFormState): V2AlertDestinationUpdateParams {
	const name = form.name.trim()
	switch (form.type) {
		case "slack-bot": {
			const channelId = form.slackChannelId.trim()
			const channelName = form.slackChannelName.trim()
			return {
				type: "slack-bot",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(channelId ? { channel_id: channelId } : undefined),
				...(channelName ? { channel_name: channelName } : undefined),
			}
		}
		case "pagerduty": {
			const integrationKey = form.integrationKey.trim()
			return {
				type: "pagerduty",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(integrationKey ? { integration_key: integrationKey } : undefined),
			}
		}
		case "webhook": {
			const url = form.url.trim()
			const signingSecret = form.signingSecret.trim()
			return {
				type: "webhook",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(url ? { url } : undefined),
				...(signingSecret ? { signing_secret: signingSecret } : undefined),
			}
		}
		case "hazel-oauth": {
			const organizationId = form.hazelOrganizationId.trim()
			const organizationName = form.hazelOrganizationName.trim()
			const channelId = form.hazelChannelId.trim()
			const channelName = form.hazelChannelName.trim()
			return {
				type: "hazel-oauth",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(organizationId
					? { hazel_organization_id: asHazelOrganizationId(organizationId) }
					: undefined),
				...(organizationName ? { hazel_organization_name: organizationName } : undefined),
				...(form.hazelOrganizationLogoUrl === null
					? { hazel_organization_logo_url: null }
					: form.hazelOrganizationLogoUrl.trim()
						? { hazel_organization_logo_url: form.hazelOrganizationLogoUrl.trim() }
						: {}),
				...(channelId ? { hazel_channel_id: asHazelChannelId(channelId) } : undefined),
				...(channelName ? { hazel_channel_name: channelName } : undefined),
			}
		}
		case "discord": {
			const webhookUrl = form.webhookUrl.trim()
			return {
				type: "discord",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(webhookUrl ? { webhook_url: webhookUrl } : undefined),
			}
		}
		case "email":
			return {
				type: "email",
				enabled: form.enabled,
				...(name ? { name } : undefined),
				...(form.memberUserIds.length > 0
					? {
							member_user_ids: form.memberUserIds.map((userId) => asUserId(userId)),
						}
					: undefined),
			}
	}
}

/* -------------------------------------------------------------------------- */
/*  v2 Response Mappers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * v2 wire types keep snake_case property names after decode, while everything
 * downstream of the preview/checks fetches (charts, diagnosis, breach stats)
 * consumes the camelCase domain documents. These two mappers are the inverse of
 * the server's `toV2Rule`/`toV2Check` and confine the spelling difference to
 * the fetch boundary.
 */
export function v2PreviewToResponse(result: V2AlertRulePreviewResult): AlertRulePreviewResponse {
	return new AlertRulePreviewResponse({
		bucketSeconds: result.bucket_seconds,
		windowMinutes: result.window_minutes,
		threshold: result.threshold,
		thresholdUpper: result.threshold_upper,
		comparator: result.comparator,
		truncatedToStart: asIsoOrNull(result.truncated_to_start),
		series: result.series.map(
			(series) =>
				new AlertRulePreviewSeries({
					groupKey: series.group_key,
					points: series.points.map(
						(point) =>
							new AlertRulePreviewPoint({
								bucket: asIso(point.bucket),
								value: point.value,
								sampleCount: point.sample_count,
								status: point.status,
								...(point.provisional !== undefined
									? { provisional: point.provisional }
									: undefined),
							}),
					),
				}),
		),
		wouldFire: result.would_fire.map(
			(span) =>
				new AlertRulePreviewFiringSpan({
					groupKey: span.group_key,
					start: asIso(span.start),
					end: asIso(span.end),
				}),
		),
	})
}

export function v2CheckToDocument(check: V2AlertCheck): AlertCheckDocument {
	return new AlertCheckDocument({
		timestamp: asIso(check.timestamp),
		groupKey: check.group_key,
		status: check.status,
		signalType: check.signal_type,
		comparator: check.comparator,
		threshold: check.threshold,
		thresholdUpper: check.threshold_upper,
		observedValue: check.observed_value,
		sampleCount: check.sample_count,
		windowMinutes: check.window_minutes,
		windowStart: asIso(check.window_start),
		windowEnd: asIso(check.window_end),
		consecutiveBreaches: check.consecutive_breaches,
		consecutiveHealthy: check.consecutive_healthy,
		incidentId: check.incident_id,
		incidentTransition: check.incident_transition,
		evaluationDurationMs: check.evaluation_duration_ms,
		errorMessage: check.error_message,
		errorCategory: check.error_category,
	})
}

export function v2DeliveryToDocument(delivery: V2AlertDelivery): AlertDeliveryEventDocument {
	return new AlertDeliveryEventDocument({
		id: delivery.id,
		incidentId: delivery.incident_id,
		ruleId: delivery.rule_id,
		destinationId: delivery.destination_id,
		destinationName: delivery.destination_name,
		destinationType: delivery.destination_type,
		deliveryKey: delivery.delivery_key,
		eventType: delivery.event_type,
		attemptNumber: delivery.attempt_number,
		status: delivery.status,
		scheduledAt: asIso(delivery.scheduled_at),
		attemptedAt: asIsoOrNull(delivery.attempted_at),
		providerMessage: delivery.provider_message,
		providerReference: delivery.provider_reference,
		responseCode: delivery.response_code,
		errorMessage: delivery.error_message,
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

/** Time of day only (`03:10 PM`) — used where a day header already carries the date. */
export function formatAlertTime(value: string | null): string {
	if (!value) return "—"
	return new Date(value).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	})
}

const startOfLocalDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Day-bucket heading: `Today` / `Yesterday` / `Jun 4, 2026`. */
function formatAlertDayHeading(value: string): string {
	const date = new Date(value)
	const today = startOfLocalDay(new Date())
	const target = startOfLocalDay(date)
	const dayMs = 86_400_000
	if (target === today) return "Today"
	if (target === today - dayMs) return "Yesterday"
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/* -------------------------------------------------------------------------- */
/*  Delivery-event presentation                                               */
/* -------------------------------------------------------------------------- */

/**
 * One token-based vocabulary for alert event types, shared by the delivery log,
 * the recent-activity table, and the chat attachment card. Color is always
 * paired with the label — never the only signal.
 */
export const eventTypeMeta: Record<AlertEventType, { label: string; dot: string; text: string }> = {
	trigger: { label: "Triggered", dot: "bg-destructive", text: "text-destructive" },
	resolve: { label: "Resolved", dot: "bg-success", text: "text-success" },
	renotify: { label: "Re-notified", dot: "bg-warning", text: "text-warning" },
	test: { label: "Test", dot: "bg-info", text: "text-info" },
} satisfies Record<AlertEventType, { label: string; dot: string; text: string }>

export type DeliveryStatusVariant = "success" | "error" | "warning" | "outline"

/** Delivery status → Badge variant + human label. */
export const deliveryStatusMeta: Record<
	AlertDeliveryStatus,
	{ label: string; variant: DeliveryStatusVariant }
> = {
	success: { label: "Delivered", variant: "success" },
	failed: { label: "Failed", variant: "error" },
	processing: { label: "Sending", variant: "warning" },
	queued: { label: "Queued", variant: "outline" },
} satisfies Record<AlertDeliveryStatus, { label: string; variant: DeliveryStatusVariant }>

export interface DeliveryEventDayGroup {
	key: string
	label: string
	events: AlertDeliveryEventDocument[]
}

/**
 * Group delivery events by calendar day. Assumes the input is sorted
 * newest-first (as the API returns it), so same-day events are contiguous.
 */
export function groupDeliveryEventsByDay(
	events: ReadonlyArray<AlertDeliveryEventDocument>,
): DeliveryEventDayGroup[] {
	const groups: DeliveryEventDayGroup[] = []
	for (const event of events) {
		const d = new Date(event.scheduledAt)
		const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
		const last = groups[groups.length - 1]
		if (last && last.key === key) {
			last.events.push(event)
		} else {
			groups.push({ key, label: formatAlertDayHeading(event.scheduledAt), events: [event] })
		}
	}
	return groups
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
