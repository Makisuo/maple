import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { ErrorIssueId, InvestigationId, IssueEscalationId, OrgId } from "@maple/domain/primitives"
import type { IssueSeverity } from "@maple/domain/http"

/**
 * Org-level escalation policy: which destinations a triage-outcome severity
 * routes to. Escalations fire only on AI-applied or manual severity changes —
 * never detector-initial severity (detection noise is already covered by alert
 * rule destinations and the error notification policy).
 */
export const issueEscalationPolicies = pgTable("issue_escalation_policies", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: boolean("enabled").notNull().default(false),
	// Array<{ severity: IssueSeverity; destinationIds: string[]; minConfidence?: "low"|"medium"|"high" }>
	rulesJson: jsonb("rules_json").$type<ReadonlyArray<unknown>>().notNull().default([]),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedBy: text("updated_by").notNull(),
})

export type IssueEscalationPolicyRow = typeof issueEscalationPolicies.$inferSelect

/**
 * Escalation outbox. Writers (the AI triage workflow's persist step, manual
 * severity changes) insert rows; the alerting worker's escalation tick drains
 * them through NotificationDispatcher. The unique dedupeKey
 * (`esc:{orgId}:{issueId}:{severity}`) makes escalation at-most-once per
 * issue+level, and upward-only semantics live in the writers.
 */
export const issueEscalations = pgTable(
	"issue_escalations",
	{
		id: text("id").$type<IssueEscalationId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>().notNull(),
		severity: text("severity").$type<IssueSeverity>().notNull(),
		source: text("source").$type<"ai" | "manual">().notNull(),
		reason: text("reason").$type<"severity_set" | "severity_escalated">().notNull(),
		runId: text("run_id"),
		investigationId: text("investigation_id").$type<InvestigationId>(),
		// Triage snapshot captured at enqueue (summary, suspectedCause, …) so the
		// dispatch payload survives later runs overwriting the run row.
		payloadJson: jsonb("payload_json").$type<unknown>().notNull().default({}),
		deliveryResultsJson: jsonb("delivery_results_json").$type<unknown>().notNull().default([]),
		status: text("status").$type<"queued" | "sent" | "skipped" | "failed">().notNull().default("queued"),
		attempts: integer("attempts").notNull().default(0),
		dedupeKey: text("dedupe_key").notNull(),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		uniqueIndex("issue_escalations_dedupe_idx").on(table.dedupeKey),
		index("issue_escalations_due_idx").on(table.status, table.createdAt),
		index("issue_escalations_org_issue_idx").on(table.orgId, table.issueId),
	],
)

export type IssueEscalationRow = typeof issueEscalations.$inferSelect
