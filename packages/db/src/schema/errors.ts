import { sql } from "drizzle-orm"
import {
	boolean,
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
	ActorId,
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
	UserId,
} from "@maple/domain/primitives"
import type {
	ActorType,
	AlertSeverity,
	ErrorIncidentReason,
	ErrorIncidentStatus,
	ErrorIssueEventType,
	IssueKind,
	IssueSeverity,
	IssueSeveritySource,
	WorkflowState,
} from "@maple/domain/http"

/**
 * Actors are the subjects of every mutation on the issue system: humans and
 * LLM agents alike. A human's actor row is lazily created the first time they
 * interact with an issue; agents are registered explicitly.
 */
export const actors = pgTable(
	"actors",
	{
		id: text("id").$type<ActorId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		type: text("type").$type<ActorType>().notNull(),
		userId: text("user_id").$type<UserId>(),
		agentName: text("agent_name"),
		model: text("model"),
		capabilitiesJson: jsonb("capabilities_json").$type<ReadonlyArray<string>>().notNull().default([]),
		createdBy: text("created_by").$type<UserId>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		uniqueIndex("actors_org_user_idx").on(table.orgId, table.userId),
		uniqueIndex("actors_org_agent_name_idx").on(table.orgId, table.agentName),
		index("actors_org_type_idx").on(table.orgId, table.type),
	],
)

/**
 * Persistent identity for an error group (one row per unique fingerprint).
 * Fingerprint = cityHash64(OrgId, ServiceName, ExceptionType, TopFrame),
 * computed in Tinybird error_events_mv and stored here as the decimal
 * UInt64 string (matches `toString(FingerprintHash)` in ClickHouse).
 */
export const errorIssues = pgTable(
	"error_issues",
	{
		id: text("id").$type<ErrorIssueId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		// "alert" issues reuse the error-shaped columns with title/detail
		// semantics: fingerprintHash = `alert:{ruleId}:{groupKey}` (real error
		// fingerprints are decimal UInt64 strings, so the prefix cannot collide),
		// exceptionType = rule name, exceptionMessage = human summary, topFrame = "".
		kind: text("kind").$type<IssueKind>().notNull().default("error"),
		sourceRefJson: jsonb("source_ref_json").$type<unknown>(),
		fingerprintHash: text("fingerprint_hash").notNull(),
		serviceName: text("service_name").notNull(),
		exceptionType: text("exception_type").notNull(),
		exceptionMessage: text("exception_message").notNull(),
		errorLabel: text("error_label").notNull().default(""),
		topFrame: text("top_frame").notNull(),
		workflowState: text("workflow_state").$type<WorkflowState>().notNull().default("triage"),
		priority: integer("priority").notNull().default(3),
		// null = untriaged. Write precedence: manual > ai > detector — see
		// IssueSeveritySource in @maple/domain/http.
		severity: text("severity").$type<IssueSeverity>(),
		severitySource: text("severity_source").$type<IssueSeveritySource>(),
		assignedActorId: text("assigned_actor_id").$type<ActorId>(),
		leaseHolderActorId: text("lease_holder_actor_id").$type<ActorId>(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
		claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
		notes: text("notes"),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
		occurrenceCount: integer("occurrence_count").notNull().default(0),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
		resolvedByActorId: text("resolved_by_actor_id").$type<ActorId>(),
		snoozeUntil: timestamp("snooze_until", { withTimezone: true, mode: "date" }),
		archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("error_issues_org_fp_idx").on(table.orgId, table.fingerprintHash),
		index("error_issues_org_workflow_idx").on(table.orgId, table.workflowState),
		index("error_issues_org_severity_idx").on(table.orgId, table.severity),
		index("error_issues_org_last_seen_idx").on(table.orgId, table.lastSeenAt),
		index("error_issues_org_assignee_idx").on(table.orgId, table.assignedActorId),
		index("error_issues_lease_expiry_idx").on(table.leaseExpiresAt),
		// The hourly archived-issue purge filters (org_id, archived_at IS NOT NULL,
		// archived_at < cutoff). With no index on archived_at the planner fell back
		// to error_issues_org_assignee_idx and heap-checked the org's whole
		// partition — 1,862 rows read per call to return zero, at a 31% buffer-cache
		// hit ratio, which was 35% of ALL database time. Partial, so the index holds
		// only the handful of archived rows.
		index("error_issues_org_archived_idx")
			.on(table.orgId, table.archivedAt)
			.where(sql`${table.archivedAt} is not null`),
	],
)

/**
 * Append-only audit trail of everything that happens to an issue: state
 * transitions, claims, releases, comments, agent reasoning notes, fix
 * proposals. Payload is a JSON blob whose shape depends on the event type.
 */
export const errorIssueEvents = pgTable(
	"error_issue_events",
	{
		id: text("id").$type<ErrorIssueEventId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		actorId: text("actor_id").$type<ActorId>(),
		type: text("type").$type<ErrorIssueEventType>().notNull(),
		fromState: text("from_state").$type<WorkflowState>(),
		toState: text("to_state").$type<WorkflowState>(),
		payloadJson: jsonb("payload_json").$type<unknown>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("error_issue_events_issue_idx").on(table.orgId, table.issueId, table.createdAt),
		index("error_issue_events_actor_idx").on(table.orgId, table.actorId, table.createdAt),
		index("error_issue_events_type_idx").on(table.orgId, table.type, table.createdAt),
	],
)

/**
 * Per-issue evaluator state used by the scheduled error tick to detect
 * regressions and auto-resolve quiet incidents.
 */
export const errorIssueStates = pgTable(
	"error_issue_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		lastObservedOccurrenceAt: timestamp("last_observed_occurrence_at", {
			withTimezone: true,
			mode: "date",
		}),
		lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "date" }),
		openIncidentId: text("open_incident_id").$type<ErrorIncidentId>(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	// No standalone org_id index: the primary key already leads with org_id, so
	// one was pure write amplification on a table taking ~63k updates a day.
	(table) => [primaryKey({ columns: [table.orgId, table.issueId] })],
)

