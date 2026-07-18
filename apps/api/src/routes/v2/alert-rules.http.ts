import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AlertCheckDocument, AlertRuleDocument, AlertRulePreviewResponse } from "@maple/domain/http"
import {
	AlertRulePreviewRequest,
	AlertRuleUpsertRequest,
	CurrentTenant,
	IsoDateTimeString,
	QueryBuilderQueryDraftSchema,
} from "@maple/domain/http"
import type {
	V2AlertCheck,
	V2AlertRule,
	V2AlertRuleCreateParams,
	V2AlertRuleMutationResponse,
	V2AlertRulePreviewResult,
	V2AlertRuleUpdateParams,
	V2InvalidRequestError,
} from "@maple/domain/http/v2"
import {
	MapleApiV2,
	invalidRequest,
	paginateArray,
	paginateOffsetQuery,
	resourceNotFound,
} from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { AlertsService } from "../../services/AlertsService"
import { mapAlertError } from "./alerts-error-map"

const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTimeString)

const toV2Rule = (doc: AlertRuleDocument): V2AlertRule => ({
	id: doc.id,
	object: "alert_rule",
	name: doc.name,
	notes: doc.notes,
	notification_template: doc.notificationTemplate,
	enabled: doc.enabled,
	severity: doc.severity,
	service_names: doc.serviceNames,
	exclude_service_names: doc.excludeServiceNames,
	tags: doc.tags,
	group_by: doc.groupBy,
	signal_type: doc.signalType,
	comparator: doc.comparator,
	threshold: doc.threshold,
	threshold_upper: doc.thresholdUpper,
	window_minutes: doc.windowMinutes,
	minimum_sample_count: doc.minimumSampleCount,
	consecutive_breaches_required: doc.consecutiveBreachesRequired,
	consecutive_healthy_required: doc.consecutiveHealthyRequired,
	renotify_interval_minutes: doc.renotifyIntervalMinutes,
	metric_name: doc.metricName,
	metric_type: doc.metricType,
	metric_aggregation: doc.metricAggregation,
	apdex_threshold_ms: doc.apdexThresholdMs,
	query_builder_draft: doc.queryBuilderDraft,
	raw_query_sql: doc.rawQuerySql,
	raw_query_reducer: doc.rawQueryReducer,
	destination_ids: doc.destinationIds,
	no_data_behavior: doc.noDataBehavior,
	last_evaluation_error: doc.lastEvaluationError,
	last_evaluated_at: doc.lastEvaluatedAt,
	last_scheduled_at: doc.lastScheduledAt,
	created_at: doc.createdAt,
	updated_at: doc.updatedAt,
	created_by: doc.createdBy,
	updated_by: doc.updatedBy,
})

const toV2RuleMutationResponse = (doc: AlertRuleDocument): V2AlertRuleMutationResponse => ({
	...toV2Rule(doc),
	...(doc.txid !== undefined ? { txid: doc.txid } : {}),
})

const toV2Check = (check: AlertCheckDocument): V2AlertCheck => ({
	object: "alert_check",
	timestamp: check.timestamp,
	group_key: check.groupKey,
	status: check.status,
	signal_type: check.signalType,
	comparator: check.comparator,
	threshold: check.threshold,
	threshold_upper: check.thresholdUpper,
	observed_value: check.observedValue,
	sample_count: check.sampleCount,
	window_minutes: check.windowMinutes,
	window_start: check.windowStart,
	window_end: check.windowEnd,
	consecutive_breaches: check.consecutiveBreaches,
	consecutive_healthy: check.consecutiveHealthy,
	incident_id: check.incidentId,
	incident_transition: check.incidentTransition,
	evaluation_duration_ms: check.evaluationDurationMs,
	error_message: check.errorMessage,
	error_category: check.errorCategory,
})

/**
 * The wire draft is an opaque JSON document (keys pass through verbatim);
 * validate it against the real draft schema before it reaches the service.
 */
const decodeDraft = (draft: Record<string, unknown>) =>
	Schema.decodeUnknownEffect(QueryBuilderQueryDraftSchema)(draft).pipe(
		Effect.mapError(() =>
			invalidRequest(
				"parameter_invalid",
				"query_builder_draft is not a valid query-builder draft document.",
				"query_builder_draft",
			),
		),
	)

