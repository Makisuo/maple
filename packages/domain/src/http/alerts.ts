import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { QueryEngineAlertReducer, QueryEngineNoDataBehavior } from "../query-engine"
import {
	AlertDeliveryEventId,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	ErrorIssueId,
	HazelChannelId,
	HazelOrganizationId,
	IsoDateTimeString,
	PostgresTransactionId,
	RoleName,
	UserId,
} from "../primitives"
import { Authorization } from "./current-tenant"
import { QueryBuilderQueryDraftSchema } from "./query-engine"
import { warehouseHttpErrors } from "./warehouse"

export const AlertDestinationType = Schema.Literals([
	"slack",
	"pagerduty",
	"webhook",
	"hazel",
	"hazel-oauth",
	"discord",
	"email",
]).annotate({
	identifier: "@maple/AlertDestinationType",
	title: "Alert Destination Type",
})
export type AlertDestinationType = Schema.Schema.Type<typeof AlertDestinationType>

export const AlertSeverity = Schema.Literals(["warning", "critical"]).annotate({
	identifier: "@maple/AlertSeverity",
	title: "Alert Severity",
})
export type AlertSeverity = Schema.Schema.Type<typeof AlertSeverity>

export const AlertSignalType = Schema.Literals([
	"error_rate",
	"p95_latency",
	"p99_latency",
	"apdex",
	"throughput",
	"metric",
	"builder_query",
	"raw_query",
]).annotate({
	identifier: "@maple/AlertSignalType",
	title: "Alert Signal Type",
})
export type AlertSignalType = Schema.Schema.Type<typeof AlertSignalType>

export const AlertGroupByDimension = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()).annotate({
	identifier: "@maple/AlertGroupByDimension",
	title: "Alert Group By Dimension",
})
export type AlertGroupByDimension = Schema.Schema.Type<typeof AlertGroupByDimension>

export const AlertGroupBy = Schema.Array(AlertGroupByDimension)
	.pipe(Schema.check(Schema.isMinLength(1)))
	.annotate({
		identifier: "@maple/AlertGroupBy",
		title: "Alert Group By",
	})
export type AlertGroupBy = Schema.Schema.Type<typeof AlertGroupBy>

export const AlertComparator = Schema.Literals([
	"gt",
	"gte",
	"lt",
	"lte",
	"eq",
	"neq",
	"between",
	"not_between",
]).annotate({
	identifier: "@maple/AlertComparator",
	title: "Alert Comparator",
})
export type AlertComparator = Schema.Schema.Type<typeof AlertComparator>

/**
 * Comparators that require a second threshold (`thresholdUpper`).
 * For these, the rule fires when the value falls inside / outside
 * `[threshold, thresholdUpper]`.
 */
export const isRangeComparator = (c: AlertComparator): c is "between" | "not_between" =>
	c === "between" || c === "not_between"

export const AlertMetricType = Schema.Literals([
	"sum",
	"gauge",
	"histogram",
	"exponential_histogram",
]).annotate({
	identifier: "@maple/AlertMetricType",
	title: "Alert Metric Type",
})
export type AlertMetricType = Schema.Schema.Type<typeof AlertMetricType>

export const AlertMetricAggregation = Schema.Literals(["avg", "min", "max", "sum", "count"]).annotate({
	identifier: "@maple/AlertMetricAggregation",
	title: "Alert Metric Aggregation",
})
export type AlertMetricAggregation = Schema.Schema.Type<typeof AlertMetricAggregation>

export const AlertIncidentStatus = Schema.Literals(["open", "resolved"]).annotate({
	identifier: "@maple/AlertIncidentStatus",
	title: "Alert Incident Status",
})
export type AlertIncidentStatus = Schema.Schema.Type<typeof AlertIncidentStatus>

export const AlertEventType = Schema.Literals(["trigger", "resolve", "renotify", "test"]).annotate({
	identifier: "@maple/AlertEventType",
	title: "Alert Event Type",
})
export type AlertEventType = Schema.Schema.Type<typeof AlertEventType>

export const AlertDeliveryStatus = Schema.Literals(["queued", "processing", "success", "failed"]).annotate({
	identifier: "@maple/AlertDeliveryStatus",
	title: "Alert Delivery Status",
})
export type AlertDeliveryStatus = Schema.Schema.Type<typeof AlertDeliveryStatus>

