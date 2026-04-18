import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import type {
  ErrorIncidentId,
  ErrorIssueId,
  OrgId,
  UserId,
} from "@maple/domain/primitives"
import type {
  ErrorIncidentReason,
  ErrorIncidentStatus,
  ErrorIssueStatus,
} from "@maple/domain/http"

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
    status: text("status").$type<ErrorIssueStatus>().notNull(),
    assignedTo: text("assigned_to").$type<UserId>(),
    notes: text("notes"),
    firstSeenAt: integer("first_seen_at", { mode: "number" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "number" }).notNull(),
    occurrenceCount: integer("occurrence_count", { mode: "number" })
      .notNull()
      .default(0),
    resolvedAt: integer("resolved_at", { mode: "number" }),
    resolvedBy: text("resolved_by").$type<UserId>(),
    ignoredUntil: integer("ignored_until", { mode: "number" }),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("error_issues_org_fp_idx").on(
      table.orgId,
      table.fingerprintHash,
    ),
    index("error_issues_org_status_idx").on(table.orgId, table.status),
    index("error_issues_org_last_seen_idx").on(table.orgId, table.lastSeenAt),
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
    occurrenceCount: integer("occurrence_count", { mode: "number" })
      .notNull()
      .default(0),
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
export const errorNotificationPolicies = sqliteTable(
  "error_notification_policies",
  {
    orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
    enabled: integer("enabled", { mode: "number" }).notNull().default(1),
    destinationIdsJson: text("destination_ids_json").notNull().default("[]"),
    notifyOnFirstSeen: integer("notify_on_first_seen", { mode: "number" })
      .notNull()
      .default(1),
    notifyOnRegression: integer("notify_on_regression", { mode: "number" })
      .notNull()
      .default(1),
    notifyOnResolve: integer("notify_on_resolve", { mode: "number" })
      .notNull()
      .default(0),
    minOccurrenceCount: integer("min_occurrence_count", { mode: "number" })
      .notNull()
      .default(1),
    severity: text("severity").notNull().default("warning"),
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
)

export type ErrorIssueRow = typeof errorIssues.$inferSelect
export type ErrorIssueStateRow = typeof errorIssueStates.$inferSelect
export type ErrorIncidentRow = typeof errorIncidents.$inferSelect
export type ErrorNotificationPolicyRow = typeof errorNotificationPolicies.$inferSelect
