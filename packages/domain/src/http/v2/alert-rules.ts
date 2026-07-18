import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { QueryEngineAlertReducer, QueryEngineNoDataBehavior } from "../../query-engine"
import { PostgresTransactionId, UserId } from "../../primitives"
import {
	AlertCheckStatus,
	AlertComparator,
	AlertEvaluationStatus,
	AlertIncidentTransition,
	AlertMetricAggregation,
	AlertMetricType,
	AlertNotificationTemplate,
	AlertSeverity,
	AlertSignalType,
} from "../alerts"
import { AlertDestinationPublicId } from "./alert-destinations"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "./errors"
import { AlertIncidentPublicId, AlertRulePublicId } from "./resource-ids"

export { AlertIncidentPublicId, AlertRulePublicId } from "./resource-ids"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed()))
const PositiveInt = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0)))
const NonNegativeInt = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))
const PositiveFloat = Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isGreaterThan(0)))

const GroupBy = Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMinLength(1)))

/** Mirrors the v1 caps (alerts.ts): 32-char tags, at most 20 per rule. */
const RuleTags = Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(Schema.isMaxLength(20))

/**
 * The dashboard query-builder draft backing `builder_query` rules, passed
 * through **verbatim** (no snake_case↔camelCase key remapping): the draft
 * embeds user telemetry-attribute keys whose casing is significant. The server
 * validates the document against the full draft schema on create/update.
 */
const QueryBuilderDraftPassthrough = Schema.Record(Schema.String, Schema.Unknown).annotate({
	identifier: "AlertQueryBuilderDraft",
	title: "Query-builder draft",
	description:
		"The query-builder draft document for `builder_query` rules, exactly as produced by the Maple dashboard. Treat it as an opaque document: keys are passed through verbatim (no case conversion) and the server validates the structure on write.",
})

