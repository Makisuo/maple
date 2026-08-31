/**
 * The writes that publish a diagnosis onto an investigation.
 *
 * Two callers reach this: `InvestigationService.submitDiagnosis` (the chat
 * agent's tool, on the single-pass path) and the fan-out workflow's `persist`
 * step (the validator's promoted cause). They must produce byte-identical
 * effects — the same status transition, the same severity application, the same
 * deterministically-keyed timeline event — or an investigation would mean
 * different things depending on which path produced it.
 *
 * Autumn metering deliberately stays with each caller: they reach the worker env
 * differently, and the token totals they have to report differ (one pass versus
 * a summed fan-out).
 */
import { errorIssueEvents, investigations } from "@maple/db"
import type { MaplePgClient } from "@maple/db/client"
import {
	InvestigationSubjectDiscriminator,
	type AiTriageResult,
	type InvestigationConfidence,
	type InvestigationSubjectType,
	type OrgId,
} from "@maple/domain/http"
import { ErrorIssueEventId, ErrorIssueId, type InvestigationId } from "@maple/domain/primitives"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Effect, identity, Option, Schema } from "effect"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { makeDbExecute } from "@/platform/db-execute"
import { applyTriageSeverity } from "@/services/errors/issue-severity"

const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)

/**
 * Deterministic UUIDv5-style id derived from the investigation id, so the
 * timeline-event insert is idempotent across re-diagnosis and across a retried
 * workflow step: the same investigation regenerates the SAME id and the primary
 * key (+ onConflictDoNothing) absorbs the duplicate.
 */
