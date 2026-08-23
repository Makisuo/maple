import { randomUUID } from "node:crypto"
import {
	InvestigationFixVerificationSubject,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	type OrgId,
} from "@maple/domain/http"
import { InvestigationId, IsoDateTimeString } from "@maple/domain/primitives"
import { aiTriageSettings, errorIssues, investigations, type ErrorIssueVerificationRow } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Clock, Effect, Exit, Schema } from "effect"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { FanoutStartError } from "@/services/errors/investigation-fanout-error"
import { evaluateInvestigationQuota, selectInvestigationUsage } from "@/services/errors/investigation-quota"
import { FIX_VERIFICATION_MAX_WIDTH } from "@/services/errors/investigation-route"
import { summarizeCause } from "@/platform/describe-cause"

const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

interface FanoutWorkflowBinding {
	readonly create: (options: { id: string; params: unknown }) => Promise<{ id: string }>
}

const isFanoutWorkflowBinding = (value: unknown): value is FanoutWorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

export interface EnqueueFixVerificationInput {
	readonly verification: ErrorIssueVerificationRow
	readonly pullRequestUrl: string
	/** Occurrences since the merge from builds absent from the baseline. Zero is the good case. */
	readonly postMergeOccurrences: number
	/** Occurrences since the merge from builds that were already running. */
	readonly staleClientOccurrences: number
	readonly fanoutBinding?: unknown
}

export type EnqueueFixVerificationResult =
	| { readonly enqueued: true; readonly investigationId: InvestigationId }
	| {
			readonly enqueued: false
			readonly reason: "daily_cap" | "no_binding" | "error" | "disabled"
			readonly investigationId?: InvestigationId
	  }

/**
 * Open the investigation that decides a verification's verdict.
 *
 * Deliberately NOT routed through `maybeEnqueueTriage`: that path dedupes on
 * `(incidentKind, incidentId)` and builds an incident snapshot, and a
 * verification has neither. What it does share — and what is reused here — is
 * the org's daily investigation quota and the Cloudflare Workflow start, so a
 * burst of merges cannot outspend a burst of incidents.
 *
 * The snapshot carries the deterministic evidence as facts. That is the point of
 * the whole design: the agent is asked to interpret a occurrence split that has
 * already been computed, not to go and find one.
 */
