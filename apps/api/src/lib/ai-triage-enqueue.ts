import { CHAT_FLUE_ORIGIN } from "./chat-flue-origin"
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
import { Database } from "./DatabaseLive"

/** The service binding hosting the durable `maple-chat` investigation agent. */
export const INVESTIGATION_AGENT_BINDING = "CHAT_FLUE"

/**
 * Kept for the one-release migration window because the legacy workflow module
 * still imports it. New producers must use `INVESTIGATION_AGENT_BINDING`.
 */
export const AI_TRIAGE_WORKFLOW_BINDING = "AI_TRIAGE_WORKFLOW"

interface AgentBinding {
	readonly fetch: typeof fetch
}

class InvestigationAgentRequestError extends Data.TaggedError(
	"@maple/api/lib/InvestigationAgentRequestError",
)<{
	readonly message: string
}> {}

const isAgentBinding = (value: unknown): value is AgentBinding =>
	typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function"

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
	const title =
		contextString(input.context, "title") ??
		contextString(input.context, "ruleName") ??
		contextString(input.context, "exceptionMessage") ??
		contextString(input.context, "signalType") ??
		`${input.incidentKind[0]?.toUpperCase() ?? ""}${input.incidentKind.slice(1)} incident`
	const severityValue = Schema.decodeUnknownOption(Schema.Literals(["critical", "high", "medium", "low"]))(
		input.context.severity,
	)
	const severity: IssueSeverity | null = severityValue._tag === "Some" ? severityValue.value : null
	const factKeys = [
		["Incident", input.incidentId],
		["Service", contextString(input.context, "serviceName")],
		["Signal", contextString(input.context, "signalType")],
		["Reason", contextString(input.context, "reason")],
	] as const

	return new InvestigationSubjectSnapshot({
		title,
		scope: contextString(input.context, "serviceName") ?? null,
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
	readonly agentBinding: unknown
	readonly internalServiceToken: Option.Option<Redacted.Redacted<string>>
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

		const agentBinding = input.agentBinding
		if (!isAgentBinding(agentBinding)) {
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

		const token = Option.getOrUndefined(input.internalServiceToken)
		if (token === undefined) {
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "failed",
						error: "agent_unavailable: the internal service token is not configured",
						updatedAt: new Date(nowMs),
					})
					.where(eq(investigations.id, investigationId)),
			)
			yield* Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": "missing_service_token",
			})
			yield* Effect.logError("Investigation internal service token is unavailable").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					investigationId,
				}),
			)
			return { enqueued: false, investigationId, reason: "no_binding" as const }
		}

		const instanceId = `${input.orgId}:inv-${investigationId}`
		const message = [
			"Begin the autonomous investigation now.",
			"Use the preserved subject snapshot below as the source context, gather evidence with tools, and call submit_diagnosis exactly once.",
			JSON.stringify({ subject, snapshot }),
		].join("\n\n")
		const started = yield* Effect.exit(
			Effect.tryPromise({
				try: (signal) =>
					agentBinding.fetch(
						new Request(
							`${CHAT_FLUE_ORIGIN}/agents/maple-chat/${encodeURIComponent(instanceId)}`,
							{
								method: "POST",
								headers: {
									authorization: `Bearer maple_svc_${Redacted.value(token)}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({ message }),
								signal,
							},
						),
					),
				catch: (cause) =>
					new InvestigationAgentRequestError({
						message:
							cause instanceof Error ? cause.message : "Investigation agent request failed",
					}),
			}).pipe(
				Effect.timeoutOrElse({
					duration: Duration.seconds(15),
					orElse: () =>
						Effect.fail(
							new InvestigationAgentRequestError({
								message: "Investigation agent request timed out after 15 seconds",
							}),
						),
				}),
			),
		)
		if (Exit.isFailure(started) || !started.value.ok) {
			const error = Exit.isFailure(started)
				? Cause.pretty(started.cause)
				: `agent returned HTTP ${started.value.status}`
			const retryable =
				Exit.isFailure(started) || started.value.status === 429 || started.value.status >= 500
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "failed",
						error: retryable ? `start_failed: ${error}; retry` : `start_rejected: ${error}`,
						updatedAt: new Date(nowMs),
					})
					.where(eq(investigations.id, investigationId)),
			)
			yield* Effect.annotateCurrentSpan({
				orgId: input.orgId,
				"maple.investigation.id": investigationId,
				"maple.investigation.start_result": retryable ? "start_failed" : "start_rejected",
			})
			yield* Effect.logWarning("Investigation agent start failed").pipe(
				Effect.annotateLogs({
					orgId: input.orgId,
					incidentId: input.incidentId,
					investigationId,
					retryable,
					error,
				}),
			)
			return {
				enqueued: false,
				investigationId,
				reason: retryable ? ("error" as const) : ("rejected" as const),
			}
		}

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