const alertRuleExample = {
	id: "alrt_gU26thvJECdQvu54Ad9jiz",
	object: "alert_rule",
	name: "Checkout error rate",
	notes: null,
	notification_template: null,
	enabled: true,
	severity: "critical",
	service_names: ["checkout"],
	exclude_service_names: [],
	tags: ["payments"],
	group_by: null,
	signal_type: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	threshold_upper: null,
	window_minutes: 5,
	minimum_sample_count: 50,
	consecutive_breaches_required: 2,
	consecutive_healthy_required: 3,
	renotify_interval_minutes: 60,
	metric_name: null,
	metric_type: null,
	metric_aggregation: null,
	apdex_threshold_ms: null,
	query_builder_draft: null,
	raw_query_sql: null,
	raw_query_reducer: null,
	destination_ids: ["dest_oybbpTBhtSFGShMjjLiCrh"],
	no_data_behavior: "skip",
	last_evaluation_error: null,
	last_evaluated_at: "2026-07-15T09:10:00.000Z",
	last_scheduled_at: "2026-07-15T09:10:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-14T08:30:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	updated_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AlertRule = Schema.Struct({
	id: AlertRulePublicId,
	object: Schema.Literal("alert_rule").annotate({
		description: 'The object type — always `"alert_rule"`.',
		examples: ["alert_rule"],
	}),
	name: Schema.String.annotate({
		description: "Human-readable name of the rule.",
		examples: ["Checkout error rate"],
	}),
	notes: Schema.NullOr(Schema.String).annotate({
		description: "Free-form operator notes shown alongside the rule, or `null`.",
	}),
	notification_template: Schema.NullOr(AlertNotificationTemplate).annotate({
		description:
			"Custom notification message (`title` + Markdown `body` with `{{ variable }}` substitution, plus per-channel `overrides`), or `null` for Maple's built-in format.",
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether the scheduler evaluates this rule.",
		examples: [true],
	}),
	severity: AlertSeverity.annotate({
		description: "Severity attached to incidents this rule opens: `warning` or `critical`.",
		examples: ["critical"],
	}),
	service_names: Schema.Array(Schema.String).annotate({
		description: "Services the rule is scoped to. Empty for all services.",
		examples: [["checkout"]],
	}),
	exclude_service_names: Schema.Array(Schema.String).annotate({
		description: "Services excluded from evaluation.",
	}),
	tags: Schema.Array(Schema.String).annotate({
		description: "Free-form tags used to group and filter rules.",
		examples: [["payments"]],
	}),
	group_by: Schema.NullOr(GroupBy).annotate({
		description:
			"Attribute dimensions to evaluate per-group (each group gets its own incident lifecycle), or `null` for a single aggregate evaluation.",
	}),
	signal_type: AlertSignalType.annotate({
		description:
			"What the rule measures: `error_rate`, `p95_latency`, `p99_latency`, `apdex`, `throughput`, `metric`, `builder_query`, or `raw_query`.",
		examples: ["error_rate"],
	}),
	comparator: AlertComparator.annotate({
		description:
			"Comparison operator: `gt`, `gte`, `lt`, `lte`, `eq`, `neq`, or the range forms `between` / `not_between` (which also require `threshold_upper`).",
		examples: ["gt"],
	}),
	threshold: Schema.Number.annotate({
		description: "The threshold the observed value is compared against. Error rates are 0–1 ratios.",
		examples: [0.05],
	}),
	threshold_upper: Schema.NullOr(Schema.Number).annotate({
		description: "Upper bound for range comparators (`between` / `not_between`), otherwise `null`.",
	}),
	window_minutes: PositiveInt.annotate({
		description: "Length of the evaluation window in minutes.",
		examples: [5],
	}),
	minimum_sample_count: NonNegativeInt.annotate({
		description:
			"Minimum samples required in the window before the rule can breach; below it the check is skipped.",
		examples: [50],
	}),
	consecutive_breaches_required: PositiveInt.annotate({
		description: "Consecutive breached checks required before an incident opens.",
		examples: [2],
	}),
	consecutive_healthy_required: PositiveInt.annotate({
		description: "Consecutive healthy checks required before an open incident resolves.",
		examples: [3],
	}),
	renotify_interval_minutes: PositiveInt.annotate({
		description: "How often an open incident re-notifies its destinations, in minutes.",
		examples: [60],
	}),
	metric_name: Schema.NullOr(Schema.String).annotate({
		description: "For `metric` rules: the metric to evaluate. `null` for other signal types.",
	}),
	metric_type: Schema.NullOr(AlertMetricType).annotate({
		description:
			"For `metric` rules: the metric's type (`sum`, `gauge`, `histogram`, `exponential_histogram`).",
	}),
	metric_aggregation: Schema.NullOr(AlertMetricAggregation).annotate({
		description:
			"For `metric` rules: how samples aggregate in the window (`avg`, `min`, `max`, `sum`, `count`).",
	}),
	apdex_threshold_ms: Schema.NullOr(PositiveFloat).annotate({
		description: "For `apdex` rules: the satisfied-latency threshold in milliseconds.",
	}),
	query_builder_draft: Schema.NullOr(QueryBuilderDraftPassthrough),
	raw_query_sql: Schema.NullOr(Schema.String).annotate({
		description: "For `raw_query` rules: the SQL evaluated each window. `null` for other signal types.",
	}),
	raw_query_reducer: Schema.NullOr(QueryEngineAlertReducer).annotate({
		description:
			"For `raw_query` rules: how multi-row results reduce to one value (`identity`, `sum`, `avg`, `min`, `max`).",
	}),
	destination_ids: Schema.Array(AlertDestinationPublicId).annotate({
		description: "The alert destinations (`dest_…`) this rule notifies.",
	}),
	no_data_behavior: QueryEngineNoDataBehavior.annotate({
		description:
			"What the evaluator does when the window has no data: `skip` the check or treat the value as `zero`.",
		examples: ["skip"],
	}),
	last_evaluation_error: Schema.NullOr(Schema.String).annotate({
		description:
			"The most recent evaluation error for this rule, or `null` if the last evaluation succeeded.",
	}),
	last_evaluated_at: Schema.NullOr(Timestamp).annotate({
		description: "When the rule was last evaluated, or `null` if never.",
	}),
	last_scheduled_at: Schema.NullOr(Timestamp).annotate({
		description: "When the scheduler last picked the rule up, or `null` if never.",
	}),
	created_at: Timestamp.annotate({ description: "When the rule was created." }),
	updated_at: Timestamp.annotate({ description: "When the rule was last updated." }),
	created_by: UserId.annotate({ description: "Maple user ID of the rule's creator." }),
	updated_by: UserId.annotate({ description: "Maple user ID of the last editor." }),
}).annotate({
	identifier: "AlertRule",
	title: "Alert Rule",
	description:
		"A monitor that evaluates a signal (error rate, latency, Apdex, throughput, a metric, a query-builder query, or raw SQL) over a rolling window and opens incidents when the threshold condition holds for enough consecutive checks. Notifications are delivered to the referenced alert destinations.",
	examples: [wireExample(alertRuleExample)],
})
export type V2AlertRule = Schema.Schema.Type<typeof V2AlertRule>

