import { randomUUID } from "node:crypto"
import {
	type AiTriageIncidentKind,
	type ErrorIssueId,
	InvestigationIncidentSubject,
	InvestigationSnapshotFact,
	InvestigationSnapshotReference,
	InvestigationSubjectSnapshot,
	type IssueSeverity,
	type OrgId,
} from "@maple/domain/http"
import { AiTriageRunId, InvestigationId, IsoDateTimeString } from "@maple/domain/primitives"
import { aiTriageSettings, investigations } from "@maple/db"
import { and, eq, lt } from "drizzle-orm"
import { Cause, Clock, Data, Duration, Effect, Exit, Option, Redacted, Schema } from "effect"
import { encodeChatTurnTenant } from "@maple/domain/chat-session"
import { Database } from "@/platform/DatabaseLive"
import { isChatSessionNamespace } from "@/chat/session"
import { widthFor } from "@/workflows/plan-normalize"
import { AUTONOMOUS_KICKOFF_LEAD, buildIncidentContextMessage } from "@/workflows/incident-context"
import { evaluateInvestigationQuota, selectInvestigationUsage } from "@/services/errors/investigation-quota"
import {
	isInvestigationStale,
	staleBudgetMs,
	staleTimeoutMessage,
} from "@/services/errors/investigation-stale"
import { UserId } from "@maple/domain/primitives"

/** Identity an autonomous investigation turn runs as — the same one the internal MCP RPC uses. */
const internalServiceUserId = Schema.decodeUnknownSync(UserId)("internal-service")

/** A `beginTurn` call that the Durable Object could not complete (overload, eviction, limits). */
class InvestigationStartError extends Data.TaggedError("@maple/api/InvestigationStartError")<{
	readonly message: string
}> {}

/** Cloudflare Workflow binding that runs a fan-out. Present only in a Worker isolate. */
export const INVESTIGATION_FANOUT_BINDING = "INVESTIGATION_FANOUT_WORKFLOW"

/**
 * Kept for the one-release migration window because the legacy workflow module
 * still imports it. Nothing else should.
 */
export const AI_TRIAGE_WORKFLOW_BINDING = "AI_TRIAGE_WORKFLOW"

const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const decodeLegacyRunId = Schema.decodeUnknownSync(AiTriageRunId)

interface LegacyWorkflowBinding {
	readonly create: (options?: unknown) => Promise<unknown>
}

/** @deprecated Used only by the legacy manual-run endpoint during cutover. */
export const isAiTriageWorkflowBinding = (value: unknown): value is LegacyWorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

/** @deprecated Used only by the legacy manual-run endpoint during cutover. */
export const newAiTriageRunId = () => decodeLegacyRunId(randomUUID())

const STALE_INVESTIGATION_MS = 15 * 60 * 1000