/**
 * A time-bounded flare-up under an Issue. Opens on first-seen or regression
 * (activity after the Issue was resolved), auto-resolves after configurable
 * silence (default 30m).
 */
export const errorIncidents = pgTable(
	"error_incidents",
	{
		id: text("id").$type<ErrorIncidentId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		status: text("status").$type<ErrorIncidentStatus>().notNull(),
		reason: text("reason").$type<ErrorIncidentReason>().notNull(),
		firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true, mode: "date" }).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
		occurrenceCount: integer("occurrence_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("error_incidents_org_issue_idx").on(table.orgId, table.issueId),
		index("error_incidents_org_status_idx").on(table.orgId, table.status),
	],
)

/**
 * Per-org policy controlling which alert destinations receive error
 * notifications and under what conditions. Referenced by the scheduled
 * error tick when it opens or auto-resolves incidents.
 */
export const errorNotificationPolicies = pgTable("error_notification_policies", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: boolean("enabled").notNull().default(true),
	destinationIdsJson: jsonb("destination_ids_json").$type<ReadonlyArray<string>>().notNull().default([]),
	notifyOnFirstSeen: boolean("notify_on_first_seen").notNull().default(true),
	notifyOnRegression: boolean("notify_on_regression").notNull().default(true),
	notifyOnResolve: boolean("notify_on_resolve").notNull().default(false),
	notifyOnTransitionInReview: boolean("notify_on_transition_in_review").notNull().default(false),
	notifyOnTransitionDone: boolean("notify_on_transition_done").notNull().default(false),
	notifyOnClaim: boolean("notify_on_claim").notNull().default(false),
	minOccurrenceCount: integer("min_occurrence_count").notNull().default(1),
	severity: text("severity").$type<AlertSeverity>().notNull().default("warning"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedBy: text("updated_by").notNull(),
})

/**
 * Durable per-org checkpoint for the scheduled error evaluator.
 *
 * `processedThrough` is an exclusive minute boundary. A short lease prevents
 * overlapping cron invocations from evaluating the same window; the evaluator
 * advances the checkpoint in the same Postgres transaction as issue/incident
 * mutations.
 */
export const errorTickStates = pgTable(
	"error_tick_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
		processedThrough: timestamp("processed_through", { withTimezone: true, mode: "date" }).notNull(),
		bootstrapCompleted: boolean("bootstrap_completed").notNull().default(false),
		claimToken: text("claim_token"),
		claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [index("error_tick_states_claim_idx").on(table.claimExpiresAt)],
)

export type ErrorNotificationDeliveryStatus = "queued" | "processing" | "success" | "failed"

/**
 * Transactional outbox for error-incident notifications. One row represents
 * one logical delivery to one destination and is retried in place. The unique
 * key makes enqueue idempotent when a transaction is retried.
 */
export const errorNotificationDeliveries = pgTable(
	"error_notification_deliveries",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		destinationId: text("destination_id").$type<AlertDestinationId>().notNull(),
		deliveryKey: text("delivery_key").notNull(),
		payloadJson: jsonb("payload_json").$type<unknown>().notNull(),
		status: text("status").$type<ErrorNotificationDeliveryStatus>().notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }).notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
		claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }),
		claimedBy: text("claimed_by"),
		attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "date" }),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		index("error_notification_deliveries_due_idx").on(
			table.status,
			table.scheduledAt,
			table.claimExpiresAt,
		),
		index("error_notification_deliveries_org_idx").on(table.orgId),
		uniqueIndex("error_notification_deliveries_key_destination_idx").on(
			table.deliveryKey,
			table.destinationId,
		),
	],
)

export type ActorRow = typeof actors.$inferSelect
export type ActorInsert = typeof actors.$inferInsert
export type ErrorIssueRow = typeof errorIssues.$inferSelect
export type ErrorIssueStateRow = typeof errorIssueStates.$inferSelect
export type ErrorIssueEventRow = typeof errorIssueEvents.$inferSelect
export type ErrorIssueEventInsert = typeof errorIssueEvents.$inferInsert
export type ErrorIncidentRow = typeof errorIncidents.$inferSelect
export type ErrorNotificationPolicyRow = typeof errorNotificationPolicies.$inferSelect
export type ErrorTickStateRow = typeof errorTickStates.$inferSelect
export type ErrorNotificationDeliveryRow = typeof errorNotificationDeliveries.$inferSelect
