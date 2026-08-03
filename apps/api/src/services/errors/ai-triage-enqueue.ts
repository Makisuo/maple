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
import { AiTriageRunId, InvestigationId } from "@maple/domain/primitives"
import { aiTriageSettings, investigations } from "@maple/db"
import { and, eq, gte, lt, sql } from "drizzle-orm"
import { Cause, Clock, Data, Duration, Effect, Exit, Option, Redacted, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import type { SubmitDiagnosis } from "@/chat/agent"
import { isChatSessionNamespace, runChatSessionTurn } from "@/chat/session"
import { UserId } from "@maple/domain/primitives"

/** Identity an autonomous investigation turn runs as — the same one the internal MCP RPC uses. */
const internalServiceUserId = Schema.decodeUnknownSync(UserId)("internal-service")

/**
 * The binding that hosts an investigation's durable conversation. This used to be the `CHAT_FLUE`
 * service binding — a whole other Worker — and is now the `ChatSession` Durable Object namespace in
 * this Worker.
 */
export const INVESTIGATION_AGENT_BINDING = "CHAT_SESSION"

/**
 * Kept for the one-release migration window because the legacy workflow module
 * still imports it. New producers must use `INVESTIGATION_AGENT_BINDING`.
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

const startOfUtcDay = (nowMs: number): number => {
	const date = new Date(nowMs)
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

const contextString = (context: Record<string, unknown>, key: string): string | undefined => {
	const value = context[key]
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

const snapshotFor = (input: MaybeEnqueueTriageInput): InstanceType<typeof InvestigationSubjectSnapshot> => {
	const serviceName = contextString(input.context, "serviceName")
	const kindWord = `${input.incidentKind[0]?.toUpperCase() ?? ""}${input.incidentKind.slice(1)}`
	// The last resort is what the investigations list renders as a title, so it
	// names the service when there is one — "Alert incident" says nothing the
	// list's kind marker doesn't already say. (`reason` is deliberately not in
	// this chain: it's an enum token like `first_seen`, not a sentence.)
	const title =
		contextString(input.context, "title") ??
		contextString(input.context, "ruleName") ??
		contextString(input.context, "exceptionMessage") ??
		contextString(input.context, "signalType") ??
		(serviceName ? `${kindWord} on ${serviceName}` : `${kindWord} incident`)
	const severityValue = Schema.decodeUnknownOption(Schema.Literals(["critical", "high", "medium", "low"]))(
		input.context.severity,
	)
	const severity: IssueSeverity | null = severityValue._tag === "Some" ? severityValue.value : null
	const factKeys = [
		["Incident", input.incidentId],
		["Service", serviceName],
		["Signal", contextString(input.context, "signalType")],
		["Reason", contextString(input.context, "reason")],
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
		incidentStartedAt: null,
		incidentEndedAt: null,
	})
}

export interface MaybeEnqueueTriageInput {
	readonly orgId: OrgId
	readonly incidentKind: AiTriageIncidentKind
	readonly incidentId: string
	readonly issueId?: ErrorIssueId
	readonly context: Record<string, unknown>
	/** The `CHAT_SESSION` Durable Object namespace, read off the worker env by the caller. */
	readonly agentBinding: unknown
	/**
	 * How the started conversation records its report. Supplied by the caller (which holds
	 * `InvestigationService`) rather than resolved here — see the note on `SubmitDiagnosis`.
	 */
	readonly submitDiagnosis: SubmitDiagnosis
	/** Full worker env, used to resolve the model the turn runs on. */
	readonly workerEnv?: Record<string, unknown>
	/** Manual starts ignore the automation-enabled flag, but never the quota. */
	readonly force?: boolean
}

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
			if (
				existing.status === "investigating" &&
				existing.startedAt !== null &&
				existing.startedAt.getTime() < nowMs - STALE_INVESTIGATION_MS
			) {
				yield* database.execute((db) =>
					db
						.update(investigations)
						.set({
							status: "failed",
							error: "diagnosis_timeout: no diagnosis was submitted within 15 minutes; retry",
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(investigations.orgId, input.orgId),
								eq(investigations.id, existing.id),
								lt(investigations.startedAt, new Date(nowMs - STALE_INVESTIGATION_MS)),
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

		const maxRunsPerDay = settings?.maxRunsPerDay ?? 20
		const usageRows = yield* database.execute((db) =>
			db
				.select({
					count: sql<number>`coalesce(sum(${investigations.autonomousTurns}), 0)::int`,
				})
				.from(investigations)
				.where(
					and(
						eq(investigations.orgId, input.orgId),
						gte(investigations.createdAt, new Date(startOfUtcDay(nowMs))),
					),
				),
		)
		if ((usageRows[0]?.count ?? 0) >= maxRunsPerDay) {
			yield* Effect.logWarning("Investigation daily budget reached; skipping autonomous start").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					maxRunsPerDay,
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
		const snapshot = snapshotFor(input)
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
					autonomousTurns: 1,
					createdAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				.onConflictDoNothing()
				.returning({ id: investigations.id }),
		)
		if (inserted.length === 0) {
			return { enqueued: false, reason: "duplicate" as const }
		}

		const namespace = input.agentBinding
		const sessionId = `${input.orgId}:inv-${investigationId}`
		const stub = isChatSessionNamespace(namespace)
			? namespace.get(namespace.idFromName(sessionId))
			: undefined
		if (!stub) {
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "failed",
						error: "agent_unavailable: the investigation agent is not configured; retry",
						updatedAt: new Date(nowMs),
					})
					.where(eq(investigations.id, investigationId)),
			)
			yield* Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": "agent_unavailable",
			})
			yield* Effect.logWarning("Investigation agent binding is unavailable").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					investigationId,
				}),
			)
			return { enqueued: false, investigationId, reason: "no_binding" as const }
		}

		const message = [
			"Begin the autonomous investigation now.",
			"Use the preserved subject snapshot below as the source context, gather evidence with tools, and call submit_diagnosis exactly once.",
			JSON.stringify({ subject, snapshot }),
		].join("\n\n")

		// Starting the turn is now a Durable Object call plus a detached fiber, not a 15s-timeout
		// HTTP round trip to another Worker. There is consequently no "the agent rejected it with
		// HTTP 4xx" outcome any more — the only failure before the turn begins is a busy session.
		const messageId = crypto.randomUUID()
		const claimed = yield* Effect.promise(() => stub.beginTurn(messageId, message))
		if (!claimed) {
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "failed",
						error: "start_failed: a turn is already running for this investigation; retry",
						updatedAt: new Date(nowMs),
					})
					.where(eq(investigations.id, investigationId)),
			)
			yield* Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": "start_failed",
			})
			return { enqueued: false, investigationId, reason: "error" as const }
		}

		yield* Effect.forkDetach(
			runChatSessionTurn({
				sessionId,
				tenant: {
					orgId: input.orgId,
					userId: internalServiceUserId,
					roles: [],
					authMode: "self_hosted",
				},
				env: input.workerEnv ?? {},
				stub,
				messageId,
				submitDiagnosis: input.submitDiagnosis,
			}),
		)

		yield* Effect.annotateCurrentSpan({
			orgId: input.orgId,
			"maple.investigation.creation_source": input.force ? "manual" : "automatic",
			"maple.investigation.start_result": "started",
			"maple.investigation.id": investigationId,
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
