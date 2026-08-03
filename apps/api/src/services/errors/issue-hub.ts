import { randomUUID } from "node:crypto"
import type { AlertSeverity, IssueSeverity, OrgId, WorkflowState } from "@maple/domain/http"
import {
	ActorId,
	type AlertIncidentId,
	type AlertRuleId,
	ErrorIssueEventId,
	ErrorIssueId,
} from "@maple/domain/primitives"
import { actors, alertIncidents, errorIssues, errorIssueEvents, type ErrorIssueRow } from "@maple/db"
import { and, eq, sql } from "drizzle-orm"
import { Cause, Clock, Effect, Option, Redacted, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { maybeEnqueueTriage } from "./ai-triage-enqueue"
import { SYSTEM_ALERTS_AGENT_NAME } from "@/services/auth/system-actors"

/**
 * Issue-hub glue: alert incidents create/refresh `error_issues` rows
 * (kind="alert") so the issues queue is the single triage surface. Standalone
 * over `Database` (in the style of ai-triage-enqueue.ts) so AlertsService
 * doesn't need the full ErrorsService layer.
 */

const decodeIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const decodeEventId = Schema.decodeUnknownSync(ErrorIssueEventId)
const decodeActorId = Schema.decodeUnknownSync(ActorId)

/**
 * Synthetic dedupe key for alert-backed issues. Real error fingerprints are
 * decimal UInt64 strings from ClickHouse, so the `alert:` prefix can never
 * collide with them inside the UNIQUE(orgId, fingerprintHash) index.
 */
export const alertIssueFingerprint = (ruleId: string, groupKey: string) => `alert:${ruleId}:${groupKey}`

/** Detection-time severity mapping; refined later by AI triage or a human. */
export const detectorSeverityFor = (severity: AlertSeverity): IssueSeverity =>
	severity === "critical" ? "critical" : "medium"

export interface UpsertAlertIssueInput {
	readonly orgId: OrgId
	readonly ruleId: AlertRuleId
	readonly ruleName: string
	readonly groupKey: string
	readonly signalType: string
	readonly severity: AlertSeverity
	readonly comparator: string
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	readonly observedValue: number | null
	readonly sampleCount: number
	readonly incidentId: AlertIncidentId
	readonly serviceName: string
	readonly timestamp: number
	/** Raw CHAT_FLUE service binding off the worker env (may be undefined). */
	readonly agentBinding: unknown
	readonly internalServiceToken: Option.Option<Redacted.Redacted<string>>
}

export interface UpsertAlertIssueResult {
	readonly issueId: ErrorIssueId | null
	readonly action: "created" | "reopened" | "refreshed" | "skipped" | "error"
}

const describeIncident = (input: UpsertAlertIssueInput): string => {
	const observed = input.observedValue == null ? "no data" : `observed ${input.observedValue}`
	const bound =
		input.thresholdUpper == null ? `${input.threshold}` : `${input.threshold}..${input.thresholdUpper}`
	const group = input.groupKey === "__total__" ? "" : ` (group ${input.groupKey})`
	return `${input.signalType} ${input.comparator} ${bound} — ${observed}${group}`
}

const ensureSystemAlertsActor = Effect.fn("issueHub.ensureSystemAlertsActor")(function* (orgId: OrgId) {
	const database = yield* Database
	const select = () =>
		database.execute((db) =>
			db
				.select()
				.from(actors)
				.where(
					and(
						eq(actors.orgId, orgId),
						eq(actors.type, "agent"),
						eq(actors.agentName, SYSTEM_ALERTS_AGENT_NAME),
					),
				)
				.limit(1),
		)
	const existing = yield* select()
	if (existing[0]) return existing[0].id

	const timestamp = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db
			.insert(actors)
			.values({
				id: decodeActorId(randomUUID()),
				orgId,
				type: "agent",
				userId: null,
				agentName: SYSTEM_ALERTS_AGENT_NAME,
				model: null,
				capabilitiesJson: ["system", "alert-issues"],
				createdBy: null,
				createdAt: new Date(timestamp),
				lastActiveAt: new Date(timestamp),
			})
			.onConflictDoNothing(),
	)
	const after = yield* select()
	const row = after[0]
	if (!row) return yield* Effect.die(new Error("Failed to ensure system-alerts actor row"))
	return row.id
})

/**
 * Create-or-refresh the issue backing an alert incident that just opened.
 *
 * Never fails: every error path is logged and reported via `action: "error"`
 * so the per-minute alert scheduler tick is isolated from issue-hub problems.
 */
