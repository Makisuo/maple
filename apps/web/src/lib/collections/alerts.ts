import {
	AlertComparator,
	AlertDestinationId,
	AlertEventType,
	AlertGroupBy,
	AlertIncidentDocument,
	AlertIncidentStatus,
	AlertMetricAggregation,
	AlertMetricType,
	AlertNotificationTemplate,
	AlertRuleDocument,
	AlertRuleId,
	AlertSeverity,
	AlertSignalType,
	ErrorIssueId,
	IsoDateTimeString,
	QueryBuilderQueryDraftSchema,
	UserId,
} from "@maple/domain/http"
import { QueryEngineAlertReducer } from "@maple/domain/query-engine"
import { Option, Schema } from "effect"
import { createSyncedCollection, timestamptzParser } from "./shape-fetch"

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
const asAlertRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asAlertIncidentId = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const asUserId = Schema.decodeUnknownSync(UserId)
const asErrorIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeDestinationId = Schema.decodeUnknownSync(AlertDestinationId)

const asSeverity = Schema.decodeUnknownSync(AlertSeverity)
const asSignalType = Schema.decodeUnknownSync(AlertSignalType)
const asComparator = Schema.decodeUnknownSync(AlertComparator)
const asMetricType = Schema.decodeUnknownSync(AlertMetricType)
const asMetricAggregation = Schema.decodeUnknownSync(AlertMetricAggregation)
const asIncidentStatus = Schema.decodeUnknownSync(AlertIncidentStatus)
const asEventType = Schema.decodeUnknownSync(AlertEventType)
const asReducer = Schema.decodeUnknownSync(QueryEngineAlertReducer)

const decodeNotificationTemplate = Schema.decodeUnknownOption(AlertNotificationTemplate)
const decodeQueryBuilderDraft = Schema.decodeUnknownOption(QueryBuilderQueryDraftSchema)
const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
// The stored `group_by` column is a JSON-encoded string array (mirrors the
// server's `Schema.fromJsonString(AlertGroupBy)`).
const decodeGroupByFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(AlertGroupBy))

/**
 * `safeParseStringArray` mirrors AlertsService: use the value when it decodes to
 * an array of strings, else fall back to `[]`. Row json columns arrive as parsed
 * arrays via the @electric-sql/client default parser.
 */
const safeParseStringArray = (value: unknown): ReadonlyArray<string> =>
	Option.getOrElse(decodeStringArray(value), () => [] as ReadonlyArray<string>)

// ---------------------------------------------------------------------------
// alert_rules
// ---------------------------------------------------------------------------

/**
 * Identity row schema for `alert_rules` — mirrors the pgTable columns (snake_case)
 * so a post-deploy column drift surfaces as a SchemaValidationError (→ self-heal),
 * not as silently-dropped fields. Timestamp columns stay `Schema.String` (the
 * timestamptz parser has already normalized them to ISO).
 */
export const AlertRuleRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	name: Schema.String,
	notes: Schema.NullOr(Schema.String),
	notification_template_json: Schema.NullOr(Schema.Unknown),
	enabled: Schema.Boolean,
	severity: Schema.String,
	service_names_json: Schema.NullOr(Schema.Unknown),
	exclude_service_names_json: Schema.NullOr(Schema.Unknown),
	tags_json: Schema.NullOr(Schema.Unknown),
	signal_type: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	window_minutes: Schema.Number,
	minimum_sample_count: Schema.Number,
	consecutive_breaches_required: Schema.Number,
	consecutive_healthy_required: Schema.Number,
	renotify_interval_minutes: Schema.Number,
	metric_name: Schema.NullOr(Schema.String),
	metric_type: Schema.NullOr(Schema.String),
	metric_aggregation: Schema.NullOr(Schema.String),
	apdex_threshold_ms: Schema.NullOr(Schema.Number),
	query_builder_draft_json: Schema.NullOr(Schema.Unknown),
	raw_query_sql: Schema.NullOr(Schema.String),
	reducer: Schema.String,
	group_by: Schema.NullOr(Schema.String),
	destination_ids_json: Schema.Unknown,
	query_spec_json: Schema.NullOr(Schema.Unknown),
	sample_count_strategy: Schema.NullOr(Schema.String),
	no_data_behavior: Schema.String,
	last_scheduled_at: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
	created_by: Schema.String,
	updated_by: Schema.String,
})
export type AlertRuleRow = typeof AlertRuleRowSchema.Type