export const deterministicInvestigationEventId = (investigationId: string): string => {
	const hex = createHash("sha256").update(`investigation-event:${investigationId}`).digest("hex")
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`5${hex.slice(13, 16)}`,
		`${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-")
}

const decodeSubjectDiscriminator = Schema.decodeUnknownOption(InvestigationSubjectDiscriminator)

/**
 * The `type` discriminator off a stored `subjectJson`.
 *
 * Tolerant by design: callers pass a `jsonb` value straight from the row, and a
 * subject that fails to parse must not break the diagnosis write. `None` means
 * the caller cannot claim the run was a verification.
 *
 * Note which way that tolerance cuts. `None` is NOT the safe answer — it is the
 * answer that lets a verification run re-rank a human-triaged issue's severity
 * (see `subjectType` on {@link ApplyDiagnosisInput}). That is why this decodes
 * the discriminator alone rather than the whole `InvestigationSubject`: a
 * subject whose other fields have drifted, or that was written by an older
 * shape, must still be recognizable as the verification it plainly is.
 */
export const subjectTypeOf = (subjectJson: unknown): Option.Option<InvestigationSubjectType> =>
	decodeSubjectDiscriminator(subjectJson).pipe(Option.map((subject) => subject.type))

export interface ApplyDiagnosisInput {
	readonly orgId: OrgId
	readonly investigationId: InvestigationId
	readonly report: AiTriageResult
	/** Linked error issue, when the subject has one. Null skips the issue-side writes. */
	readonly issueId: string | null
	readonly model: string | null
	readonly inputTokens: number | null
	readonly outputTokens: number | null
	readonly nowMs: number
	/**
	 * The investigation's subject type, when the caller knows it.
	 *
	 * Only `"fix_verification"` changes anything, and it changes one thing: the
	 * issue-side severity write is skipped. A verification run answers "did the
	 * merged fix work", and its `severityAssessment` is an artifact of the report
	 * schema rather than a judgement about how bad the issue is — applying it
	 * would let a routine post-merge check silently re-rank an issue a human had
	 * already triaged. Those runs still link an `issueId` (the UI lists them on
	 * the issue), which is exactly why the null-issue guard below is not enough.
	 *
	 * The verdict itself is applied by the verification tick, which owns that
	 * lifecycle and can move the issue through the workflow state machine.
	 */
	readonly subjectType: Option.Option<InvestigationSubjectType>
	/**
	 * Fan-out bookkeeping written in the same statement as the report, so the row
	 * can never say `diagnosed` while still claiming the validator is running.
	 */
	readonly fanoutState?: "none" | "ranked" | "superseded"
	readonly validatorNote?: string | null
	readonly validatorElapsedMs?: number | null
}

/**
 * Flip the row to `diagnosed` with the report attached, then — if an issue is
 * linked — apply the severity and record the timeline event atomically. The
 * transaction matters: a crash between them would leave an issue escalated with
 * no audit event explaining why.
 */
const writeDiagnosis = async (db: MaplePgClient, input: ApplyDiagnosisInput): Promise<void> => {
	const confidence: InvestigationConfidence = input.report.confidence
	const now = new Date(input.nowMs)

	await db
		.update(investigations)
		.set({
			status: "diagnosed",
			reportJson: input.report,
			// Explicit null rather than `undefined`: an unassessed report must write
			// "no severity" onto the row, not silently omit the column from the UPDATE
			// and leave a stale one standing.
			severity: input.report.severityAssessment ?? null,
			confidence,
			model: input.model,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			error: null,
			diagnosedAt: now,
			updatedAt: now,
			...(!(input.fanoutState === undefined) ? { fanoutState: input.fanoutState } : undefined),
			...(!(input.validatorNote === undefined) ? { validatorNote: input.validatorNote } : undefined),
			...(!(input.validatorElapsedMs === undefined)
				? {
						validatorElapsedMs: input.validatorElapsedMs,
					}
				: undefined),
		})
		.where(and(eq(investigations.orgId, input.orgId), eq(investigations.id, input.investigationId)))

	if (!input.issueId) return
	// See `subjectType` above: a verification's report must not re-rank the issue.
	if (Option.contains(input.subjectType, "fix_verification")) return
	const decodedIssueId = decodeIssueId(input.issueId)
	await db.transaction(async (tx) => {
		const applied = await applyTriageSeverity(tx, {
			orgId: input.orgId,
			issueId: decodedIssueId,
			runId: input.investigationId,
			investigationId: input.investigationId,
			severity: input.report.severityAssessment,
			confidence,
			timestamp: input.nowMs,
			result: input.report,
		})
		await tx
			.insert(errorIssueEvents)
			.values({
				id: decodeEventId(deterministicInvestigationEventId(input.investigationId)),
				orgId: input.orgId,
				issueId: decodedIssueId,
				actorId: applied.actorId,
				type: "ai_triage",
				payloadJson: {
					investigationId: input.investigationId,
					summary: input.report.summary,
					severityAssessment: input.report.severityAssessment ?? null,
					confidence,
					applied: applied.applied,
				},
				createdAt: now,
			})
			.onConflictDoNothing()
	})
}

/**
 * Publish a diagnosis onto an investigation.
 *
 * Owns its database call rather than taking a client: the write is one logical
 * operation, so the retry, the span and the persistence-error mapping belong
 * with it instead of being re-supplied by every caller. `Database` reaches the
 * invocation's connection through `PgConnectionScope`, so callers that already
 * hold one (the request path, the fan-out workflow's per-run scope) keep using
 * exactly that connection.
 *
 * The body below stays a Promise callback because that is the shape
 * `Database.execute` takes — drizzle's `transaction` is a Promise API and there
 * is no Effect-native equivalent in this repo. Wrapping it here is what keeps
 * the seam at one place per logical call rather than at every call site.
 *
 * Fails with the raw `DatabaseError` rather than a domain persistence error:
 * this write straddles two domains (it updates `investigations` and, when an
 * issue is linked, the error-issue tables), and its two callers map to
 * different persistence errors. Mapping here would force one of them to
 * re-wrap. The contention retry still applies — that lives in `makeDbExecute`,
 * not in the mapping.
 */
export const applyDiagnosisWrites: (
	input: ApplyDiagnosisInput,
) => Effect.Effect<void, DatabaseError, Database> = Effect.fn("applyDiagnosisWrites")(function* (
	input,
) {
	const database = yield* Database
	yield* makeDbExecute(database, "applyDiagnosisWrites", identity)((db) => writeDiagnosis(db, input))
})

export interface ApplyInconclusiveInput {
	readonly orgId: OrgId
	readonly investigationId: InvestigationId
	/** The partial: what was ruled out, what could not be checked, the weak lead. */
	readonly report: AiTriageResult
	readonly model: string | null
	readonly inputTokens: number | null
	readonly outputTokens: number | null
	readonly nowMs: number
	readonly validatorNote: string | null
	readonly validatorElapsedMs: number | null
}

/**
 * Publish a partial result: nothing was promoted, but the run still has
 * something to say.
 *
 * A sibling of {@link applyDiagnosisWrites} rather than a flag on it, because
 * the issue-side half must not run. An inconclusive investigation escalating a
 * linked issue's severity would be an escalation nobody concluded, and the
 * `ai_triage` timeline event's payload (`severityAssessment`, `applied`) is
 * meaningless without a promoted cause. Making that a boolean parameter would
 * put both behaviours one typo apart.
 *
 * Three of these writes are load-bearing and each undoes a specific lie the
 * `status: "failed"` path used to tell:
 *
 * - `severity: null` — not `report.severityAssessment`. The hub falls back to
 *   the incident's own severity, so the row shows what the incident is rather
 *   than an AI severity assessment of a cause nobody established.
 * - `diagnosedAt: null` — "time to diagnosis" keys off it, and a timestamp there
 *   claims a diagnosis happened.
 * - `error: null` — the raw `validation_inconclusive: …` string in that column
 *   is what the UI used to render in a destructive box. The report replaces it.
 */
const writeInconclusive = async (db: MaplePgClient, input: ApplyInconclusiveInput): Promise<void> => {
	const now = new Date(input.nowMs)
	await db
		.update(investigations)
		.set({
			status: "inconclusive",
			reportJson: input.report,
			severity: null,
			// Always low, whatever the report says. Nothing was established, and a
			// partial that claims medium confidence in a lead is the "least-bad
			// option promoted to avoid an empty answer" the validator is told to
			// refuse — reintroduced one layer down.
			confidence: "low",
			model: input.model,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			error: null,
			diagnosedAt: null,
			fanoutState: "rejected_all",
			validatorNote: input.validatorNote,
			validatorElapsedMs: input.validatorElapsedMs,
			updatedAt: now,
		})
		.where(and(eq(investigations.orgId, input.orgId), eq(investigations.id, input.investigationId)))
}

/**
 * Publish a partial result. See {@link applyInconclusiveWrites}' body above for
 * why the issue-side half is absent, and {@link applyDiagnosisWrites} for why
 * this owns its database call.
 */
export const applyInconclusiveWrites: (
	input: ApplyInconclusiveInput,
) => Effect.Effect<void, DatabaseError, Database> = Effect.fn("applyInconclusiveWrites")(function* (
	input,
) {
	const database = yield* Database
	yield* makeDbExecute(database, "applyInconclusiveWrites", identity)((db) =>
		writeInconclusive(db, input),
	)
})