export const upsertAlertIssue: (
	input: UpsertAlertIssueInput,
) => Effect.Effect<UpsertAlertIssueResult, never, Database> = Effect.fn("issueHub.upsertAlertIssue")(
	function* (input: UpsertAlertIssueInput) {
		const database = yield* Database
		const fingerprintHash = alertIssueFingerprint(input.ruleId, input.groupKey)
		const sourceRefJson = {
			ruleId: input.ruleId,
			groupKey: input.groupKey,
			signalType: input.signalType,
			latestIncidentId: input.incidentId,
		}

		const existingRows = yield* database.execute((db) =>
			db
				.select()
				.from(errorIssues)
				.where(
					and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.fingerprintHash, fingerprintHash)),
				)
				.limit(1),
		)
		const prior: ErrorIssueRow | undefined = existingRows[0]

		let issueId: ErrorIssueId
		let action: UpsertAlertIssueResult["action"]

		if (prior === undefined) {
			issueId = decodeIssueId(randomUUID())
			action = "created"
			yield* database.execute((db) =>
				db.insert(errorIssues).values({
					id: issueId,
					orgId: input.orgId,
					kind: "alert",
					sourceRefJson,
					fingerprintHash,
					serviceName: input.serviceName,
					exceptionType: input.ruleName,
					exceptionMessage: describeIncident(input),
					errorLabel: input.ruleName,
					topFrame: "",
					workflowState: "triage",
					priority: 3,
					severity: detectorSeverityFor(input.severity),
					severitySource: "detector",
					assignedActorId: null,
					leaseHolderActorId: null,
					leaseExpiresAt: null,
					claimedAt: null,
					notes: null,
					firstSeenAt: new Date(input.timestamp),
					lastSeenAt: new Date(input.timestamp),
					occurrenceCount: 1,
					resolvedAt: null,
					resolvedByActorId: null,
					snoozeUntil: null,
					archivedAt: null,
					createdAt: new Date(input.timestamp),
					updatedAt: new Date(input.timestamp),
				}),
			)
			const actorId = yield* ensureSystemAlertsActor(input.orgId)
			yield* recordIssueEvent(input.orgId, issueId, actorId, "created", {
				toState: "triage",
				payload: {
					ruleId: input.ruleId,
					ruleName: input.ruleName,
					groupKey: input.groupKey,
					signalType: input.signalType,
					incidentId: input.incidentId,
				},
				timestamp: input.timestamp,
			})
		} else {
			issueId = prior.id
			const snoozeActive =
				prior.workflowState === "wontfix" &&
				(prior.snoozeUntil == null || prior.snoozeUntil.getTime() > input.timestamp)
			if (snoozeActive) {
				// Mirrors the errors tick: a wontfix issue with an active (or
				// indefinite) snooze is left alone entirely.
				return { issueId, action: "skipped" as const }
			}

			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({
						lastSeenAt: new Date(input.timestamp),
						occurrenceCount: sql`${errorIssues.occurrenceCount} + 1`,
						exceptionMessage: describeIncident(input),
						sourceRefJson,
						updatedAt: new Date(input.timestamp),
					})
					.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, prior.id))),
			)
			// Backfill the detector severity only while severity is still unset
			// (precedence: manual > ai > detector).
			yield* database.execute((db) =>
				db
					.update(errorIssues)
					.set({
						severity: detectorSeverityFor(input.severity),
						severitySource: "detector",
					})
					.where(
						and(
							eq(errorIssues.orgId, input.orgId),
							eq(errorIssues.id, prior.id),
							sql`${errorIssues.severity} IS NULL`,
						),
					),
			)

			const reopenFrom: WorkflowState | null =
				prior.workflowState === "done" || prior.workflowState === "wontfix"
					? prior.workflowState
					: null
			if (reopenFrom !== null) {
				action = "reopened"
				yield* database.execute((db) =>
					db
						.update(errorIssues)
						.set({
							workflowState: "triage",
							resolvedAt: null,
							resolvedByActorId: null,
							snoozeUntil: null,
							updatedAt: new Date(input.timestamp),
						})
						.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, prior.id))),
				)
				const actorId = yield* ensureSystemAlertsActor(input.orgId)
				yield* recordIssueEvent(input.orgId, issueId, actorId, "state_change", {
					fromState: reopenFrom,
					toState: "triage",
					payload: { viaRegression: true, incidentId: input.incidentId },
					timestamp: input.timestamp,
				})
				yield* recordIssueEvent(input.orgId, issueId, actorId, "regression", {
					payload: { incidentId: input.incidentId, ruleId: input.ruleId },
					timestamp: input.timestamp,
				})
			} else {
				action = "refreshed"
			}
		}

		yield* database.execute((db) =>
			db
				.update(alertIncidents)
				.set({ errorIssueId: issueId, updatedAt: new Date(input.timestamp) })
				.where(and(eq(alertIncidents.orgId, input.orgId), eq(alertIncidents.id, input.incidentId))),
		)

		yield* maybeEnqueueTriage({
			orgId: input.orgId,
			incidentKind: "alert",
			incidentId: input.incidentId,
			issueId,
			context: {
				kind: "alert",
				ruleName: input.ruleName,
				signalType: input.signalType,
				severity: input.severity,
				comparator: input.comparator,
				threshold: input.threshold,
				thresholdUpper: input.thresholdUpper,
				windowMinutes: input.windowMinutes,
				groupKey: input.groupKey,
				serviceName: input.serviceName,
				observedValue: input.observedValue,
				sampleCount: input.sampleCount,
				firstTriggeredAt: new Date(input.timestamp).toISOString(),
				issueId,
			},
			agentBinding: input.agentBinding,
			internalServiceToken: input.internalServiceToken,
		})

		return { issueId, action }
	},
	(effect, input) =>
		Effect.catchCause(effect, (cause) =>
			Effect.gen(function* () {
				yield* Effect.logError("Alert issue upsert failed").pipe(
					Effect.annotateLogs({
						orgId: input.orgId,
						ruleId: input.ruleId,
						incidentId: input.incidentId,
						error: Cause.pretty(cause),
					}),
				)
				return { issueId: null, action: "error" as const }
			}),
		),
)

const recordIssueEvent = Effect.fn("issueHub.recordIssueEvent")(function* (
	orgId: OrgId,
	issueId: ErrorIssueId,
	actorId: ActorId,
	type: "created" | "state_change" | "regression",
	opts: {
		readonly fromState?: WorkflowState
		readonly toState?: WorkflowState
		readonly payload?: Record<string, unknown>
		readonly timestamp: number
	},
) {
	const database = yield* Database
	yield* database.execute((db) =>
		db.insert(errorIssueEvents).values({
			id: decodeEventId(randomUUID()),
			orgId,
			issueId,
			actorId,
			type,
			fromState: opts.fromState ?? null,
			toState: opts.toState ?? null,
			payloadJson: opts.payload ?? {},
			createdAt: new Date(opts.timestamp),
		}),
	)
})
