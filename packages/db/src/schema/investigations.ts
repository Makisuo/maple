import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import type { ErrorIssueId, InvestigationId, OrgId, UserId } from "@maple/domain/primitives"
import type {
	AiTriageIncidentKind,
	AiTriageResult,
	InvestigationConfidence,
	InvestigationSeededBy,
	InvestigationStatus,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
} from "@maple/domain/http"
import type { IssueSeverity } from "@maple/domain/http"

/**
 * A durable investigation "war-room". One row per investigation; it both backs
 * the `/investigations` surface AND keys the `maple-chat` durable session
 * (`<orgId>:inv-<id>`) whose first turn is the autonomous diagnostic pass.
 *
 * Supersedes `ai_triage_runs`: a typed-incident investigation mirrors its
 * incident into the nullable `incidentKind`/`incidentId` columns to keep the
 * one-investigation-per-incident dedup (the partial unique index below); a
 * free-form investigation leaves them null and is unconstrained. `reportJson`
 * holds the structured `AiTriageResult` written by `submit_diagnosis`.
 */
export const investigations = pgTable(
	"investigations",
	{
		id: text("id").$type<InvestigationId>().notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		status: text("status").$type<InvestigationStatus>().notNull().default("investigating"),
		seededBy: text("seeded_by").$type<InvestigationSeededBy>().notNull().default("user"),
		/** Full discriminated subject (incident ref or free-form question + context). */
		subjectJson: jsonb("subject_json").$type<InvestigationSubject>().notNull(),
		/** Display-ready context preserved independently of the source incident. */
		snapshotJson: jsonb("snapshot_json").$type<InvestigationSubjectSnapshot>(),
		/** Mirrored out of the subject ONLY to back the incident-dedup partial index. */
		incidentKind: text("incident_kind").$type<AiTriageIncidentKind>(),
		incidentId: text("incident_id"),
		issueId: text("issue_id").$type<ErrorIssueId>(),
		/** Structured diagnosis; null until the first `submit_diagnosis` lands. */
		reportJson: jsonb("report_json").$type<AiTriageResult>(),
		/** Denormalized from the report for cheap war-room list rendering. */
		severity: text("severity").$type<IssueSeverity>(),
		confidence: text("confidence").$type<InvestigationConfidence>(),
		model: text("model"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		autonomousTurns: integer("autonomous_turns").notNull().default(0),
		createdBy: text("created_by").$type<UserId>(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		diagnosedAt: timestamp("diagnosed_at", { withTimezone: true, mode: "date" }),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		// One investigation per incident. Partial so free-form investigations
		// (incident_id null) are not collapsed together.
		uniqueIndex("investigations_incident_idx")
			.on(table.orgId, table.incidentKind, table.incidentId)
			.where(sql`${table.incidentId} is not null`),
		index("investigations_org_created_idx").on(table.orgId, table.createdAt),
		index("investigations_org_issue_idx").on(table.orgId, table.issueId),
		index("investigations_org_status_idx").on(table.orgId, table.status),
	],
)

export type InvestigationRow = typeof investigations.$inferSelect
export type InvestigationInsert = typeof investigations.$inferInsert