const toUpsertRequest = (
	params: V2AlertRuleCreateParams,
): Effect.Effect<AlertRuleUpsertRequest, V2InvalidRequestError> =>
	Effect.gen(function* () {
		const draftField =
			params.query_builder_draft === undefined
				? {}
				: params.query_builder_draft === null
					? { queryBuilderDraft: null }
					: { queryBuilderDraft: yield* decodeDraft(params.query_builder_draft) }
		return new AlertRuleUpsertRequest({
			name: params.name,
			severity: params.severity,
			signalType: params.signal_type,
			comparator: params.comparator,
			threshold: params.threshold,
			windowMinutes: params.window_minutes,
			destinationIds: params.destination_ids,
			...(params.notes !== undefined ? { notes: params.notes } : {}),
			...(params.notification_template !== undefined
				? { notificationTemplate: params.notification_template }
				: {}),
			...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			...(params.service_names !== undefined ? { serviceNames: params.service_names } : {}),
			...(params.exclude_service_names !== undefined
				? { excludeServiceNames: params.exclude_service_names }
				: {}),
			...(params.tags !== undefined ? { tags: params.tags } : {}),
			...(params.group_by !== undefined ? { groupBy: params.group_by } : {}),
			...(params.threshold_upper !== undefined ? { thresholdUpper: params.threshold_upper } : {}),
			...(params.minimum_sample_count !== undefined
				? { minimumSampleCount: params.minimum_sample_count }
				: {}),
			...(params.consecutive_breaches_required !== undefined
				? { consecutiveBreachesRequired: params.consecutive_breaches_required }
				: {}),
			...(params.consecutive_healthy_required !== undefined
				? { consecutiveHealthyRequired: params.consecutive_healthy_required }
				: {}),
			...(params.renotify_interval_minutes !== undefined
				? { renotifyIntervalMinutes: params.renotify_interval_minutes }
				: {}),
			...(params.metric_name !== undefined ? { metricName: params.metric_name } : {}),
			...(params.metric_type !== undefined ? { metricType: params.metric_type } : {}),
			...(params.metric_aggregation !== undefined
				? { metricAggregation: params.metric_aggregation }
				: {}),
			...(params.apdex_threshold_ms !== undefined
				? { apdexThresholdMs: params.apdex_threshold_ms }
				: {}),
			...(params.raw_query_sql !== undefined ? { rawQuerySql: params.raw_query_sql } : {}),
			...(params.raw_query_reducer !== undefined ? { rawQueryReducer: params.raw_query_reducer } : {}),
			...draftField,
		})
	})

/**
 * PATCH semantics over the v1 full-upsert `updateRule`: overlay the fields
 * present in the patch onto the rule's current state. Read-merge-write — no
 * version check, mirroring the dashboard's behavior.
 */
const mergeUpsertRequest = (
	doc: AlertRuleDocument,
	patch: V2AlertRuleUpdateParams,
): Effect.Effect<AlertRuleUpsertRequest, V2InvalidRequestError> =>
	Effect.gen(function* () {
		const signalType = patch.signal_type ?? doc.signalType
		const queryBuilderDraft =
			signalType !== "builder_query"
				? null
				: patch.query_builder_draft === undefined
					? doc.signalType === "builder_query"
						? doc.queryBuilderDraft
						: null
				: patch.query_builder_draft === null
					? null
					: yield* decodeDraft(patch.query_builder_draft)
		const rawQuerySql =
			signalType !== "raw_query"
				? null
				: patch.raw_query_sql !== undefined
					? patch.raw_query_sql
					: doc.signalType === "raw_query"
						? doc.rawQuerySql
						: null
		const rawQueryReducer =
			signalType !== "raw_query"
				? null
				: patch.raw_query_reducer !== undefined
					? patch.raw_query_reducer
					: doc.signalType === "raw_query"
						? doc.rawQueryReducer
						: null
		return new AlertRuleUpsertRequest({
			name: patch.name ?? doc.name,
			notes: patch.notes !== undefined ? patch.notes : doc.notes,
			notificationTemplate:
				patch.notification_template !== undefined
					? patch.notification_template
					: doc.notificationTemplate,
			enabled: patch.enabled ?? doc.enabled,
			severity: patch.severity ?? doc.severity,
			serviceNames: patch.service_names ?? doc.serviceNames,
			excludeServiceNames: patch.exclude_service_names ?? doc.excludeServiceNames,
			tags: patch.tags ?? doc.tags,
			groupBy: patch.group_by !== undefined ? patch.group_by : doc.groupBy,
			signalType,
			comparator: patch.comparator ?? doc.comparator,
			threshold: patch.threshold ?? doc.threshold,
			thresholdUpper: patch.threshold_upper !== undefined ? patch.threshold_upper : doc.thresholdUpper,
			windowMinutes: patch.window_minutes ?? doc.windowMinutes,
			minimumSampleCount: patch.minimum_sample_count ?? doc.minimumSampleCount,
			consecutiveBreachesRequired:
				patch.consecutive_breaches_required ?? doc.consecutiveBreachesRequired,
			consecutiveHealthyRequired: patch.consecutive_healthy_required ?? doc.consecutiveHealthyRequired,
			renotifyIntervalMinutes: patch.renotify_interval_minutes ?? doc.renotifyIntervalMinutes,
			metricName: patch.metric_name !== undefined ? patch.metric_name : doc.metricName,
			metricType: patch.metric_type !== undefined ? patch.metric_type : doc.metricType,
			metricAggregation:
				patch.metric_aggregation !== undefined ? patch.metric_aggregation : doc.metricAggregation,
			apdexThresholdMs:
				patch.apdex_threshold_ms !== undefined ? patch.apdex_threshold_ms : doc.apdexThresholdMs,
			queryBuilderDraft,
			rawQuerySql,
			rawQueryReducer,
			destinationIds: patch.destination_ids ?? doc.destinationIds,
		})
	})