const MutationTxidFields = {
	txid: Schema.optionalKey(PostgresTransactionId),
}

/** Returned by create/update: the rule plus optional Electric reconciliation metadata. */
export const V2AlertRuleMutationResponse = Schema.Struct({
	...V2AlertRule.fields,
	...MutationTxidFields,
}).annotate({
	identifier: "AlertRuleMutationResponse",
	title: "Alert rule mutation response",
	description:
		"The alert rule state after a create or update. `txid` is optional reconciliation metadata for ElectricSQL-integrated clients; other public API consumers do not need it.",
	examples: [wireExample({ ...alertRuleExample, txid: "81234" })],
})
export type V2AlertRuleMutationResponse = Schema.Schema.Type<typeof V2AlertRuleMutationResponse>

export const V2AlertRuleDeleteResponse = Schema.Struct({
	id: AlertRulePublicId,
	object: Schema.Literal("alert_rule").annotate({
		description: 'The object type — always `"alert_rule"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the rule no longer exists.",
	}),
	...MutationTxidFields,
}).annotate({
	identifier: "AlertRuleDeleteResponse",
	title: "Alert rule delete response",
	description: "Confirmation that an alert rule was deleted.",
	examples: [
		wireExample({
			id: "alrt_gU26thvJECdQvu54Ad9jiz",
			object: "alert_rule",
			deleted: true,
			txid: "81234",
		}),
	],
})
export type V2AlertRuleDeleteResponse = Schema.Schema.Type<typeof V2AlertRuleDeleteResponse>

const createParamsFields = {
	name: NonEmptyString.annotate({
		description: "Human-readable name of the rule. Required, non-empty.",
		examples: ["Checkout error rate"],
	}),
	notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
	notification_template: Schema.optionalKey(Schema.NullOr(AlertNotificationTemplate)),
	enabled: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Whether the rule starts enabled. Defaults to `true`." }),
	),
	severity: AlertSeverity.annotate({
		description: "Severity attached to incidents this rule opens.",
		examples: ["critical"],
	}),
	service_names: Schema.optionalKey(Schema.Array(Schema.String)),
	exclude_service_names: Schema.optionalKey(Schema.Array(Schema.String)),
	tags: Schema.optionalKey(RuleTags),
	group_by: Schema.optionalKey(Schema.NullOr(GroupBy)),
	signal_type: AlertSignalType.annotate({
		description: "What the rule measures.",
		examples: ["error_rate"],
	}),
	comparator: AlertComparator.annotate({
		description:
			"Comparison operator. Range forms (`between` / `not_between`) also require `threshold_upper`.",
		examples: ["gt"],
	}),
	threshold: Schema.Number.annotate({
		description: "The threshold to compare against. Error rates are 0–1 ratios.",
		examples: [0.05],
	}),
	threshold_upper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	window_minutes: PositiveInt.annotate({
		description: "Length of the evaluation window in minutes.",
		examples: [5],
	}),
	minimum_sample_count: Schema.optionalKey(NonNegativeInt),
	consecutive_breaches_required: Schema.optionalKey(PositiveInt),
	consecutive_healthy_required: Schema.optionalKey(PositiveInt),
	renotify_interval_minutes: Schema.optionalKey(PositiveInt),
	metric_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	metric_type: Schema.optionalKey(Schema.NullOr(AlertMetricType)),
	metric_aggregation: Schema.optionalKey(Schema.NullOr(AlertMetricAggregation)),
	apdex_threshold_ms: Schema.optionalKey(Schema.NullOr(PositiveFloat)),
	query_builder_draft: Schema.optionalKey(Schema.NullOr(QueryBuilderDraftPassthrough)),
	raw_query_sql: Schema.optionalKey(Schema.NullOr(Schema.String)),
	raw_query_reducer: Schema.optionalKey(Schema.NullOr(QueryEngineAlertReducer)),
	destination_ids: Schema.Array(AlertDestinationPublicId).annotate({
		description: "The alert destinations (`dest_…`) to notify. May be empty.",
	}),
}