// ---------------------------------------------------------------------------
// alert_rule_states
// ---------------------------------------------------------------------------

export const AlertRuleStateRowSchema = Schema.Struct({
	org_id: Schema.String,
	rule_id: Schema.String,
	group_key: Schema.String,
	consecutive_breaches: Schema.Number,
	consecutive_healthy: Schema.Number,
	last_status: Schema.NullOr(Schema.String),
	last_value: Schema.NullOr(Schema.Number),
	last_sample_count: Schema.NullOr(Schema.Number),
	last_evaluated_at: Schema.NullOr(Schema.String),
	last_error: Schema.NullOr(Schema.String),
	updated_at: Schema.String,
})
export type AlertRuleStateRow = typeof AlertRuleStateRowSchema.Type

// ---------------------------------------------------------------------------
// alert_incidents
// ---------------------------------------------------------------------------

export const AlertIncidentRowSchema = Schema.Struct({
	id: Schema.String,
	org_id: Schema.String,
	rule_id: Schema.String,
	incident_key: Schema.String,
	rule_name: Schema.String,
	group_key: Schema.NullOr(Schema.String),
	signal_type: Schema.String,
	severity: Schema.String,
	status: Schema.String,
	comparator: Schema.String,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	first_triggered_at: Schema.String,
	last_triggered_at: Schema.String,
	resolved_at: Schema.NullOr(Schema.String),
	last_observed_value: Schema.NullOr(Schema.Number),
	last_sample_count: Schema.NullOr(Schema.Number),
	last_evaluated_at: Schema.NullOr(Schema.String),
	dedupe_key: Schema.String,
	last_delivered_event_type: Schema.NullOr(Schema.String),
	last_notified_at: Schema.NullOr(Schema.String),
	error_issue_id: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
})
export type AlertIncidentRow = typeof AlertIncidentRowSchema.Type

// ---------------------------------------------------------------------------
// Mappers (mirror the server row→document mappers in AlertsService.ts)
// ---------------------------------------------------------------------------

/**
 * Most recent evaluation error/timestamp for a rule, aggregated across its group
 * states — mirrors the server's `RuleEvaluationState` join. The map is keyed by
 * rule id and prefers the state row that carries a non-null `last_error`.
 */
export const buildRuleStatesByRuleId = (
	states: ReadonlyArray<AlertRuleStateRow>,
): Map<string, AlertRuleStateRow> => {
	const map = new Map<string, AlertRuleStateRow>()
	for (const state of states) {
		const existing = map.get(state.rule_id)
		// Prefer a row that has an error; otherwise keep any (the first seen).
		if (!existing || (state.last_error != null && existing.last_error == null)) {
			map.set(state.rule_id, state)
		}
	}
	return map
}

/**
 * Decodes a raw `alert_rules` row into the domain {@link AlertRuleDocument},
 * mirroring `rowToRuleDocument` in AlertsService.ts. The joined evaluation state
 * (from the `alert_rule_states` collection) supplies `lastEvaluationError` /
 * `lastEvaluatedAt`.
 */