export const enqueueFixVerification: (
	input: EnqueueFixVerificationInput,
) => Effect.Effect<EnqueueFixVerificationResult, DatabaseError, Database> = Effect.fn(
	"enqueueFixVerification",
)(function* (input) {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	const { verification } = input
	const orgId: OrgId = verification.orgId

	const settingsRows = yield* database.execute((db) =>
		db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, orgId)).limit(1),
	)
	const settings = settingsRows[0]

	const usage = yield* database.execute((db) => selectInvestigationUsage(db, orgId, nowMs))
	const reservedPasses = FIX_VERIFICATION_MAX_WIDTH + 2
	const quota = evaluateInvestigationQuota({
		usage,
		limits: settings
			? { maxRunsPerDay: settings.maxRunsPerDay, maxPassesPerDay: settings.maxPassesPerDay }
			: undefined,
		passCount: reservedPasses,
		nowMs,
	})
	if (quota.kind === "exceeded") {
		yield* Effect.annotateCurrentSpan({
			orgId,
			"maple.investigation.start_result": "quota_exceeded",
			"maple.investigation.quota_dimension": quota.dimension,
			"maple.investigation.quota_limit": quota.limit,
		})
		return { enqueued: false, reason: "daily_cap" as const }
	}

	const issueRows = yield* database.execute((db) =>
		db
			.select()
			.from(errorIssues)
			.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, verification.issueId)))
			.limit(1),
	)
	const issue = issueRows[0]
	if (issue === undefined) return { enqueued: false, reason: "error" as const }

	const mergedAtIso = decodeIso(verification.mergedAt.toISOString())
	const subject = new InvestigationFixVerificationSubject({
		type: "fix_verification",
		issueId: verification.issueId,
		verificationId: verification.id,
		pullRequestUrl: input.pullRequestUrl,
		baselineVersions: verification.baselineVersionsJson,
		mergedAt: mergedAtIso,
	})

	const snapshot = new InvestigationSubjectSnapshot({
		title: `Did ${input.pullRequestUrl.split("/").slice(-3).join("/")} fix ${issue.exceptionType}?`,
		scope: issue.serviceName,
		status: "verifying",
		severity: issue.severity ?? null,
		facts: [
			new InvestigationSnapshotFact({ label: "Service", value: issue.serviceName }),
			new InvestigationSnapshotFact({ label: "Exception", value: issue.exceptionType }),
			new InvestigationSnapshotFact({ label: "Merged at", value: mergedAtIso }),
			new InvestigationSnapshotFact({
				label: "Occurrences before the merge",
				value: String(verification.baselineOccurrenceCount),
			}),
			new InvestigationSnapshotFact({
				label: "Rate before the merge (per hour)",
				value: verification.baselineRatePerHour.toFixed(2),
			}),
			// The decisive number. Non-zero means the fix demonstrably did not work.
			new InvestigationSnapshotFact({
				label: "Occurrences since the merge from builds that postdate it",
				value: String(input.postMergeOccurrences),
			}),
			// Not evidence against the fix — these are old clients still in the wild.
			new InvestigationSnapshotFact({
				label: "Occurrences since the merge from builds that predate it",
				value: String(input.staleClientOccurrences),
			}),
			new InvestigationSnapshotFact({
				label: "Builds affected at merge time",
				value:
					verification.baselineVersionsJson.length === 0
						? "(none reported)"
						: verification.baselineVersionsJson.join(", "),
			}),
		],
		references: [
			new InvestigationSnapshotReference({ label: "Pull request", url: input.pullRequestUrl }),
		],
		incidentStartedAt: mergedAtIso,
		incidentEndedAt: null,
		fingerprintHash: issue.fingerprintHash,
		exceptionType: issue.exceptionType,
		serviceName: issue.serviceName,
	})

	const investigationId = decodeInvestigationId(randomUUID())
	const inserted = yield* database.execute((db) =>
		db
			.insert(investigations)
			.values({
				id: investigationId,
				orgId,
				status: "investigating",
				seededBy: "system",
				subjectJson: subject,
				snapshotJson: snapshot,
				// No incidentKind/incidentId: a verification is not an incident, and
				// leaving them null keeps it out of the one-per-incident dedup index.
				issueId: verification.issueId,
				severity: issue.severity ?? null,
				startedAt: new Date(nowMs),
				fanoutState: "queued",
				fanoutSize: FIX_VERIFICATION_MAX_WIDTH,
				autonomousTurns: reservedPasses,
				createdAt: new Date(nowMs),
				updatedAt: new Date(nowMs),
			})
			.onConflictDoNothing()
			.returning({ id: investigations.id }),
	)
	if (inserted.length === 0) return { enqueued: false, reason: "error" as const }

	const markFailed = (error: string) =>
		database
			.execute((db) =>
				db
					.update(investigations)
					.set({ status: "failed", error, updatedAt: new Date(nowMs) })
					.where(eq(investigations.id, investigationId)),
			)
			.pipe(Effect.asVoid)

	const workflow = input.fanoutBinding
	if (!isFanoutWorkflowBinding(workflow)) {
		yield* markFailed("agent_unavailable: the investigation fan-out workflow is not configured; retry")
		return { enqueued: false, investigationId, reason: "no_binding" as const }
	}

	const created = yield* Effect.exit(
		Effect.tryPromise({
			try: () =>
				workflow.create({
					id: investigationId,
					params: {
						orgId,
						investigationId,
						maxWidth: FIX_VERIFICATION_MAX_WIDTH,
						reservedPasses,
						attempt: 0,
					},
				}),
			catch: FanoutStartError.fromCause,
		}),
	)
	if (Exit.isFailure(created)) {
		yield* Effect.logWarning("Fix verification fan-out could not be started").pipe(
			Effect.annotateLogs({
				orgId,
				investigationId,
				verificationId: verification.id,
				error: summarizeCause(created.cause),
			}),
		)
		yield* markFailed("start_failed: the investigation fan-out could not be started; retry")
		return { enqueued: false, investigationId, reason: "error" as const }
	}

	yield* Effect.annotateCurrentSpan({
		orgId,
		"maple.investigation.id": investigationId,
		"maple.investigation.start_result": "fanout_started",
		"maple.verification.id": verification.id,
	})
	return { enqueued: true, investigationId }
})
