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
import { encodeChatTurnTenant } from "@maple/domain/chat-session"
import { Database } from "@/platform/DatabaseLive"
import { isChatSessionNamespace } from "@/chat/session"
import { fanoutPlan } from "@/services/errors/fanout-policy"
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

/**
 * The binding that hosts an investigation's durable conversation. This used to be the `CHAT_FLUE`
 * service binding — a whole other Worker — and is now the `ChatSession` Durable Object namespace in
 * this Worker.
 */
export const INVESTIGATION_AGENT_BINDING = "CHAT_SESSION"

/** Cloudflare Workflow binding that runs a fan-out. Present only in a Worker isolate. */
export const INVESTIGATION_FANOUT_BINDING = "INVESTIGATION_FANOUT_WORKFLOW"

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
	 * The `INVESTIGATION_FANOUT_WORKFLOW` binding, read off the worker env by the
	 * caller. Absent means the fan-out cannot run and the row records why — it
	 * does NOT silently fall back to the single pass, because a run that was
	 * planned as a fan-out and quietly ran as one agent is a lie in the boards.
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

		// The gate lives in `fanoutPlan`, shared with the manual path, so "automatic
		// high/critical incidents fan out" is one rule with one implementation.
		const plan = fanoutPlan({
			subject: new InvestigationIncidentSubject({
				type: "incident",
				incidentKind: input.incidentKind,
				incidentId: input.incidentId,
				...(input.issueId ? { issueId: input.issueId } : {}),
			}),
			snapshot: snapshotFor(input),
			automatic: true,
			enabled: settings?.fanoutEnabled ?? false,
		})

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
					fanoutState: plan.size > 1 ? "queued" : "none",
					fanoutSize: plan.size,
					autonomousTurns: plan.passCount,
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

		// Fan-out branch: the run goes to the Cloudflare Workflow instead of the
		// chat session's single turn. Failure discipline mirrors the chat path
		// exactly — the row records why, and the caller gets a non-throwing reason.
		if (plan.size > 1) {
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
								lensIds: plan.lenses,
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
				"maple.investigation.fanout_size": plan.size,
			})
			return { enqueued: true, investigationId }
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

		// Starting the turn is one Durable Object call: `beginTurn` claims the slot, records the
		// prompt, and runs the turn inside the object. There is consequently no "the agent rejected
		// it with HTTP 4xx" outcome any more — the only failure before the turn begins is a busy
		// session — and nothing here has to keep the turn alive, which matters because the cron
		// ticks that call this run under `runScheduledEffect` and dispose their runtime the moment
		// the tick settles.
		const messageId = crypto.randomUUID()
		const claimed = yield* Effect.tryPromise({
			try: () =>
				stub.beginTurn({
					sessionId,
					messageId,
					text: message,
					tenant: encodeChatTurnTenant({
						orgId: input.orgId,
						userId: internalServiceUserId,
						roles: [],
						authMode: "self_hosted",
					}),
				}),
			catch: (cause) => new InvestigationStartError({ message: String(cause) }),
		}).pipe(Effect.catchTag("@maple/api/InvestigationStartError", () => Effect.succeed(undefined)))

		if (!claimed) {
			yield* database.execute((db) =>
				db
					.update(investigations)
					.set({
						status: "failed",
						error: "start_failed: the investigation session could not start a turn; retry",
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