const contextString = (context: Record<string, unknown>, key: string): string | undefined => {
	const value = context[key]
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

const contextNumber = (context: Record<string, unknown>, key: string): number | null => {
	const value = context[key]
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * The first of these keys that carries a usable instant, as an ISO string.
 *
 * Several keys because each incident kind names its own window differently and
 * none of them was reaching the snapshot: the interval was hardcoded `null` while
 * every prompt opened with "establish the exact incident interval from the
 * attached subject". The `Date` branch is load-bearing, not defensive — the error
 * path passes `firstSeen`/`lastSeen` as `Date` objects, and a string-only reader
 * would have silently kept the old `null`.
 *
 * Every branch normalizes through `Date` before encoding, so a producer that
 * passes an already-ISO string still gets a value the branded schema accepts
 * rather than one that merely looks like it.
 */
const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

const contextInstant = (
	context: Record<string, unknown>,
	...keys: ReadonlyArray<string>
): IsoDateTimeString | null => {
	for (const key of keys) {
		const value = context[key]
		const instant =
			value instanceof Date
				? value
				: typeof value === "number" && Number.isFinite(value)
					? new Date(value)
					: typeof value === "string" && value.trim().length > 0
						? new Date(value)
						: null
		if (instant !== null && !Number.isNaN(instant.getTime())) {
			return decodeIso(instant.toISOString())
		}
	}
	return null
}

const snapshotFor = (input: MaybeEnqueueTriageInput): InstanceType<typeof InvestigationSubjectSnapshot> => {
	const serviceName = contextString(input.context, "serviceName")
	const kindWord = `${input.incidentKind[0]?.toUpperCase() ?? ""}${input.incidentKind.slice(1)}`
	// The last resort is what the investigations list renders as a title, so it
	// names the service when there is one — "Alert incident" says nothing the
	// list's kind marker doesn't already say. (`reason` is deliberately not in
	// this chain: it's an enum token like `first_seen`, not a sentence.)
	// `exceptionType: message` beats either alone: the type is what an engineer
	// recognizes, the message is what distinguishes two of the same type. Falling
	// through to `errorLabel` before `signalType` matters for the exact class of
	// error that reads worst — a status-message-only error has no exception type,
	// and its label is the only human-readable thing about it.
	const exceptionHeadline = (() => {
		const type = contextString(input.context, "exceptionType")
		const message = contextString(input.context, "exceptionMessage")
		if (type && message) return `${type}: ${message}`
		return type ?? message
	})()
	const title =
		contextString(input.context, "title") ??
		contextString(input.context, "ruleName") ??
		exceptionHeadline ??
		contextString(input.context, "errorLabel") ??
		contextString(input.context, "signalType") ??
		(serviceName ? `${kindWord} on ${serviceName}` : `${kindWord} incident`)
	const severityValue = Schema.decodeUnknownOption(Schema.Literals(["critical", "high", "medium", "low"]))(
		input.context.severity,
	)
	const severity: IssueSeverity | null = severityValue._tag === "Some" ? severityValue.value : null
	const fingerprintHash = contextString(input.context, "fingerprintHash") ?? null
	const exceptionType = contextString(input.context, "exceptionType") ?? null
	const exceptionMessage = contextString(input.context, "exceptionMessage") ?? null
	const topFrame = contextString(input.context, "topFrame") ?? null
	const occurrenceCount = contextNumber(input.context, "occurrenceCount")

	// Display facts. The identifier fields below are the same values again, but the
	// two lists are for different readers — this one renders on the investigation
	// page, that one is what the agent calls tools with — so they are built from one
	// source rather than allowed to drift.
	const factKeys = [
		["Incident", input.incidentId],
		["Service", serviceName],
		["Signal", contextString(input.context, "signalType")],
		["Reason", contextString(input.context, "reason")],
		["Exception", exceptionType],
		["Top frame", topFrame],
		["Fingerprint", fingerprintHash],
		["Occurrences", occurrenceCount === null ? undefined : String(occurrenceCount)],
	] as const

	return new InvestigationSubjectSnapshot({
		title,
		scope: serviceName ?? null,
		status: "open",
		severity,
		facts: factKeys.flatMap(([label, value]) =>
			value ? [new InvestigationSnapshotFact({ label, value })] : [],
		),
		references: input.issueId
			? [
					new InvestigationSnapshotReference({
						label: "Issue",
						url: `/errors/issues/${input.issueId}`,
					}),
				]
			: [],
		// Both were hardcoded `null` while every producer already knew the answer.
		incidentStartedAt: contextInstant(
			input.context,
			"firstSeen",
			"firstTriggeredAt",
			"windowStart",
			"detectedAt",
		),
		incidentEndedAt: contextInstant(input.context, "lastSeen", "lastTriggeredAt"),
		fingerprintHash,
		exceptionType,
		exceptionMessage,
		topFrame,
		errorLabel: contextString(input.context, "errorLabel") ?? null,
		occurrenceCount,
		serviceName: serviceName ?? null,
		deploymentEnv: contextString(input.context, "deploymentEnv") ?? null,
		signalType: contextString(input.context, "signalType") ?? null,
		observedValue: contextNumber(input.context, "observedValue"),
		thresholdValue: contextNumber(input.context, "thresholdValue"),
	})
}

export interface MaybeEnqueueTriageInput {
	readonly orgId: OrgId
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: ErrorIssueId
	readonly context: Record<string, unknown>
	/**
	 * The `INVESTIGATION_FANOUT_WORKFLOW` binding, read off the worker env by the
	 * caller. Absent means the investigation cannot run and the row records why —
	 * it does NOT silently fall back to one shallow pass, because a run that was
	 * planned and quietly ran as a single agent is a lie in the boards.
	 */
	readonly fanoutBinding?: unknown
	/** Manual starts ignore the automation-enabled flag, but never the quota. */
	readonly force?: boolean
}

class FanoutStartError extends Data.TaggedError("FanoutStartError")<{ readonly cause: string }> {}

interface FanoutWorkflowBinding {
	readonly create: (options: { id: string; params: unknown }) => Promise<{ id: string }>
}

const isFanoutWorkflowBinding = (value: unknown): value is FanoutWorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

export interface MaybeEnqueueTriageResult {
	readonly enqueued: boolean
	readonly investigationId?: InvestigationId
	readonly reason?: "disabled" | "daily_cap" | "duplicate" | "no_binding" | "rejected" | "error"
}

/**
 * Create and seed one durable investigation for a newly opened incident.
 *
 * This is the producer-facing compatibility seam during the cutover: callers
 * retain their non-failing "maybe enqueue" contract, while all persistence and
 * conversation identity now use `investigations` + `inv-<id>`.
 */
export const maybeEnqueueTriage: (
	input: MaybeEnqueueTriageInput,
) => Effect.Effect<MaybeEnqueueTriageResult, never, Database> = Effect.fn("maybeStartInvestigation")(
	function* (input) {
		const database = yield* Database
		const nowMs = yield* Clock.currentTimeMillis

		const existingRows = yield* database.execute((db) =>
			db
				.select()
				.from(investigations)
				.where(
					and(
						eq(investigations.orgId, input.orgId),
						eq(investigations.incidentKind, input.incidentKind),
						eq(investigations.incidentId, input.incidentId),
					),
				)
				.limit(1),
		)
		const existing = existingRows[0]
		if (existing) {
			if (isInvestigationStale(existing, nowMs)) {
				const budget = staleBudgetMs(existing.fanoutState)
				yield* database.execute((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							error: staleTimeoutMessage(budget),
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(investigations.orgId, input.orgId),
								eq(investigations.id, existing.id),
								lt(investigations.startedAt, new Date(nowMs - budget)),
							),
						),
				)
			}
			return { enqueued: false, investigationId: existing.id, reason: "duplicate" as const }
		}

		const settingsRows = yield* database.execute((db) =>
			db.select().from(aiTriageSettings).where(eq(aiTriageSettings.orgId, input.orgId)).limit(1),
		)
		const settings = settingsRows[0]
		if (!input.force && (settings === undefined || !settings.enabled)) {
			return { enqueued: false, reason: "disabled" as const }
		}

		// No routing decision to make: this producer only ever opens *incidents*, and
		// an incident is planned. `routeInvestigation` exists for the manual path,
		// which also has to handle free-form questions. What is left is the width.
		const snapshot = snapshotFor(input)
		const maxWidth = widthFor(snapshot.severity, input.incidentKind)
		const reservedPasses = maxWidth + 2

		// Runs and passes are two ceilings in two units, and this path used to sum
		// `autonomousTurns` — a *pass* count — against `maxRunsPerDay`. Shared with
		// `InvestigationService.ensureStartAllowed` so the two can no longer diverge.
		const usage = yield* database.execute((db) => selectInvestigationUsage(db, input.orgId, nowMs))
		const verdict = evaluateInvestigationQuota({
			usage,
			limits: settings,
			passCount: reservedPasses,
			nowMs,
		})
		if (verdict.kind === "exceeded") {
			yield* Effect.logWarning("Investigation daily budget reached; skipping autonomous start").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					quotaDimension: verdict.dimension,
					quotaLimit: verdict.limit,
				}),
			)
			return { enqueued: false, reason: "daily_cap" as const }
		}

		const investigationId = decodeInvestigationId(randomUUID())
		const subject = new InvestigationIncidentSubject({
			type: "incident",
			incidentKind: input.incidentKind,
			incidentId: input.incidentId,
			...(input.issueId ? { issueId: input.issueId } : {}),
		})
		const inserted = yield* database.execute((db) =>
			db
				.insert(investigations)
				.values({
					id: investigationId,
					orgId: input.orgId,
					status: "investigating",
					seededBy: "system",
					subjectJson: subject,
					snapshotJson: snapshot,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					issueId: input.issueId ?? null,
					startedAt: new Date(nowMs),
					fanoutState: "queued",
					// Provisional until the planner runs; the workflow's `plan` step corrects
					// both this and the reservation below once the real width exists.
					fanoutSize: maxWidth,
					autonomousTurns: reservedPasses,
					createdAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				.onConflictDoNothing()
				.returning({ id: investigations.id }),
		)
		if (inserted.length === 0) {
			return { enqueued: false, reason: "duplicate" as const }
		}

		const markFailed = (error: string) =>
			database
				.execute((db) =>
					db
						.update(investigations)
						.set({ status: "failed", error, updatedAt: new Date(nowMs) })
						.where(eq(investigations.id, investigationId)),
				)
				.pipe(Effect.asVoid)

		// The run goes to the Cloudflare Workflow. There is no chat-session fallback:
		// a run that was planned and quietly executed as one shallow pass is a lie in
		// the boards, so a missing binding records why and stops.
		const workflow = input.fanoutBinding
		if (!isFanoutWorkflowBinding(workflow)) {
			yield* markFailed(
				"agent_unavailable: the investigation fan-out workflow is not configured; retry",
			)
			return { enqueued: false, investigationId, reason: "no_binding" as const }
		}
		// `Exit`, not `Effect.option`: the reason a create() failed is the whole
		// diagnostic value here — an id collision means a live instance already
		// owns this investigation, a network error means retry.
		const created = yield* Effect.exit(
			Effect.tryPromise({
				try: () =>
					workflow.create({
						id: investigationId,
						params: {
							orgId: input.orgId,
							investigationId,
							maxWidth,
							reservedPasses,
							attempt: 0,
						},
					}),
				catch: (cause) => new FanoutStartError({ cause: String(cause) }),
			}),
		)
		if (Exit.isFailure(created)) {
			yield* Effect.logWarning("Investigation fan-out could not be started").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					investigationId,
					error: Cause.pretty(created.cause),
				}),
			)
			yield* markFailed("start_failed: the investigation fan-out could not be started; retry")
			return { enqueued: false, investigationId, reason: "error" as const }
		}
		yield* Effect.annotateCurrentSpan({
			orgId: input.orgId,
			"maple.investigation.id": investigationId,
			"maple.investigation.start_result": "fanout_started",
			"maple.investigation.fanout_max_width": maxWidth,
		})
		return { enqueued: true, investigationId }
	},
	(effect, input) =>
		Effect.catchCause(effect, (cause) =>
			Effect.logError("Investigation enqueue failed").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentKind: input.incidentKind,
					incidentId: input.incidentId,
					error: Cause.pretty(cause),
				}),
				Effect.as({ enqueued: false, reason: "error" as const }),
			),
		),
)