export const AlertEvaluationStatus = Schema.Literals(["breached", "healthy", "skipped"]).annotate({
	identifier: "@maple/AlertEvaluationStatus",
	title: "Alert Evaluation Status",
})
export type AlertEvaluationStatus = Schema.Schema.Type<typeof AlertEvaluationStatus>

/**
 * Status of a recorded check row in the audit trail. Superset of
 * {@link AlertEvaluationStatus}: `"error"` marks a scheduler tick whose query
 * failed outright — no observation was produced, only an error message.
 * Kept separate so the evaluation state machine stays a closed 3-state union.
 */
export const AlertCheckStatus = Schema.Literals(["breached", "healthy", "skipped", "error"]).annotate({
	identifier: "@maple/AlertCheckStatus",
	title: "Alert Check Status",
})
export type AlertCheckStatus = Schema.Schema.Type<typeof AlertCheckStatus>

const ChannelLabel = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed()))

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed()))

const OptionalNonEmptyString = Schema.optionalKey(
	Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
)

const PositiveInt = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0)))

const NonNegativeInt = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))

const PositiveFloat = Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isGreaterThan(0)))

export const MAX_ALERT_WINDOW_MINUTES = 24 * 60
export const AlertWindowMinutes = PositiveInt.pipe(
	Schema.check(Schema.isLessThanOrEqualTo(MAX_ALERT_WINDOW_MINUTES)),
)

