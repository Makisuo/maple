import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { AiTriageRunId, ErrorIssueId, OrgId, UserId } from "@maple/domain/primitives"
import type { AiTriageIncidentKind, AiTriageRunStatus } from "@maple/domain/http"

/**
 * Per-org AI auto-triage policy. Disabled by default, so an admin must opt in.
 * Triage runs on Maple's managed AI (Cloudflare Workers AI via the api worker's
 * `AI` binding) — no per-org model or key configuration is needed.
 */
export const aiTriageSettings = pgTable("ai_triage_settings", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: boolean("enabled").notNull().default(false),
	maxRunsPerDay: integer("max_runs_per_day").notNull().default(20),
	/**
	 * @deprecated Dead. Nothing reads it, and nothing replaced it: how an
	 * investigation runs is not a setting. An incident is planned, a free-form
	 * question is one turn of a conversation, and neither is negotiable.
	 *
	 * The column survives this change only because dropping it here breaks the
	 * *previous* build mid-deploy — CI applies migrations before the new code
	 * ships, and the old `select()` on this table names it. Drop it in a follow-up
	 * migration once this build is out.
	 */
	fanoutEnabled: boolean("fanout_enabled").notNull().default(false),
	/**
	 * Daily budget in *model passes*, which is what actually costs money — a
	 * five-lens fan-out is six passes inside one run.
	 *
	 * Deliberately a second column rather than a reinterpretation of
	 * `maxRunsPerDay`: that one is org-configurable and user-visible, and silently
	 * changing its unit from runs to passes would turn a configured 20 into about
	 * three critical incidents a day with no warning and no failing test.
	 *
	 * Default raised from 60 with the planner: an incident spends planner + up to
	 * 4 hypotheses + validator ≈ 6 passes, so 60 was about ten incidents a day and
	 * 90 is about fifteen.
	 */
	maxPassesPerDay: integer("max_passes_per_day").notNull().default(90),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedBy: text("updated_by").$type<UserId>(),
})

/**
 * One AI triage investigation per incident (the unique index enforces it;
 * a re-run resets the existing row back to `queued` with a fresh workflow
 * instance). contextJson is written at enqueue time so the workflow needs no
 * kind-specific joins; resultJson holds the structured AiTriageResult.
 */
export const aiTriageRuns = pgTable(
	"ai_triage_runs",
	{
		id: text("id").$type<AiTriageRunId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		incidentKind: text("incident_kind").$type<AiTriageIncidentKind>().notNull(),
		incidentId: text("incident_id").notNull(),
		issueId: text("issue_id").$type<ErrorIssueId>(),
		status: text("status").$type<AiTriageRunStatus>().notNull().default("queued"),
		contextJson: jsonb("context_json").$type<unknown>().notNull().default({}),
		resultJson: jsonb("result_json").$type<unknown>(),
		model: text("model"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("ai_triage_runs_incident_idx").on(table.orgId, table.incidentKind, table.incidentId),
		index("ai_triage_runs_org_issue_idx").on(table.orgId, table.issueId),
		index("ai_triage_runs_org_created_idx").on(table.orgId, table.createdAt),
	],
)

export type AiTriageSettingsRow = typeof aiTriageSettings.$inferSelect
export type AiTriageRunRow = typeof aiTriageRuns.$inferSelect
export type AiTriageRunInsert = typeof aiTriageRuns.$inferInsert