const toV2PreviewResult = (preview: AlertRulePreviewResponse): V2AlertRulePreviewResult => ({
	object: "alert_rule.preview",
	bucket_seconds: preview.bucketSeconds,
	window_minutes: preview.windowMinutes,
	threshold: preview.threshold,
	threshold_upper: preview.thresholdUpper,
	comparator: preview.comparator,
	truncated_to_start: preview.truncatedToStart,
	series: preview.series.map((series) => ({
		group_key: series.groupKey,
		points: series.points.map((point) => ({
			bucket: point.bucket,
			value: point.value,
			sample_count: point.sampleCount,
			status: point.status,
			...(point.provisional !== undefined ? { provisional: point.provisional } : {}),
		})),
	})),
	would_fire: preview.wouldFire.map((span) => ({
		group_key: span.groupKey,
		start: span.start,
		end: span.end,
	})),
})

export const HttpV2AlertRulesLive = HttpApiBuilder.group(MapleApiV2, "alertRules", (handlers) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService

		const findRule = (orgId: Parameters<typeof alerts.listRules>[0], ruleId: AlertRuleDocument["id"]) =>
			Effect.gen(function* () {
				const response = yield* alerts.listRules(orgId).pipe(mapAlertError("rule_list"))
				const rule = response.rules.find((doc) => doc.id === ruleId)
				if (rule === undefined)
					return yield* Effect.fail(resourceNotFound("alert_rule", "No such alert rule."))
				return rule
			})

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* alerts.listRules(tenant.orgId).pipe(mapAlertError("rule_list"))
					const page = yield* paginateArray(response.rules.map(toV2Rule), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rule = yield* findRule(tenant.orgId, params.id)
					return toV2Rule(rule)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* toUpsertRequest(payload)
					const created = yield* alerts
						.createRule(tenant.orgId, tenant.userId, tenant.roles, request)
						.pipe(mapAlertError("rule_create"))
					return toV2RuleMutationResponse(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const current = yield* findRule(tenant.orgId, params.id)
					const request = yield* mergeUpsertRequest(current, payload)
					const updated = yield* alerts
						.updateRule(tenant.orgId, tenant.userId, tenant.roles, params.id, request)
						.pipe(mapAlertError("rule_update"))
					return toV2RuleMutationResponse(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* alerts
						.deleteRule(tenant.orgId, tenant.roles, params.id)
						.pipe(mapAlertError("rule_delete"))
					return {
						id: deleted.id,
						object: "alert_rule" as const,
						deleted: true as const,
						...(deleted.txid !== undefined ? { txid: deleted.txid } : {}),
					}
				}),
			)
			.handle("test", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rule = yield* toUpsertRequest(payload.rule)
					const result = yield* alerts
						.testRule(tenant.orgId, tenant.userId, tenant.roles, rule, payload.send_notification)
						.pipe(mapAlertError("rule_test"))
					return {
						object: "alert_rule.test_result" as const,
						status: result.status,
						value: result.value,
						sample_count: result.sampleCount,
						threshold: result.threshold,
						threshold_upper: result.thresholdUpper,
						comparator: result.comparator,
						reason: result.reason,
					}
				}),
			)
			.handle("preview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rule = yield* toUpsertRequest(payload.rule)
					const preview = yield* alerts
						.previewRule(
							tenant.orgId,
							new AlertRulePreviewRequest({
								rule,
								startTime: decodeIsoDateTime(payload.start_time),
								endTime: decodeIsoDateTime(payload.end_time),
							}),
						)
						.pipe(mapAlertError("rule_preview"))
					return toV2PreviewResult(preview)
				}),
			)
			.handle("checks", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						alerts
							.listRuleChecks(tenant.orgId, params.id, {
								...(query.group_key !== undefined ? { groupKey: query.group_key } : {}),
								...(query.since !== undefined ? { since: query.since } : {}),
								...(query.until !== undefined ? { until: query.until } : {}),
								limit,
								offset,
							})
							.pipe(
								mapAlertError("rule_checks_list"),
								Effect.map((response) => response.checks.map(toV2Check)),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
	}),
)