export const V2AlertRuleCreateParams = Schema.Struct(createParamsFields).annotate({
	identifier: "AlertRuleCreateParams",
	title: "Alert rule create parameters",
	description:
		"Request body for creating an alert rule. Signal-specific fields (`metric_*`, `apdex_threshold_ms`, `query_builder_draft`, `raw_query_*`) are required by their respective `signal_type` and validated server-side.",
	examples: [
		wireExample({
			name: "Checkout error rate",
			severity: "critical",
			service_names: ["checkout"],
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			window_minutes: 5,
			destination_ids: ["dest_oybbpTBhtSFGShMjjLiCrh"],
		}),
	],
})
export type V2AlertRuleCreateParams = Schema.Schema.Type<typeof V2AlertRuleCreateParams>

/** Every field optional: a true PATCH — omitted fields are left unchanged. */
export const V2AlertRuleUpdateParams = Schema.Struct({
	name: Schema.optionalKey(createParamsFields.name),
	severity: Schema.optionalKey(createParamsFields.severity),
	signal_type: Schema.optionalKey(createParamsFields.signal_type),
	comparator: Schema.optionalKey(createParamsFields.comparator),
	threshold: Schema.optionalKey(createParamsFields.threshold),
	window_minutes: Schema.optionalKey(createParamsFields.window_minutes),
	destination_ids: Schema.optionalKey(createParamsFields.destination_ids),
	notes: createParamsFields.notes,
	notification_template: createParamsFields.notification_template,
	enabled: createParamsFields.enabled,
	service_names: createParamsFields.service_names,
	exclude_service_names: createParamsFields.exclude_service_names,
	tags: createParamsFields.tags,
	group_by: createParamsFields.group_by,
	threshold_upper: createParamsFields.threshold_upper,
	minimum_sample_count: createParamsFields.minimum_sample_count,
	consecutive_breaches_required: createParamsFields.consecutive_breaches_required,
	consecutive_healthy_required: createParamsFields.consecutive_healthy_required,
	renotify_interval_minutes: createParamsFields.renotify_interval_minutes,
	metric_name: createParamsFields.metric_name,
	metric_type: createParamsFields.metric_type,
	metric_aggregation: createParamsFields.metric_aggregation,
	apdex_threshold_ms: createParamsFields.apdex_threshold_ms,
	query_builder_draft: createParamsFields.query_builder_draft,
	raw_query_sql: createParamsFields.raw_query_sql,
	raw_query_reducer: createParamsFields.raw_query_reducer,
}).annotate({
	identifier: "AlertRuleUpdateParams",
	title: "Alert rule update parameters",
	description: "Request body for updating an alert rule. Omitted fields are left unchanged.",
	examples: [wireExample({ enabled: false })],
})
export type V2AlertRuleUpdateParams = Schema.Schema.Type<typeof V2AlertRuleUpdateParams>

