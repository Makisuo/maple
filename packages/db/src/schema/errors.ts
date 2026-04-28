import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type {
	ActorId,
	ErrorIncidentId,
	ErrorIssueEventId,
	ErrorIssueId,
	OrgId,
	UserId,
} from "@maple/domain/primitives"
import type {
	ActorType,
	ErrorIncidentReason,
	ErrorIncidentStatus,
	ErrorIssueEventType,
	WorkflowState,
} from "@maple/domain/http"

/**
 * Actors are the subjects of every mutation on the issue system: humans and
 * LLM agents alike. A human's actor row is lazily created the first time they
 * interact with an issue; agents are registered explicitly.
 */
export const actors = sqliteTable(
	"actors",
	{
		id: text("id").$type<ActorId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		type: text("type").$type<ActorType>().notNull(),
		userId: text("user_id").$type<UserId>(),
		agentName: text("agent_name"),
		model: text("model"),
		capabilitiesJson: text("capabilities_json").notNull().default("[]"),
		createdBy: text("created_by").$type<UserId>(),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		lastActiveAt: integer("last_active_at", { mode: "number" }),
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
export const errorIssues = sqliteTable(
	"error_issues",
	{
		id: text("id").$type<ErrorIssueId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		fingerprintHash: text("fingerprint_hash").notNull(),
		serviceName: text("service_name").notNull(),
		exceptionType: text("exception_type").notNull(),
		exceptionMessage: text("exception_message").notNull(),
		topFrame: text("top_frame").notNull(),
		workflowState: text("workflow_state").$type<WorkflowState>().notNull().default("triage"),
		priority: integer("priority", { mode: "number" }).notNull().default(3),
		assignedActorId: text("assigned_actor_id").$type<ActorId>(),
		leaseHolderActorId: text("lease_holder_actor_id").$type<ActorId>(),
		leaseExpiresAt: integer("lease_expires_at", { mode: "number" }),
		claimedAt: integer("claimed_at", { mode: "number" }),
		notes: text("notes"),
		firstSeenAt: integer("first_seen_at", { mode: "number" }).notNull(),
		lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull(),
		occurrenceCount: integer("occurrence_count", { mode: "number" }).notNull().default(0),
		resolvedAt: integer("resolved_at", { mode: "number" }),
		resolvedByActorId: text("resolved_by_actor_id").$type<ActorId>(),
		snoozeUntil: integer("snooze_until", { mode: "number" }),
		archivedAt: integer("archived_at", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("error_issues_org_fp_idx").on(table.orgId, table.fingerprintHash),
		index("error_issues_org_workflow_idx").on(table.orgId, table.workflowState),
		index("error_issues_org_last_seen_idx").on(table.orgId, table.lastSeenAt),
		index("error_issues_org_assignee_idx").on(table.orgId, table.assignedActorId),
		index("error_issues_lease_expiry_idx").on(table.leaseExpiresAt),
	],
)

/**
 * Append-only audit trail of everything that happens to an issue: state
 * transitions, claims, releases, comments, agent reasoning notes, fix
 * proposals. Payload is a JSON blob whose shape depends on the event type.
 */
export const errorIssueEvents = sqliteTable(
	"error_issue_events",
	{
		id: text("id").$type<ErrorIssueEventId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		actorId: text("actor_id").$type<ActorId>(),
		type: text("type").$type<ErrorIssueEventType>().notNull(),
		fromState: text("from_state").$type<WorkflowState>(),
		toState: text("to_state").$type<WorkflowState>(),
		payloadJson: text("payload_json").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
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
export const errorIssueStates = sqliteTable(
	"error_issue_states",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		lastObservedOccurrenceAt: integer("last_observed_occurrence_at", {
			mode: "number",
		}),
		lastEvaluatedAt: integer("last_evaluated_at", { mode: "number" }),
		openIncidentId: text("open_incident_id").$type<ErrorIncidentId>(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.issueId] }),
		index("error_issue_states_org_idx").on(table.orgId),
	],
)

/**
 * A time-bounded flare-up under an Issue. Opens on first-seen or regression
 * (activity after the Issue was resolved), auto-resolves after configurable
 * silence (default 30m).
 */
export const errorIncidents = sqliteTable(
	"error_incidents",
	{
		id: text("id").$type<ErrorIncidentId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		status: text("status").$type<ErrorIncidentStatus>().notNull(),
		reason: text("reason").$type<ErrorIncidentReason>().notNull(),
		firstTriggeredAt: integer("first_triggered_at", { mode: "number" }).notNull(),
		lastTriggeredAt: integer("last_triggered_at", { mode: "number" }).notNull(),
		resolvedAt: integer("resolved_at", { mode: "number" }),
		occurrenceCount: integer("occurrence_count", { mode: "number" }).notNull().default(0),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
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
export const errorNotificationPolicies = sqliteTable("error_notification_policies", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: integer("enabled", { mode: "number" }).notNull().default(1),
	destinationIdsJson: text("destination_ids_json").notNull().default("[]"),
	notifyOnFirstSeen: integer("notify_on_first_seen", { mode: "number" }).notNull().default(1),
	notifyOnRegression: integer("notify_on_regression", { mode: "number" }).notNull().default(1),
	notifyOnResolve: integer("notify_on_resolve", { mode: "number" }).notNull().default(0),
	notifyOnTransitionInReview: integer("notify_on_transition_in_review", {
		mode: "number",
	})
		.notNull()
		.default(0),
	notifyOnTransitionDone: integer("notify_on_transition_done", {
		mode: "number",
	})
		.notNull()
		.default(0),
	notifyOnClaim: integer("notify_on_claim", { mode: "number" }).notNull().default(0),
	minOccurrenceCount: integer("min_occurrence_count", { mode: "number" }).notNull().default(1),
	severity: text("severity").notNull().default("warning"),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	updatedBy: text("updated_by").notNull(),
})

export type ActorRow = typeof actors.$inferSelect
export type ActorInsert = typeof actors.$inferInsert
export type ErrorIssueRow = typeof errorIssues.$inferSelect
export type ErrorIssueStateRow = typeof errorIssueStates.$inferSelect
export type ErrorIssueEventRow = typeof errorIssueEvents.$inferSelect
export type ErrorIssueEventInsert = typeof errorIssueEvents.$inferInsert
export type ErrorIncidentRow = typeof errorIncidents.$inferSelect
export type ErrorNotificationPolicyRow = typeof errorNotificationPolicies.$inferSelect
