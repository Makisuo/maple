import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core"
import type {
	AlertDeliveryEventId,
	AlertDestinationId,
	AlertIncidentId,
	AlertRuleId,
	ErrorIssueId,
	OrgId,
} from "@maple/domain/primitives"

export const alertDestinations = pgTable(
	"alert_destinations",
	{
		id: text("id").$type<AlertDestinationId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		name: text("name").notNull(),
		type: text("type").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		configJson: jsonb("config_json").$type<unknown>().notNull(),
		secretCiphertext: text("secret_ciphertext").notNull(),
		secretIv: text("secret_iv").notNull(),
		secretTag: text("secret_tag").notNull(),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true, mode: "date" }),
		lastTestError: text("last_test_error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		index("alert_destinations_org_idx").on(table.orgId),
		index("alert_destinations_org_enabled_idx").on(table.orgId, table.enabled),
		uniqueIndex("alert_destinations_org_name_idx").on(table.orgId, table.name),
	],
)

export const alertRules = pgTable(
	"alert_rules",
	{
		id: text("id").$type<AlertRuleId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		name: text("name").notNull(),
		notes: text("notes"),
		notificationTemplateJson: jsonb("notification_template_json").$type<unknown>(),
		enabled: boolean("enabled").notNull().default(true),
		severity: text("severity").notNull(),
		serviceNamesJson: jsonb("service_names_json").$type<ReadonlyArray<string>>(),
		excludeServiceNamesJson: jsonb("exclude_service_names_json").$type<ReadonlyArray<string>>(),
		/**
		 * Deployment environments the rule is scoped to. Null/empty means every
		 * environment. Applies to the built-in trace signals;
		 * `builder_query` / `raw_query` carry their own
		 * filters, so it is always empty for those.
		 */
		environmentsJson: jsonb("environments_json").$type<ReadonlyArray<string>>(),
		/** JSON-encoded `string[]` of free-form tags used to group and filter rules. */
		tagsJson: jsonb("tags_json").$type<ReadonlyArray<string>>(),
		signalType: text("signal_type").notNull(),
		comparator: text("comparator").notNull(),
		threshold: doublePrecision("threshold").notNull(),
		thresholdUpper: doublePrecision("threshold_upper"),
		windowMinutes: integer("window_minutes").notNull(),
		minimumSampleCount: integer("minimum_sample_count").notNull().default(0),
		consecutiveBreachesRequired: integer("consecutive_breaches_required").notNull().default(2),
		consecutiveHealthyRequired: integer("consecutive_healthy_required").notNull().default(2),
		renotifyIntervalMinutes: integer("renotify_interval_minutes").notNull().default(30),
		apdexThresholdMs: doublePrecision("apdex_threshold_ms"),
		queryBuilderDraftJson: jsonb("query_builder_draft_json").$type<unknown>(),
		rawQuerySql: text("raw_query_sql"),
		groupBy: text("group_by"),
		destinationIdsJson: jsonb("destination_ids_json").$type<ReadonlyArray<string>>().notNull(),
		querySpecJson: jsonb("query_spec_json").$type<unknown>(),
		reducer: text("reducer").notNull(),
		sampleCountStrategy: text("sample_count_strategy"),
		noDataBehavior: text("no_data_behavior").notNull(),
		lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
		createdBy: text("created_by").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(table) => [
		index("alert_rules_org_idx").on(table.orgId),
		index("alert_rules_org_enabled_idx").on(table.orgId, table.enabled),
		uniqueIndex("alert_rules_org_name_idx").on(table.orgId, table.name),
	],
)

export const alertRuleStates = pgTable(
	"alert_rule_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		ruleId: text("rule_id").$type<AlertRuleId>().notNull(),
		groupKey: text("group_key").notNull().default("__total__"),
		consecutiveBreaches: integer("consecutive_breaches").notNull().default(0),
		consecutiveHealthy: integer("consecutive_healthy").notNull().default(0),
		lastStatus: text("last_status"),
		lastValue: doublePrecision("last_value"),
		lastSampleCount: integer("last_sample_count"),
		lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "date" }),
		lastError: text("last_error"),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.ruleId, table.groupKey] }),
		index("alert_rule_states_org_idx").on(table.orgId),
	],
)

export const alertIncidents = pgTable(
	"alert_incidents",
	{
		id: text("id").$type<AlertIncidentId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		ruleId: text("rule_id").$type<AlertRuleId>().notNull(),
		incidentKey: text("incident_key").notNull(),
		ruleName: text("rule_name").notNull(),
		groupKey: text("group_key"),
		signalType: text("signal_type").notNull(),
		severity: text("severity").notNull(),
		status: text("status").notNull(),
		comparator: text("comparator").notNull(),
		threshold: doublePrecision("threshold").notNull(),
		thresholdUpper: doublePrecision("threshold_upper"),
		firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
		lastObservedValue: doublePrecision("last_observed_value"),
		lastSampleCount: integer("last_sample_count"),
		lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "date" }),
		dedupeKey: text("dedupe_key").notNull(),
		lastDeliveredEventType: text("last_delivered_event_type"),
		lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true, mode: "date" }),
		// Issue-hub link: the error_issues row (kind="alert") this incident
		// feeds, mirroring anomalyIncidents.errorIssueId.
		errorIssueId: text("error_issue_id").$type<ErrorIssueId>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("alert_incidents_org_idx").on(table.orgId),
		index("alert_incidents_org_status_idx").on(table.orgId, table.status),
		index("alert_incidents_org_rule_idx").on(table.orgId, table.ruleId),
		index("alert_incidents_org_issue_idx").on(table.orgId, table.errorIssueId),
		uniqueIndex("alert_incidents_incident_key_idx").on(table.incidentKey),
	],
)

export const alertDeliveryEvents = pgTable(
	"alert_delivery_events",
	{
		id: text("id").$type<AlertDeliveryEventId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		incidentId: text("incident_id").$type<AlertIncidentId>(),
		ruleId: text("rule_id").$type<AlertRuleId>().notNull(),
		destinationId: text("destination_id").$type<AlertDestinationId>().notNull(),
		deliveryKey: text("delivery_key").notNull(),
		eventType: text("event_type").notNull(),
		attemptNumber: integer("attempt_number").notNull(),
		status: text("status").notNull(),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }).notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
		claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }),
		claimedBy: text("claimed_by"),
		attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "date" }),
		providerMessage: text("provider_message"),
		providerReference: text("provider_reference"),
		responseCode: integer("response_code"),
		errorMessage: text("error_message"),
		payloadJson: jsonb("payload_json").$type<unknown>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("alert_delivery_events_org_idx").on(table.orgId),
		index("alert_delivery_events_org_incident_idx").on(table.orgId, table.incidentId),
		index("alert_delivery_events_due_idx").on(table.status, table.scheduledAt),
		index("alert_delivery_events_claim_idx").on(table.status, table.claimExpiresAt, table.scheduledAt),
		uniqueIndex("alert_delivery_events_delivery_attempt_idx").on(table.deliveryKey, table.attemptNumber),
	],
)

export type AlertDestinationRow = typeof alertDestinations.$inferSelect
export type AlertRuleRow = typeof alertRules.$inferSelect
export type AlertRuleStateRow = typeof alertRuleStates.$inferSelect
export type AlertIncidentRow = typeof alertIncidents.$inferSelect
export type AlertDeliveryEventRow = typeof alertDeliveryEvents.$inferSelect
