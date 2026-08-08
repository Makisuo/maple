import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import type { ErrorIssueId, InvestigationId, OrgId, UserId } from "@maple/domain/primitives"
import type {
	AiTriageEvidence,
	AiTriageIncidentKind,
	AiTriageResult,
	InvestigationConfidence,
	InvestigationFanoutState,
	InvestigationSeededBy,
	InvestigationStatus,
	InvestigationHypothesis,
	InvestigationPlan,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	LensId,
	LensRunStatus,
	LensVerdict,
} from "@maple/domain/http"
import type { IssueSeverity } from "@maple/domain/http"

/**
 * A durable investigation "war-room". One row per investigation; it both backs
 * the `/investigations` surface AND keys the `maple-chat` durable session
 * (`<orgId>:inv-<id>`) whose first turn is the autonomous diagnostic pass.
 *
 * A typed-incident investigation mirrors its incident into the nullable
 * `incidentKind`/`incidentId` columns to keep the
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
		/**
		 * Where the fan-out is. `none` is the single-pass path — either the routing
		 * gate declined or the org flag is off — and is what every row predating the
		 * fan-out backfills to, which is why this migration needs no data pass.
		 *
		 * The list query reads this to decide whether to join lens rows at all.
		 */
		fanoutState: text("fanout_state").$type<InvestigationFanoutState>().notNull().default("none"),
		/** Lenses dispatched. 1 on the single-pass path. */
		fanoutSize: integer("fanout_size").notNull().default(1),
		/**
		 * What the planner decided: the scope it established and the hypotheses it
		 * dispatched, verbatim. Stored rather than re-derived because the plan is
		 * the only record of what a run *chose not* to test, which is half of what
		 * makes its conclusion readable a week later.
		 */
		planJson: jsonb("plan_json").$type<InvestigationPlan>(),
		plannerModel: text("planner_model"),
		plannerElapsedMs: integer("planner_elapsed_ms"),
		validatorNote: text("validator_note"),
		validatorElapsedMs: integer("validator_elapsed_ms"),
		fanoutDeadlineAt: timestamp("fanout_deadline_at", { withTimezone: true, mode: "date" }),
		/** Cloudflare Workflow instance, for correlating a run with its engine trace. */
		workflowInstanceId: text("workflow_instance_id"),
		/** Bumped per restart so a retry can claim a fresh workflow instance id. */
		fanoutAttempt: integer("fanout_attempt").notNull().default(0),
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

/**
 * One row per dispatched hypothesis. This is the record the "Hypotheses
 * considered" table renders, and the reason it can be trusted: a rejected rival
 * carries the validator's own reason for rejecting it, written at ranking time.
 *
 * The `(investigation_id, attempt, lens_id)` unique index is the retry-safety
 * key. A Cloudflare Workflow step that is replayed after a lost result must
 * upsert its lane rather than insert a second one, or a retried run grows
 * duplicate lanes. It stays correct now that ids are planner-generated because
 * plan normalization guarantees they are unique inside one plan — that
 * invariant, not the closed literal union, is what this index was ever relying
 * on.
 */
export const investigationLensRuns = pgTable(
	"investigation_lens_runs",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		investigationId: text("investigation_id")
			.$type<InvestigationId>()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		lensId: text("lens_id").$type<LensId>().notNull(),
		/**
		 * Which restart produced this lane. Terminating the previous workflow
		 * instance is best-effort — an instance already past its guard keeps
		 * running — so without this a straggler from attempt N writes its claims and
		 * verdicts into attempt N+1's lanes and the board shows one run assembled
		 * from two.
		 */
		attempt: integer("attempt").notNull().default(0),
		/** Position in the dispatch order — the boards render lanes by this, not by id. */
		ordinal: integer("ordinal").notNull(),
		status: text("status").$type<LensRunStatus>().notNull().default("queued"),
		verdict: text("verdict").$type<LensVerdict>().notNull().default("pending"),
		/** The candidate cause; null while queued, or if the lens found nothing. */
		claim: text("claim"),
		/** Why the validator ruled as it did. Null until ranking. */
		reason: text("reason"),
		/** What the lens is doing right now, while `status` is `checking`. */
		progressNote: text("progress_note"),
		confidence: text("confidence").$type<InvestigationConfidence>(),
		toolCount: integer("tool_count").notNull().default(0),
		elapsedMs: integer("elapsed_ms"),
		/**
		 * Label and question, written by the planner for this incident. Null on rows
		 * from before the planner, where `lens_id` still names a static catalogue
		 * entry the web has copy for.
		 */
		lensName: text("lens_name"),
		lensQuestion: text("lens_question"),
		/** 1 = test first. Null on legacy rows, which were ordered by dispatch alone. */
		priority: integer("priority"),
		/**
		 * True when the lane answered because its clock ran out rather than because
		 * it was done. Read by the validator, which is told a cut-short lane's
		 * silence is not a negative result.
		 */
		deadlineHit: boolean("deadline_hit").notNull().default(false),
		/** The hypothesis this lane was dispatched to test, verbatim. */
		hypothesisJson: jsonb("hypothesis_json").$type<InvestigationHypothesis>(),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		model: text("model"),
		/**
		 * The lens's own citations. Persisted but deliberately withheld from the v2
		 * wire in v1 — nothing renders it, and putting five of these on every list
		 * response multiplies the trace-id decode surface for no gain.
		 */
		evidenceJson: jsonb("evidence_json").$type<ReadonlyArray<AiTriageEvidence>>(),
		/**
		 * How the claim would produce the symptoms — the causal chain. This is the
		 * validator's FIRST ranking rule, so dropping it (as an earlier revision did)
		 * silently degrades every ranking to claim-plus-evidence.
		 */
		mechanism: text("mechanism"),
		/** What would falsify the claim, per the lens. Read by the validator. */
		selfDoubt: text("self_doubt"),
		suggestedActionsJson: jsonb("suggested_actions_json").$type<ReadonlyArray<string>>(),
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		reportedAt: timestamp("reported_at", { withTimezone: true, mode: "date" }),
		rankedAt: timestamp("ranked_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("investigation_lens_runs_lens_idx").on(
			table.investigationId,
			table.attempt,
			table.lensId,
		),
		index("investigation_lens_runs_org_inv_idx").on(table.orgId, table.investigationId),
	],
)

export type InvestigationLensRunRow = typeof investigationLensRuns.$inferSelect
export type InvestigationLensRunInsert = typeof investigationLensRuns.$inferInsert
