/**
 * Drains the issue-escalation outbox (`issue_escalations`, written by the AI
 * triage workflow's persist step and manual severity changes) through the
 * org's escalation policy to the shared NotificationDispatcher.
 *
 * Severity → destination routing is the *triage-outcome* channel: detection
 * noise stays on alert-rule destinations / the error notification policy, so
 * a severity escalation is at-most-once per issue+level (outbox dedupeKey),
 * upward-only (enforced by the writers via escalationReasonFor).
 */
import {
	AlertPersistenceError,
	AlertSignalType,
	EscalationConfidence,
	IssueEscalationPolicyRule,
	type AlertSeverity,
	type IssueSeverity,
	type OrgId,
} from "@maple/domain/http"
import {
	alertDestinations,
	errorIssues,
	issueEscalationPolicies,
	issueEscalations,
	type IssueEscalationPolicyRow,
	type IssueEscalationRow,
} from "@maple/db"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute } from "@/platform/db-execute"
import { Env } from "@/platform/Env"
import { evaluateEscalationPolicy } from "@/services/alerts/escalation-policy"
import { makePersistenceError } from "./alert-persistence"
import { NotificationDispatcher, type NotificationRequest } from "./NotificationDispatcher"

const ESCALATIONS_PER_TICK = 50
const MAX_ATTEMPTS = 3

const decodePolicyRules = Schema.decodeUnknownOption(Schema.Array(IssueEscalationPolicyRule))
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeConfidence = Schema.decodeUnknownOption(EscalationConfidence)

const chatSeverityFor = (severity: IssueSeverity): AlertSeverity =>
	severity === "critical" || severity === "high" ? "critical" : "warning"

interface EscalationTickResult {
	readonly processed: number
	readonly sent: number
	readonly skipped: number
	readonly failed: number
	readonly retried: number
}

export interface EscalationServiceShape {
	readonly runEscalationTick: () => Effect.Effect<EscalationTickResult, AlertPersistenceError>
}

/*
 * Hoisted out of the class options with an explicit annotation so the
 * `EscalationService.of(...)` return does not create a circular inference
 * through the class's own base expression.
 */