export const V2AlertRuleTestParams = Schema.Struct({
	rule: V2AlertRuleCreateParams,
	send_notification: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Also deliver a test notification to the rule's destinations. Defaults to `false`.",
		}),
	),
}).annotate({
	identifier: "AlertRuleTestParams",
	title: "Alert rule test parameters",
	description: "Request body for a one-off evaluation of a rule definition against live data.",
})
export type V2AlertRuleTestParams = Schema.Schema.Type<typeof V2AlertRuleTestParams>

export const V2AlertRuleTestResult = Schema.Struct({
	object: Schema.Literal("alert_rule.test_result").annotate({
		description: 'The object type — always `"alert_rule.test_result"`.',
	}),
	status: AlertEvaluationStatus.annotate({
		description:
			"The evaluation verdict: `breached`, `healthy`, or `skipped` (not enough samples / no data).",
		examples: ["breached"],
	}),
	value: Schema.NullOr(Schema.Number).annotate({
		description: "The observed value, or `null` when the check was skipped.",
		examples: [0.09],
	}),
	sample_count: Schema.Number.annotate({
		description: "Number of samples in the evaluated window.",
		examples: [132],
	}),
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	comparator: AlertComparator,
	reason: Schema.String.annotate({
		description: "Human-readable explanation of the verdict.",
		examples: ["error rate 9.0% > threshold 5.0%"],
	}),
}).annotate({
	identifier: "AlertRuleTestResult",
	title: "Alert rule test result",
	description: "The outcome of a one-off rule evaluation against live data.",
	examples: [
		wireExample({
			object: "alert_rule.test_result",
			status: "breached",
			value: 0.09,
			sample_count: 132,
			threshold: 0.05,
			threshold_upper: null,
			comparator: "gt",
			reason: "error rate 9.0% > threshold 5.0%",
		}),
	],
})
export type V2AlertRuleTestResult = Schema.Schema.Type<typeof V2AlertRuleTestResult>

export const V2AlertRulePreviewParams = Schema.Struct({
	rule: V2AlertRuleCreateParams,
	start_time: Timestamp.annotate({
		description: "Start of the preview range (ISO-8601 UTC), e.g. `2026-07-14T00:00:00.000Z`.",
	}),
	end_time: Timestamp.annotate({
		description: "End of the preview range (ISO-8601 UTC), e.g. `2026-07-15T00:00:00.000Z`.",
	}),
}).annotate({
	identifier: "AlertRulePreviewParams",
	title: "Alert rule preview parameters",
	description:
		"Request body for previewing what a rule definition would have observed over a historical range.",
})
export type V2AlertRulePreviewParams = Schema.Schema.Type<typeof V2AlertRulePreviewParams>

const V2AlertRulePreviewPoint = Schema.Struct({
	bucket: Timestamp.annotate({ description: "End of the evaluation window this point describes." }),
	value: Schema.NullOr(Schema.Number),
	sample_count: Schema.Number,
	status: AlertEvaluationStatus,
	provisional: Schema.optionalKey(
		Schema.Boolean.annotate({
			description:
				"Set on the trailing in-progress window: evaluated over less than a full window, so its value may still move.",
		}),
	),
}).annotate({ identifier: "AlertRulePreviewPoint", title: "Alert rule preview point" })

const V2AlertRulePreviewSeries = Schema.Struct({
	group_key: Schema.String.annotate({
		description: 'The group this series describes, or `"__total__"` for ungrouped rules.',
	}),
	points: Schema.Array(V2AlertRulePreviewPoint),
}).annotate({ identifier: "AlertRulePreviewSeries", title: "Alert rule preview series" })

const V2AlertRulePreviewFiringSpan = Schema.Struct({
	group_key: Schema.String,
	start: Timestamp,
	end: Timestamp,
}).annotate({
	identifier: "AlertRulePreviewFiringSpan",
	title: "Alert rule preview firing span",
	description: "A span during which the rule's state machine would have held an open incident.",
})