export class SlackAlertDestinationConfig extends Schema.Class<SlackAlertDestinationConfig>(
	"SlackAlertDestinationConfig",
)({
	type: Schema.Literal("slack"),
	name: ChannelLabel,
	webhookUrl: NonEmptyString,
	channelLabel: OptionalNonEmptyString,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class PagerDutyAlertDestinationConfig extends Schema.Class<PagerDutyAlertDestinationConfig>(
	"PagerDutyAlertDestinationConfig",
)({
	type: Schema.Literal("pagerduty"),
	name: ChannelLabel,
	integrationKey: NonEmptyString,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class WebhookAlertDestinationConfig extends Schema.Class<WebhookAlertDestinationConfig>(
	"WebhookAlertDestinationConfig",
)({
	type: Schema.Literal("webhook"),
	name: ChannelLabel,
	url: NonEmptyString,
	signingSecret: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class HazelAlertDestinationConfig extends Schema.Class<HazelAlertDestinationConfig>(
	"HazelAlertDestinationConfig",
)({
	type: Schema.Literal("hazel"),
	name: ChannelLabel,
	webhookUrl: NonEmptyString,
	signingSecret: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class HazelOAuthAlertDestinationConfig extends Schema.Class<HazelOAuthAlertDestinationConfig>(
	"HazelOAuthAlertDestinationConfig",
)({
	type: Schema.Literal("hazel-oauth"),
	name: ChannelLabel,
	hazelOrganizationId: HazelOrganizationId,
	hazelOrganizationName: NonEmptyString,
	hazelOrganizationLogoUrl: Schema.optionalKey(Schema.NullOr(NonEmptyString)),
	hazelChannelId: HazelChannelId,
	hazelChannelName: NonEmptyString,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class DiscordAlertDestinationConfig extends Schema.Class<DiscordAlertDestinationConfig>(
	"DiscordAlertDestinationConfig",
)({
	type: Schema.Literal("discord"),
	name: ChannelLabel,
	webhookUrl: NonEmptyString,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export const MAX_EMAIL_RECIPIENTS = 10

/**
 * Recipients are workspace members, referenced by user id. The server resolves
 * each id to the member's email via the auth provider (Clerk) at save time, so
 * clients can never route alerts to arbitrary addresses.
 */
const MemberUserIdList = Schema.Array(NonEmptyString).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_EMAIL_RECIPIENTS),
)

export class EmailAlertDestinationConfig extends Schema.Class<EmailAlertDestinationConfig>(
	"EmailAlertDestinationConfig",
)({
	type: Schema.Literal("email"),
	name: ChannelLabel,
	memberUserIds: MemberUserIdList,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export const AlertDestinationCreateRequest = Schema.Union([
	SlackAlertDestinationConfig,
	PagerDutyAlertDestinationConfig,
	WebhookAlertDestinationConfig,
	HazelAlertDestinationConfig,
	HazelOAuthAlertDestinationConfig,
	DiscordAlertDestinationConfig,
	EmailAlertDestinationConfig,
])
export type AlertDestinationCreateRequest = Schema.Schema.Type<typeof AlertDestinationCreateRequest>

export class UpdateSlackAlertDestinationConfig extends Schema.Class<UpdateSlackAlertDestinationConfig>(
	"UpdateSlackAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	webhookUrl: Schema.optionalKey(Schema.String),
	channelLabel: OptionalNonEmptyString,
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdatePagerDutyAlertDestinationConfig extends Schema.Class<UpdatePagerDutyAlertDestinationConfig>(
	"UpdatePagerDutyAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	integrationKey: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateWebhookAlertDestinationConfig extends Schema.Class<UpdateWebhookAlertDestinationConfig>(
	"UpdateWebhookAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	url: Schema.optionalKey(Schema.String),
	signingSecret: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateHazelAlertDestinationConfig extends Schema.Class<UpdateHazelAlertDestinationConfig>(
	"UpdateHazelAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	webhookUrl: Schema.optionalKey(Schema.String),
	signingSecret: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateHazelOAuthAlertDestinationConfig extends Schema.Class<UpdateHazelOAuthAlertDestinationConfig>(
	"UpdateHazelOAuthAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	hazelOrganizationId: Schema.optionalKey(HazelOrganizationId),
	hazelOrganizationName: Schema.optionalKey(Schema.String),
	hazelOrganizationLogoUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
	hazelChannelId: Schema.optionalKey(HazelChannelId),
	hazelChannelName: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateDiscordAlertDestinationConfig extends Schema.Class<UpdateDiscordAlertDestinationConfig>(
	"UpdateDiscordAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	webhookUrl: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateEmailAlertDestinationConfig extends Schema.Class<UpdateEmailAlertDestinationConfig>(
	"UpdateEmailAlertDestinationConfig",
)({
	name: OptionalNonEmptyString,
	memberUserIds: Schema.optionalKey(MemberUserIdList),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export const AlertDestinationUpdateRequest = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("slack"),
		...UpdateSlackAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("pagerduty"),
		...UpdatePagerDutyAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("webhook"),
		...UpdateWebhookAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("hazel"),
		...UpdateHazelAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("hazel-oauth"),
		...UpdateHazelOAuthAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("discord"),
		...UpdateDiscordAlertDestinationConfig.fields,
	}),
	Schema.Struct({
		type: Schema.Literal("email"),
		...UpdateEmailAlertDestinationConfig.fields,
	}),
])
export type AlertDestinationUpdateRequest = Schema.Schema.Type<typeof AlertDestinationUpdateRequest>

export class AlertDestinationDocument extends Schema.Class<AlertDestinationDocument>(
	"AlertDestinationDocument",
)({
	id: AlertDestinationId,
	name: Schema.String,
	type: AlertDestinationType,
	enabled: Schema.Boolean,
	summary: Schema.String,
	channelLabel: Schema.NullOr(Schema.String),
	/** Selected workspace-member recipients (email destinations only). */
	memberUserIds: Schema.NullOr(Schema.Array(Schema.String)),
	lastTestedAt: Schema.NullOr(IsoDateTimeString),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	// Postgres txid of the write, present only on create/update responses so the
	// Electric alert_destinations collection can resolve optimistic state.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class AlertDestinationDeleteResponse extends Schema.Class<AlertDestinationDeleteResponse>(
	"AlertDestinationDeleteResponse",
)({
	id: AlertDestinationId,
	// Txid of the delete, for the Electric alert_destinations collection's onDelete.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class AlertDestinationsListResponse extends Schema.Class<AlertDestinationsListResponse>(
	"AlertDestinationsListResponse",
)({
	destinations: Schema.Array(AlertDestinationDocument),
}) {}

/**
 * A single template string (title or body). Capped to keep stored configs and
 * rendered notifications bounded. Markdown is allowed in `body`; channels render
 * it per their own dialect (Slack mrkdwn, Discord markdown, plain text).
 */
const TemplateString = Schema.String.check(Schema.isMaxLength(4_000))

/** A single rule tag. Free-form, bounded so the list/group UI stays legible. */
const TagString = Schema.String.check(Schema.isMaxLength(32))
/** The tags array on a rule — capped to keep grouping and filtering manageable. */
const RuleTags = Schema.Array(TagString).check(Schema.isMaxLength(20))

export const AlertNotificationTemplateOverride = Schema.Struct({
	title: Schema.optionalKey(Schema.NullOr(TemplateString)),
	body: Schema.optionalKey(Schema.NullOr(TemplateString)),
}).annotate({ identifier: "@maple/AlertNotificationTemplateOverride" })
export type AlertNotificationTemplateOverride = Schema.Schema.Type<typeof AlertNotificationTemplateOverride>

/**
 * User-customizable notification message. `title` + Markdown `body` use
 * `{{ variable }}` substitution over {@link ALERT_TEMPLATE_VARIABLES}. `overrides`
 * keyed by destination type let power users tailor a specific channel; unset
 * fields fall back override → top-level → built-in default. A `null` template
 * (or unset field) reproduces Maple's built-in notification format exactly.
 */
export const AlertNotificationTemplate = Schema.Struct({
	title: Schema.optionalKey(Schema.NullOr(TemplateString)),
	body: Schema.optionalKey(Schema.NullOr(TemplateString)),
	overrides: Schema.optionalKey(
		Schema.NullOr(Schema.Record(Schema.String, AlertNotificationTemplateOverride)),
	),
}).annotate({ identifier: "@maple/AlertNotificationTemplate" })
export type AlertNotificationTemplate = Schema.Schema.Type<typeof AlertNotificationTemplate>

/**
 * The variables available to notification templates. Every value is a
 * pre-formatted string (so templates never do arithmetic). Mirrors the fields
 * the built-in formatters surface. Surfaced in the rule editor as a reference.
 */
export const ALERT_TEMPLATE_VARIABLES: ReadonlyArray<{
	readonly key: string
	readonly description: string
}> = [
	{ key: "rule.name", description: "Alert rule name" },
	{ key: "rule.id", description: "Alert rule id" },
	{ key: "event.type", description: "trigger | resolve | renotify | test" },
	{ key: "event.label", description: 'Human label, e.g. "Triggered"' },
	{ key: "event.emoji", description: "Event emoji" },
	{ key: "severity", description: "warning | critical" },
	{ key: "signal", description: "Raw signal type" },
	{ key: "signal.label", description: 'Human signal label, e.g. "Error Rate"' },
	{ key: "comparator.label", description: 'Comparison operator, e.g. ">"' },
	{ key: "threshold", description: "Formatted threshold value" },
	{ key: "thresholdUpper", description: "Formatted upper threshold (range alerts)" },
	{ key: "value", description: "Formatted observed value" },
	{ key: "observed.summary", description: "Observed value + comparison" },
	{ key: "sampleCount", description: "Number of samples in the window" },
	{ key: "group", description: 'Group key, or "all"' },
	{ key: "window", description: 'Evaluation window, e.g. "5m"' },
	{ key: "incidentId", description: "Incident id (empty for tests)" },
	{ key: "incidentStatus", description: "open | resolved" },
	{ key: "links.app", description: "Deep link to the alert in Maple" },
	{ key: "links.chat", description: "Deep link to Maple AI for this alert" },
	{ key: "sentAt", description: "ISO timestamp the notification was sent" },
]

export class AlertRuleDocument extends Schema.Class<AlertRuleDocument>("AlertRuleDocument")({
	id: AlertRuleId,
	name: Schema.String,
	notes: Schema.NullOr(Schema.String),
	notificationTemplate: Schema.NullOr(AlertNotificationTemplate),
	enabled: Schema.Boolean,
	severity: AlertSeverity,
	serviceNames: Schema.Array(Schema.String),
	excludeServiceNames: Schema.Array(Schema.String),
	/** Free-form tags used to group and filter rules in the alerts list. */
	tags: Schema.Array(Schema.String),
	groupBy: Schema.NullOr(AlertGroupBy),
	signalType: AlertSignalType,
	comparator: AlertComparator,
	threshold: Schema.Number,
	thresholdUpper: Schema.NullOr(Schema.Number),
	windowMinutes: AlertWindowMinutes,
	minimumSampleCount: NonNegativeInt,
	consecutiveBreachesRequired: PositiveInt,
	consecutiveHealthyRequired: PositiveInt,
	renotifyIntervalMinutes: PositiveInt,
	metricName: Schema.NullOr(Schema.String),
	metricType: Schema.NullOr(AlertMetricType),
	metricAggregation: Schema.NullOr(AlertMetricAggregation),
	apdexThresholdMs: Schema.NullOr(PositiveFloat),
	queryBuilderDraft: Schema.NullOr(QueryBuilderQueryDraftSchema),
	rawQuerySql: Schema.NullOr(Schema.String),
	rawQueryReducer: Schema.NullOr(QueryEngineAlertReducer),
	destinationIds: Schema.Array(AlertDestinationId),
	/** What the evaluator does when the window has no data: skip the check or treat it as zero. */
	noDataBehavior: QueryEngineNoDataBehavior,
	/** Most recent evaluation error for this rule, surfaced from `alertRuleStates.lastError`. */
	lastEvaluationError: Schema.NullOr(Schema.String),
	lastEvaluatedAt: Schema.NullOr(IsoDateTimeString),
	/** Last time the scheduler picked this rule up for evaluation. */
	lastScheduledAt: Schema.NullOr(IsoDateTimeString),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	createdBy: UserId,
	updatedBy: UserId,
	// Postgres txid of the write, present only on create/update responses so the
	// web's ElectricSQL alert_rules collection can resolve optimistic state on the
	// exact synced transaction. Absent on list/read responses.
	txid: Schema.optionalKey(PostgresTransactionId),
}) {}

export class AlertRuleUpsertRequest extends Schema.Class<AlertRuleUpsertRequest>("AlertRuleUpsertRequest")({
	name: ChannelLabel,
	notes: Schema.optionalKey(Schema.NullOr(Schema.String)),
	notificationTemplate: Schema.optionalKey(Schema.NullOr(AlertNotificationTemplate)),
	enabled: Schema.optionalKey(Schema.Boolean),
	severity: AlertSeverity,
	serviceNames: Schema.optionalKey(Schema.Array(Schema.String)),
	excludeServiceNames: Schema.optionalKey(Schema.Array(Schema.String)),
	tags: Schema.optionalKey(RuleTags),
	groupBy: Schema.optionalKey(Schema.NullOr(AlertGroupBy)),
	signalType: AlertSignalType,
	comparator: AlertComparator,
	threshold: Schema.Number,
	thresholdUpper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	windowMinutes: AlertWindowMinutes,
	minimumSampleCount: Schema.optionalKey(NonNegativeInt),
	consecutiveBreachesRequired: Schema.optionalKey(PositiveInt),
	consecutiveHealthyRequired: Schema.optionalKey(PositiveInt),
	renotifyIntervalMinutes: Schema.optionalKey(PositiveInt),
	metricName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	metricType: Schema.optionalKey(Schema.NullOr(AlertMetricType)),
	metricAggregation: Schema.optionalKey(Schema.NullOr(AlertMetricAggregation)),
	apdexThresholdMs: Schema.optionalKey(Schema.NullOr(PositiveFloat)),
	queryBuilderDraft: Schema.optionalKey(Schema.NullOr(QueryBuilderQueryDraftSchema)),
	rawQuerySql: Schema.optionalKey(Schema.NullOr(Schema.String)),
	rawQueryReducer: Schema.optionalKey(Schema.NullOr(QueryEngineAlertReducer)),
	destinationIds: Schema.Array(AlertDestinationId),
}) {}

export class AlertRulesListResponse extends Schema.Class<AlertRulesListResponse>("AlertRulesListResponse")({
	rules: Schema.Array(AlertRuleDocument),
}) {}

export class AlertRuleDeleteResponse extends Schema.Class<AlertRuleDeleteResponse>("AlertRuleDeleteResponse")(
	{
		id: AlertRuleId,
		// Txid of the delete, for the Electric alert_rules collection's onDelete.
		txid: Schema.optionalKey(PostgresTransactionId),
	},
) {}

export class AlertRuleTestRequest extends Schema.Class<AlertRuleTestRequest>("AlertRuleTestRequest")({
	rule: AlertRuleUpsertRequest,
	sendNotification: Schema.optionalKey(Schema.Boolean),
}) {}

export class AlertEvaluationResult extends Schema.Class<AlertEvaluationResult>("AlertEvaluationResult")({
	status: AlertEvaluationStatus,
	value: Schema.NullOr(Schema.Number),
	sampleCount: Schema.Number,
	threshold: Schema.Number,
	thresholdUpper: Schema.NullOr(Schema.Number),
	comparator: AlertComparator,
	reason: Schema.String,
}) {}

export class AlertRulePreviewRequest extends Schema.Class<AlertRulePreviewRequest>("AlertRulePreviewRequest")(
	{
		rule: AlertRuleUpsertRequest,
		startTime: IsoDateTimeString,
		endTime: IsoDateTimeString,
	},
) {}

/**
 * One evaluator-faithful data point: what the scheduler would have observed for
 * this group in the window ending at `bucket`, and the verdict
 * `applyEvaluationLogic` would have produced (before consecutive-breach counting).
 */
export class AlertRulePreviewPoint extends Schema.Class<AlertRulePreviewPoint>("AlertRulePreviewPoint")({
	bucket: IsoDateTimeString,
	value: Schema.NullOr(Schema.Number),
	sampleCount: Schema.Number,
	status: AlertEvaluationStatus,
	/**
	 * The trailing in-progress window: evaluated over less than a full
	 * `windowMinutes`, so its value may still move as data arrives.
	 */
	provisional: Schema.optionalKey(Schema.Boolean),
}) {}

export class AlertRulePreviewSeries extends Schema.Class<AlertRulePreviewSeries>("AlertRulePreviewSeries")({
	groupKey: Schema.String,
	points: Schema.Array(AlertRulePreviewPoint),
}) {}

/** A span during which the rule's state machine would have held an open incident. */
export class AlertRulePreviewFiringSpan extends Schema.Class<AlertRulePreviewFiringSpan>(
	"AlertRulePreviewFiringSpan",
)({
	groupKey: Schema.String,
	start: IsoDateTimeString,
	end: IsoDateTimeString,
}) {}

/**
 * Evaluator-faithful preview of an alert rule over a time range: the exact
 * per-window observations the scheduler computes (tumbling `windowMinutes`
 * buckets — the live scheduler slides every tick, so `wouldFire` spans are an
 * approximation between bucket boundaries).
 */
export class AlertRulePreviewResponse extends Schema.Class<AlertRulePreviewResponse>(
	"AlertRulePreviewResponse",
)({
	bucketSeconds: Schema.Number,
	windowMinutes: Schema.Number,
	threshold: Schema.Number,
	thresholdUpper: Schema.NullOr(Schema.Number),
	comparator: AlertComparator,
	/** Set when the requested range was clamped to the preview bucket cap. */
	truncatedToStart: Schema.NullOr(IsoDateTimeString),
	series: Schema.Array(AlertRulePreviewSeries),
	wouldFire: Schema.Array(AlertRulePreviewFiringSpan),
}) {}

export class AlertIncidentDocument extends Schema.Class<AlertIncidentDocument>("AlertIncidentDocument")({
	id: AlertIncidentId,
	ruleId: AlertRuleId,
	ruleName: Schema.String,
	groupKey: Schema.NullOr(Schema.String),
	signalType: AlertSignalType,
	severity: AlertSeverity,
	status: AlertIncidentStatus,
	comparator: AlertComparator,
	threshold: Schema.Number,
	thresholdUpper: Schema.NullOr(Schema.Number),
	firstTriggeredAt: IsoDateTimeString,
	lastTriggeredAt: IsoDateTimeString,
	resolvedAt: Schema.NullOr(IsoDateTimeString),
	lastObservedValue: Schema.NullOr(Schema.Number),
	lastSampleCount: Schema.NullOr(Schema.Number),
	dedupeKey: Schema.String,
	lastDeliveredEventType: Schema.NullOr(AlertEventType),
	lastNotifiedAt: Schema.NullOr(IsoDateTimeString),
	errorIssueId: Schema.NullOr(ErrorIssueId),
}) {}

export class AlertIncidentsListResponse extends Schema.Class<AlertIncidentsListResponse>(
	"AlertIncidentsListResponse",
)({
	incidents: Schema.Array(AlertIncidentDocument),
}) {}

export class AlertDeliveryEventDocument extends Schema.Class<AlertDeliveryEventDocument>(
	"AlertDeliveryEventDocument",
)({
	id: AlertDeliveryEventId,
	incidentId: Schema.NullOr(AlertIncidentId),
	ruleId: AlertRuleId,
	destinationId: AlertDestinationId,
	destinationName: Schema.String,
	destinationType: AlertDestinationType,
	deliveryKey: Schema.String,
	eventType: AlertEventType,
	attemptNumber: PositiveInt,
	status: AlertDeliveryStatus,
	scheduledAt: IsoDateTimeString,
	attemptedAt: Schema.NullOr(IsoDateTimeString),
	providerMessage: Schema.NullOr(Schema.String),
	providerReference: Schema.NullOr(Schema.String),
	responseCode: Schema.NullOr(Schema.Number),
	errorMessage: Schema.NullOr(Schema.String),
}) {}

export class AlertDeliveryEventsListResponse extends Schema.Class<AlertDeliveryEventsListResponse>(
	"AlertDeliveryEventsListResponse",
)({
	events: Schema.Array(AlertDeliveryEventDocument),
}) {}

export class AlertDestinationTestResponse extends Schema.Class<AlertDestinationTestResponse>(
	"AlertDestinationTestResponse",
)({
	success: Schema.Boolean,
	message: Schema.String,
}) {}

export class AlertForbiddenError extends Schema.TaggedErrorClass<AlertForbiddenError>()(
	"@maple/http/errors/AlertForbiddenError",
	{
		message: Schema.String,
		roles: Schema.optionalKey(Schema.Array(RoleName)),
	},
	{ httpApiStatus: 403 },
) {}

export class AlertValidationError extends Schema.TaggedErrorClass<AlertValidationError>()(
	"@maple/http/errors/AlertValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{ httpApiStatus: 400 },
) {}

export class AlertPersistenceError extends Schema.TaggedErrorClass<AlertPersistenceError>()(
	"@maple/http/errors/AlertPersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.String),
	},
	{ httpApiStatus: 503 },
) {}

export class AlertNotFoundError extends Schema.TaggedErrorClass<AlertNotFoundError>()(
	"@maple/http/errors/AlertNotFoundError",
	{
		message: Schema.String,
		resourceType: Schema.String,
		resourceId: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class AlertDeliveryError extends Schema.TaggedErrorClass<AlertDeliveryError>()(
	"@maple/http/errors/AlertDeliveryError",
	{
		message: Schema.String,
		destinationType: Schema.optionalKey(AlertDestinationType),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{ httpApiStatus: 502 },
) {}

export class AlertDestinationInUseError extends Schema.TaggedErrorClass<AlertDestinationInUseError>()(
	"@maple/http/errors/AlertDestinationInUseError",
	{
		message: Schema.String,
		destinationId: AlertDestinationId,
		ruleIds: Schema.Array(AlertRuleId),
		ruleNames: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 409 },
) {}

export const AlertIncidentTransition = Schema.Literals(["none", "opened", "continued", "resolved"]).annotate({
	identifier: "@maple/AlertIncidentTransition",
	title: "Alert Incident Transition",
})
export type AlertIncidentTransition = Schema.Schema.Type<typeof AlertIncidentTransition>

export class AlertCheckDocument extends Schema.Class<AlertCheckDocument>("AlertCheckDocument")({
	timestamp: IsoDateTimeString,
	groupKey: Schema.String,
	status: AlertCheckStatus,
	signalType: AlertSignalType,
	comparator: AlertComparator,
	threshold: Schema.Number,
	thresholdUpper: Schema.NullOr(Schema.Number),
	observedValue: Schema.NullOr(Schema.Number),
	sampleCount: Schema.Number,
	windowMinutes: Schema.Number,
	windowStart: IsoDateTimeString,
	windowEnd: IsoDateTimeString,
	consecutiveBreaches: Schema.Number,
	consecutiveHealthy: Schema.Number,
	incidentId: Schema.NullOr(AlertIncidentId),
	incidentTransition: AlertIncidentTransition,
	evaluationDurationMs: Schema.Number,
	/** Populated on `status: "error"` rows — why the evaluation failed. */
	errorMessage: Schema.NullOr(Schema.String),
	/** Failure category (e.g. "validation", "tinybird_quota") on `status: "error"` rows. */
	errorCategory: Schema.NullOr(Schema.String),
}) {}

export class AlertChecksListResponse extends Schema.Class<AlertChecksListResponse>("AlertChecksListResponse")(
	{
		checks: Schema.Array(AlertCheckDocument),
	},
) {}

export const ListRuleChecksQuery = Schema.Struct({
	groupKey: Schema.optionalKey(Schema.String),
	since: Schema.optionalKey(IsoDateTimeString),
	until: Schema.optionalKey(IsoDateTimeString),
	limit: Schema.optionalKey(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2000 })),
	),
})

export class AlertsApiGroup extends HttpApiGroup.make("alerts")
	.add(
		HttpApiEndpoint.get("listDestinations", "/destinations", {
			success: AlertDestinationsListResponse,
			error: AlertPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("createDestination", "/destinations", {
			payload: AlertDestinationCreateRequest,
			success: AlertDestinationDocument,
			error: [AlertForbiddenError, AlertValidationError, AlertPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateDestination", "/destinations/:destinationId", {
			params: {
				destinationId: AlertDestinationId,
			},
			payload: AlertDestinationUpdateRequest,
			success: AlertDestinationDocument,
			error: [AlertForbiddenError, AlertValidationError, AlertPersistenceError, AlertNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteDestination", "/destinations/:destinationId", {
			params: {
				destinationId: AlertDestinationId,
			},
			success: AlertDestinationDeleteResponse,
			error: [
				AlertForbiddenError,
				AlertPersistenceError,
				AlertNotFoundError,
				AlertDestinationInUseError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("testDestination", "/destinations/:destinationId/test", {
			params: {
				destinationId: AlertDestinationId,
			},
			success: AlertDestinationTestResponse,
			error: [
				AlertForbiddenError,
				AlertValidationError,
				AlertPersistenceError,
				AlertNotFoundError,
				AlertDeliveryError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listRules", "/rules", {
			success: AlertRulesListResponse,
			error: AlertPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("createRule", "/rules", {
			payload: AlertRuleUpsertRequest,
			success: AlertRuleDocument,
			error: [AlertForbiddenError, AlertValidationError, AlertPersistenceError, AlertNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateRule", "/rules/:ruleId", {
			params: {
				ruleId: AlertRuleId,
			},
			payload: AlertRuleUpsertRequest,
			success: AlertRuleDocument,
			error: [AlertForbiddenError, AlertValidationError, AlertPersistenceError, AlertNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteRule", "/rules/:ruleId", {
			params: {
				ruleId: AlertRuleId,
			},
			success: AlertRuleDeleteResponse,
			error: [AlertForbiddenError, AlertPersistenceError, AlertNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.post("testRule", "/rules/test", {
			payload: AlertRuleTestRequest,
			success: AlertEvaluationResult,
			error: [
				AlertForbiddenError,
				AlertValidationError,
				AlertPersistenceError,
				AlertNotFoundError,
				AlertDeliveryError,
				...warehouseHttpErrors,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("previewRule", "/rules/preview", {
			payload: AlertRulePreviewRequest,
			success: AlertRulePreviewResponse,
			// No AlertForbiddenError: preview is read-only (unlike testRule, which can
			// send notifications), so it is not admin-gated.
			error: [
				AlertValidationError,
				AlertPersistenceError,
				AlertNotFoundError,
				AlertDeliveryError,
				...warehouseHttpErrors,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listIncidents", "/incidents", {
			success: AlertIncidentsListResponse,
			error: AlertPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listRuleChecks", "/rules/:ruleId/checks", {
			params: {
				ruleId: AlertRuleId,
			},
			query: ListRuleChecksQuery,
			success: AlertChecksListResponse,
			error: [AlertPersistenceError, AlertNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listDeliveryEvents", "/delivery-events", {
			success: AlertDeliveryEventsListResponse,
			error: AlertPersistenceError,
		}),
	)
	.prefix("/api/alerts")
	.middleware(Authorization) {}