const make: Effect.Effect<EscalationServiceShape, never, Database | NotificationDispatcher | Env> =
	Effect.gen(function* () {
		const database = yield* Database
		const dispatcher = yield* NotificationDispatcher
		const env = yield* Env

		const dbExecute = makeDbExecute(database, "EscalationService", makePersistenceError)

		const loadPolicy = (orgId: OrgId) =>
			dbExecute((db) =>
				db
					.select()
					.from(issueEscalationPolicies)
					.where(eq(issueEscalationPolicies.orgId, orgId))
					.limit(1),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const finalize = (
			row: IssueEscalationRow,
			status: "sent" | "skipped" | "failed" | "queued",
			timestamp: number,
			error?: string,
			deliveryResults?: unknown,
		) =>
			dbExecute((db) =>
				db
					.update(issueEscalations)
					.set({
						status,
						error: error ?? null,
						...(deliveryResults === undefined ? {} : { deliveryResultsJson: deliveryResults }),
						...(status === "queued" ? {} : { processedAt: new Date(timestamp) }),
					})
					.where(eq(issueEscalations.id, row.id)),
			)

		const processOne = Effect.fn("EscalationService.processOne")(function* (
			row: IssueEscalationRow,
			policyCache: Map<OrgId, IssueEscalationPolicyRow | null>,
		) {
			const timestamp = yield* Clock.currentTimeMillis

			// Optimistic claim: bump attempts iff nobody else already has. A
			// concurrent tick loses the CAS and skips the row.
			const claimed = yield* dbExecute((db) =>
				db
					.update(issueEscalations)
					.set({ attempts: row.attempts + 1 })
					.where(
						and(
							eq(issueEscalations.id, row.id),
							eq(issueEscalations.status, "queued"),
							eq(issueEscalations.attempts, row.attempts),
						),
					)
					// The returned row is the claim: empty means the CAS lost.
					.returning({ id: issueEscalations.id }),
			)
			if (claimed.length === 0) {
				return "contended" as const
			}

			let policy = policyCache.get(row.orgId)
			if (policy === undefined) {
				policy = yield* loadPolicy(row.orgId)
				policyCache.set(row.orgId, policy)
			}
			const rules =
				policy == null ? [] : Option.getOrElse(decodePolicyRules(policy.rulesJson), () => [])
			const payload = Option.getOrElse(
				decodeJsonRecord(row.payloadJson),
				(): Record<string, unknown> => ({}),
			)
			const configuredDestinationIds = rules.flatMap((rule) => rule.destinationIds)
			const destinationRows =
				configuredDestinationIds.length === 0
					? []
					: yield* dbExecute((db) =>
							db
								.select({ id: alertDestinations.id })
								.from(alertDestinations)
								.where(
									and(
										eq(alertDestinations.orgId, row.orgId),
										eq(alertDestinations.enabled, true),
										inArray(alertDestinations.id, configuredDestinationIds),
									),
								),
						)
			const confidence = Option.getOrUndefined(decodeConfidence(payload.confidence))
			const decision = evaluateEscalationPolicy({
				enabled: policy?.enabled ?? false,
				rules,
				severity: row.severity,
				source: row.source,
				...(confidence === undefined ? {} : { confidence }),
				enabledDestinationIds: new Set(destinationRows.map((destination) => destination.id)),
			})
			yield* Effect.annotateCurrentSpan({
				"maple.escalation.policy_outcome": decision.outcome,
				...(decision.skipReason ? { "maple.escalation.skip_reason": decision.skipReason } : {}),
				"maple.escalation.destination_count": decision.destinationIds.length,
			})
			if (decision.outcome === "skip") {
				yield* finalize(row, "skipped", timestamp, decision.skipReason)
				return "skipped" as const
			}

			const issueRows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, row.orgId), eq(errorIssues.id, row.issueId)))
					.limit(1),
			)
			const issue = issueRows[0]
			if (!issue) {
				yield* finalize(row, "skipped", timestamp, "issue_missing")
				return "skipped" as const
			}

			const sourceRef =
				issue.sourceRefJson == null ? null : Option.getOrNull(decodeJsonRecord(issue.sourceRefJson))

			const linkUrl = `${env.MAPLE_APP_BASE_URL}/errors/issues/${issue.id}`
			const request: NotificationRequest = {
				// Stable across retries (no attempt suffix) so any downstream
				// consumer that dedupes on the key absorbs a re-send.
				deliveryKey: `escalation:${row.id}`,
				ruleId: typeof sourceRef?.ruleId === "string" ? sourceRef.ruleId : issue.id,
				ruleName: issue.exceptionType || "Issue escalation",
				groupKey: null,
				signalType: Option.getOrElse(
					decodeSignalType(sourceRef?.signalType),
					() => "error_rate" as const,
				),
				severity: chatSeverityFor(row.severity),
				comparator: "gt",
				threshold: 0,
				thresholdUpper: null,
				eventType: "trigger",
				incidentId: null,
				incidentStatus: "open",
				dedupeKey: row.dedupeKey,
				windowMinutes: 0,
				value: null,
				sampleCount: null,
				linkUrl,
				escalation: {
					issue: {
						id: issue.id,
						kind: issue.kind,
						title: issue.exceptionType,
						serviceName: issue.serviceName,
						workflowState: issue.workflowState,
						severity: row.severity,
						severitySource: issue.severitySource,
						linkUrl,
					},
					...(payload.triage !== undefined ? { triage: payload.triage } : {}),
					source: row.source,
					reason: row.reason,
					...(row.investigationId != null
						? {
								investigation: {
									id: row.investigationId,
									url: `${env.MAPLE_APP_BASE_URL}/investigations/${row.investigationId}`,
								},
							}
						: {}),
					...(row.runId != null ? { runId: row.runId } : {}),
				},
			}

			// At-most-once: flip to "sent" BEFORE dispatching. With the old
			// dispatch-then-finalize order, a finalize failure after a successful
			// delivery left the row queued and the next tick re-paged everyone.
			// Now the failure window drops the escalation instead — the design
			// explicitly prefers a rare drop over a duplicate page. The row being
			// "sent" also keeps a concurrent tick's claim CAS (status = queued)
			// from picking it up mid-dispatch.
			yield* finalize(row, "sent", timestamp)
			const result = yield* dispatcher.dispatch(row.orgId, decision.destinationIds, request)
			yield* finalize(row, "sent", timestamp, undefined, result.destinations)

			if (result.delivered > 0) {
				return "sent" as const
			}
			if (result.failed === 0) {
				// No enabled destinations matched — nothing to retry.
				yield* finalize(row, "skipped", timestamp, "no_enabled_destinations")
				return "skipped" as const
			}
			if (row.attempts + 1 >= MAX_ATTEMPTS) {
				yield* finalize(row, "failed", timestamp, "delivery_failed")
				return "failed" as const
			}
			// Genuine delivery failure (dispatch reported it, nothing was sent):
			// surrender the early "sent" and requeue; next tick retries with the
			// already-bumped attempts counter.
			yield* finalize(row, "queued", timestamp, "delivery_failed_will_retry")
			return "retried" as const
		})

		const runEscalationTick: EscalationServiceShape["runEscalationTick"] = Effect.fn(
			"EscalationService.runEscalationTick",
		)(function* () {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(issueEscalations)
					.where(eq(issueEscalations.status, "queued"))
					.orderBy(asc(issueEscalations.createdAt))
					.limit(ESCALATIONS_PER_TICK),
			)

			const policyCache = new Map<OrgId, IssueEscalationPolicyRow | null>()
			// catchCause isolates defects: a dying processOne is logged and
			// counted as "failed", and the row keeps whatever state it reached —
			// still "queued" (attempts bumped) before the pre-dispatch sent-flip,
			// so the next tick retries it; "sent" after the flip, so it is never
			// re-delivered (at-most-once). Scheduler interruption is re-raised.
			const outcomes = yield* Effect.forEach(rows, (row) =>
				processOne(row, policyCache).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logError("Escalation processing failed").pipe(
									Effect.annotateLogs({
										escalationId: row.id,
										orgId: row.orgId,
										cause: Cause.pretty(cause),
									}),
									Effect.as("failed" as const),
								),
					),
				),
			)
			const count = (outcome: (typeof outcomes)[number]) => outcomes.filter((o) => o === outcome).length
			return {
				processed: outcomes.length - count("contended"),
				sent: count("sent"),
				skipped: count("skipped"),
				failed: count("failed"),
				retried: count("retried"),
			}
		})

		return EscalationService.of({ runEscalationTick })
	})

export class EscalationService extends Context.Service<EscalationService, EscalationServiceShape>()(
	"@maple/api/services/EscalationService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