export const V2AlertRulePreviewResult = Schema.Struct({
	object: Schema.Literal("alert_rule.preview").annotate({
		description: 'The object type — always `"alert_rule.preview"`.',
	}),
	bucket_seconds: Schema.Number.annotate({ description: "Width of each preview bucket, in seconds." }),
	window_minutes: Schema.Number,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	comparator: AlertComparator,
	truncated_to_start: Schema.NullOr(Timestamp).annotate({
		description: "Set when the requested range was clamped to the preview bucket cap.",
	}),
	series: Schema.Array(V2AlertRulePreviewSeries),
	would_fire: Schema.Array(V2AlertRulePreviewFiringSpan).annotate({
		description: "Spans during which the rule would have held an open incident.",
	}),
}).annotate({
	identifier: "AlertRulePreviewResult",
	title: "Alert rule preview result",
	description:
		"Evaluator-faithful preview of a rule over a historical range: the per-window observations the scheduler would have computed, and when incidents would have fired.",
	examples: [
		wireExample({
			object: "alert_rule.preview",
			bucket_seconds: 300,
			window_minutes: 5,
			threshold: 0.05,
			threshold_upper: null,
			comparator: "gt",
			truncated_to_start: null,
			series: [
				{
					group_key: "__total__",
					points: [
						{
							bucket: "2026-07-15T09:10:00.000Z",
							value: 0.09,
							sample_count: 132,
							status: "breached",
						},
					],
				},
			],
			would_fire: [
				{
					group_key: "__total__",
					start: "2026-07-15T09:10:00.000Z",
					end: "2026-07-15T09:40:00.000Z",
				},
			],
		}),
	],
})
export type V2AlertRulePreviewResult = Schema.Schema.Type<typeof V2AlertRulePreviewResult>

export const V2AlertCheck = Schema.Struct({
	object: Schema.Literal("alert_check").annotate({
		description: 'The object type — always `"alert_check"`.',
	}),
	timestamp: Timestamp.annotate({ description: "When the check was recorded." }),
	group_key: Schema.String.annotate({
		description: 'The evaluated group, or `"__total__"` for ungrouped rules.',
		examples: ["__total__"],
	}),
	status: AlertCheckStatus.annotate({
		description: "`breached`, `healthy`, `skipped`, or `error` (the evaluation query failed).",
		examples: ["breached"],
	}),
	signal_type: AlertSignalType,
	comparator: AlertComparator,
	threshold: Schema.Number,
	threshold_upper: Schema.NullOr(Schema.Number),
	observed_value: Schema.NullOr(Schema.Number),
	sample_count: Schema.Number,
	window_minutes: Schema.Number,
	window_start: Timestamp,
	window_end: Timestamp,
	consecutive_breaches: Schema.Number,
	consecutive_healthy: Schema.Number,
	incident_id: Schema.NullOr(AlertIncidentPublicId).annotate({
		description: "The incident (`inc_…`) this check opened or continued, or `null`.",
	}),
	incident_transition: AlertIncidentTransition.annotate({
		description:
			"How this check moved the incident state machine: `none`, `opened`, `continued`, or `resolved`.",
		examples: ["opened"],
	}),
	evaluation_duration_ms: Schema.Number,
	error_message: Schema.NullOr(Schema.String).annotate({
		description: "Why the evaluation failed — populated only on `error` checks.",
	}),
	error_category: Schema.NullOr(Schema.String).annotate({
		description: 'Failure category (e.g. `"validation"`) — populated only on `error` checks.',
	}),
}).annotate({
	identifier: "AlertCheck",
	title: "Alert Check",
	description:
		"One recorded evaluation of an alert rule: the observed value, the verdict, and how it moved the incident state machine. Checks form the rule's audit trail.",
	examples: [
		wireExample({
			object: "alert_check",
			timestamp: "2026-07-15T09:10:00.000Z",
			group_key: "__total__",
			status: "breached",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05,
			threshold_upper: null,
			observed_value: 0.09,
			sample_count: 132,
			window_minutes: 5,
			window_start: "2026-07-15T09:05:00.000Z",
			window_end: "2026-07-15T09:10:00.000Z",
			consecutive_breaches: 2,
			consecutive_healthy: 0,
			incident_id: "inc_tC4d9V79DCDzgbGKhAnff9",
			incident_transition: "opened",
			evaluation_duration_ms: 412,
			error_message: null,
			error_category: null,
		}),
	],
})
export type V2AlertCheck = Schema.Schema.Type<typeof V2AlertCheck>