export const rowToAlertRuleDocument = (
	row: AlertRuleRow,
	statesByRuleId: Map<string, AlertRuleStateRow>,
): AlertRuleDocument => {
	const state = statesByRuleId.get(row.id)
	return new AlertRuleDocument({
		id: asAlertRuleId(row.id),
		name: row.name,
		notes: row.notes ?? null,
		notificationTemplate:
			row.notification_template_json == null
				? null
				: Option.getOrElse(decodeNotificationTemplate(row.notification_template_json), () => null),
		enabled: row.enabled,
		severity: asSeverity(row.severity),
		serviceNames: [...safeParseStringArray(row.service_names_json)],
		excludeServiceNames: [...safeParseStringArray(row.exclude_service_names_json)],
		tags: [...safeParseStringArray(row.tags_json)],
		groupBy: row.group_by == null ? null : decodeGroupByFromJson(row.group_by),
		signalType: asSignalType(row.signal_type),
		comparator: asComparator(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.threshold_upper,
		windowMinutes: row.window_minutes,
		minimumSampleCount: row.minimum_sample_count,
		consecutiveBreachesRequired: row.consecutive_breaches_required,
		consecutiveHealthyRequired: row.consecutive_healthy_required,
		renotifyIntervalMinutes: row.renotify_interval_minutes,
		metricName: row.metric_name,
		metricType: row.metric_type != null ? asMetricType(row.metric_type) : null,
		metricAggregation: row.metric_aggregation != null ? asMetricAggregation(row.metric_aggregation) : null,
		apdexThresholdMs: row.apdex_threshold_ms,
		queryBuilderDraft:
			row.query_builder_draft_json == null
				? null
				: Option.getOrElse(decodeQueryBuilderDraft(row.query_builder_draft_json), () => null),
		rawQuerySql: row.raw_query_sql ?? null,
		rawQueryReducer: row.signal_type === "raw_query" ? asReducer(row.reducer) : null,
		destinationIds: safeParseStringArray(row.destination_ids_json).map((id) => decodeDestinationId(id)),
		lastEvaluationError: state?.last_error ?? null,
		lastEvaluatedAt: state?.last_evaluated_at != null ? decodeIso(state.last_evaluated_at) : null,
		createdAt: decodeIso(row.created_at),
		updatedAt: decodeIso(row.updated_at),
		createdBy: asUserId(row.created_by),
		updatedBy: asUserId(row.updated_by),
	})
}

/**
 * Decodes a raw `alert_incidents` row into the domain {@link AlertIncidentDocument},
 * mirroring `rowToIncidentDocument` in AlertsService.ts.
 */
export const rowToAlertIncidentDocument = (row: AlertIncidentRow): AlertIncidentDocument =>
	new AlertIncidentDocument({
		id: asAlertIncidentId(row.id),
		ruleId: asAlertRuleId(row.rule_id),
		ruleName: row.rule_name,
		groupKey: row.group_key,
		signalType: asSignalType(row.signal_type),
		severity: asSeverity(row.severity),
		status: asIncidentStatus(row.status),
		comparator: asComparator(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.threshold_upper,
		firstTriggeredAt: decodeIso(row.first_triggered_at),
		lastTriggeredAt: decodeIso(row.last_triggered_at),
		resolvedAt: row.resolved_at != null ? decodeIso(row.resolved_at) : null,
		lastObservedValue: row.last_observed_value,
		lastSampleCount: row.last_sample_count,
		dedupeKey: row.dedupe_key,
		lastDeliveredEventType:
			row.last_delivered_event_type != null ? asEventType(row.last_delivered_event_type) : null,
		lastNotifiedAt: row.last_notified_at != null ? decodeIso(row.last_notified_at) : null,
		errorIssueId: row.error_issue_id != null ? asErrorIssueId(row.error_issue_id) : null,
	})

// ---------------------------------------------------------------------------
// Collections (read-only — no write handlers)
// ---------------------------------------------------------------------------

export const createAlertRulesCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_rules",
		orgId,
		schema: AlertRuleRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export const createAlertRuleStatesCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_rule_states",
		orgId,
		schema: AlertRuleStateRowSchema,
		parser: timestamptzParser,
		// Composite key (org_id, rule_id, group_key) → a stable derived string.
		getKey: (row) => `${row.rule_id}:${row.group_key}`,
	})

export const createAlertIncidentsCollection = (orgId: string) =>
	createSyncedCollection({
		shape: "alert_incidents",
		orgId,
		schema: AlertIncidentRowSchema,
		parser: timestamptzParser,
		getKey: (row) => row.id,
	})

export type AlertRulesCollection = ReturnType<typeof createAlertRulesCollection>
export type AlertRuleStatesCollection = ReturnType<typeof createAlertRuleStatesCollection>
export type AlertIncidentsCollection = ReturnType<typeof createAlertIncidentsCollection>
