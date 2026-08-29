import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import type { ActorId, ApiKeyId, AuditLogEntryId, OrgId, UserId } from "@maple/domain/primitives"
import type { AuditActorType, AuditLogSource, AuditOutcome } from "@maple/domain/http"

/**
 * Append-only org-wide audit trail: every allowed or denied action an
 * identified actor performs against Maple, whether it arrived from the
 * dashboard, the public API, or MCP. `userId`/`apiKeyId`/`actorId` identify the
 * credential-holder per `actorType` — for `agent` rows `userId` is the human
 * the agent acted on behalf of. `actorLabel` freezes a display name at write
 * time so entries stay readable after keys are rolled or agents renamed.
 * Rows arrive through the audit events queue; `occurredAt` is stamped by the
 * producer, `recordedAt` by the consumer at insert.
 */
export const auditLogEntries = pgTable(
	"audit_log_entries",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		id: text("id").$type<AuditLogEntryId>().notNull(),
		actorType: text("actor_type").$type<AuditActorType>().notNull(),
		userId: text("user_id").$type<UserId>(),
		apiKeyId: text("api_key_id").$type<ApiKeyId>(),
		actorId: text("actor_id").$type<ActorId>(),
		actorLabel: text("actor_label"),
		affectedUserId: text("affected_user_id").$type<UserId>(),
		source: text("source").$type<AuditLogSource>().notNull(),
		action: text("action").notNull(),
		outcome: text("outcome").$type<AuditOutcome>().notNull(),
		denialReason: text("denial_reason"),
		resourceType: text("resource_type"),
		resourceId: text("resource_id"),
		// Field names touched by an update, queryable without parsing changesJson.
		changedFields: text("changed_fields").array(),
		changesJson: jsonb("changes_json").$type<unknown>(),
		metadataJson: jsonb("metadata_json").$type<unknown>(),
		requestId: text("request_id"),
		originIp: text("origin_ip"),
		originCountry: text("origin_country"),
		occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.id] }),
		index("audit_log_entries_org_occurred_idx").on(table.orgId, table.occurredAt),
		index("audit_log_entries_org_actor_type_occurred_idx").on(
			table.orgId,
			table.actorType,
			table.occurredAt,
		),
		index("audit_log_entries_org_resource_idx").on(table.orgId, table.resourceType, table.resourceId),
		index("audit_log_entries_org_request_idx").on(table.orgId, table.requestId),
		index("audit_log_entries_org_outcome_occurred_idx").on(
			table.orgId,
			table.outcome,
			table.occurredAt,
		),
		// Retention sweep scans `occurred_at < cutoff` across ALL orgs; every other
		// index leads with org_id and cannot serve that predicate.
		index("audit_log_entries_occurred_idx").on(table.occurredAt),
		// "What did this credential do" — the primary read-endpoint filters.
		index("audit_log_entries_org_user_occurred_idx").on(table.orgId, table.userId, table.occurredAt),
		index("audit_log_entries_org_api_key_occurred_idx").on(
			table.orgId,
			table.apiKeyId,
			table.occurredAt,
		),
		index("audit_log_entries_org_actor_occurred_idx").on(table.orgId, table.actorId, table.occurredAt),
		index("audit_log_entries_org_affected_user_occurred_idx").on(
			table.orgId,
			table.affectedUserId,
			table.occurredAt,
		),
		index("audit_log_entries_org_action_occurred_idx").on(table.orgId, table.action, table.occurredAt),
		// drizzle `arrayContains` compiles to `@>`, which only GIN can serve on text[].
		index("audit_log_entries_changed_fields_gin_idx").using("gin", table.changedFields),
	],
)

export type AuditLogEntryRow = typeof auditLogEntries.$inferSelect
export type AuditLogEntryInsert = typeof auditLogEntries.$inferInsert