const ChecksQuery = Schema.Struct({
	...ListQuery.fields,
	group_key: Schema.optional(
		Schema.String.annotate({
			description: "Only return checks for this group key.",
			examples: ["__total__"],
		}),
	),
	since: Schema.optional(
		Timestamp.annotate({
			description: "Only return checks recorded at or after this time (ISO-8601 UTC).",
		}),
	),
	until: Schema.optional(
		Timestamp.annotate({
			description: "Only return checks recorded before this time (ISO-8601 UTC).",
		}),
	),
}).annotate({
	identifier: "AlertCheckListQuery",
	title: "Alert check list query",
	description: "Pagination plus optional group/time filters for a rule's check history.",
})

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError, V2UpstreamError] as const

const AlertRuleList = ListOf(V2AlertRule).annotate({
	identifier: "AlertRuleList",
	title: "Alert rule list",
	description: "A cursor-paginated page of alert rules.",
})

const AlertCheckList = ListOf(V2AlertCheck).annotate({
	identifier: "AlertCheckList",
	title: "Alert check list",
	description: "A cursor-paginated page of alert checks, newest first.",
})

export class V2AlertRulesApiGroup extends HttpApiGroup.make("alertRules")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: AlertRuleList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertRules",
				summary: "List alert rules",
				description:
					"Returns your organization's alert rules, most recently created first. Cursor-paginated. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AlertRuleCreateParams,
			success: V2AlertRuleMutationResponse,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAlertRule",
				summary: "Create an alert rule",
				description:
					"Creates an alert rule. Referenced `destination_ids` must exist. Requires an org-admin role and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertRulePublicId },
			success: V2AlertRule,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertRule",
				summary: "Retrieve an alert rule",
				description:
					"Returns a single alert rule by its `alrt_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AlertRulePublicId },
			payload: V2AlertRuleUpdateParams,
			success: V2AlertRuleMutationResponse,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAlertRule",
				summary: "Update an alert rule",
				description:
					'Updates an alert rule. Omitted fields are left unchanged — `{"enabled": false}` pauses a rule without touching its condition. Requires an org-admin role and the `alerts:write` scope.',
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: AlertRulePublicId },
			success: V2AlertRuleDeleteResponse,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteAlertRule",
				summary: "Delete an alert rule",
				description:
					"Permanently deletes an alert rule and its incident history linkage. Requires an org-admin role and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("test", "/test", {
			payload: V2AlertRuleTestParams,
			success: V2AlertRuleTestResult,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "testAlertRule",
				summary: "Test an alert rule",
				description:
					"Evaluates a rule definition once against live data without saving it, optionally delivering a test notification. Requires an org-admin role and the `alerts:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("preview", "/preview", {
			payload: V2AlertRulePreviewParams,
			success: V2AlertRulePreviewResult,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "previewAlertRule",
				summary: "Preview an alert rule",
				description:
					"Replays a rule definition over a historical range and returns the per-window observations and would-have-fired spans. Read-only (sends nothing). Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("checks", "/:id/checks", {
			params: { id: AlertRulePublicId },
			query: ChecksQuery,
			success: AlertCheckList,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertRuleChecks",
				summary: "List a rule's checks",
				description:
					"Returns the rule's recorded evaluations (its audit trail), newest first, optionally filtered by group key and time range. Requires the `alerts:read` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/rules")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Rules",
			description:
				"Monitors over your telemetry: error rate, latency percentiles, Apdex, throughput, metrics, query-builder queries, and raw SQL. Rules evaluate on a rolling window, open incidents after consecutive breaches, and notify their alert destinations. Mutations are admin-only.",
		}),
	) {}
