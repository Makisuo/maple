import { randomUUID } from "node:crypto"
import {
	errorIncidents,
	errorIssues,
	errorIssueEvents,
	errorIssueStates,
	errorNotificationDeliveries,
	errorTickStates,
	type ErrorIssueEventInsert,
	type ErrorIssueRow,
	type ErrorNotificationPolicyRow,
} from "@maple/db"
import type { DatabaseClient } from "@/platform/DatabaseLive"
import type {
	ActorId,
	AlertDestinationId,
	ErrorIncidentId,
	ErrorIncidentReason,
	ErrorIssueEventId,
	ErrorIssueId,
	IssueSeverity,
	OrgId,
} from "@maple/domain/http"
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm"

export interface ErrorTickScanRow {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly topFrame: string
	readonly count: number
	readonly firstSeenMs: number
	readonly lastSeenMs: number
}

export interface PendingErrorTriage {
	readonly issueId: ErrorIssueId
	readonly incidentId: ErrorIncidentId
	readonly reason: ErrorIncidentReason
	readonly severity: IssueSeverity | null
	readonly row: ErrorTickScanRow
}

interface NotificationPayload {
	readonly kind: "open" | "resolve"
	readonly issueId: string
	readonly incidentId: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly severity: "warning" | "critical"
	readonly threshold: number
	readonly count: number
}

export interface PersistErrorTickWindowInput {
	readonly orgId: OrgId
	readonly actorId: ActorId
	readonly rows: ReadonlyArray<ErrorTickScanRow>
	readonly policy: ErrorNotificationPolicyRow
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	readonly windowEndMs: number
	readonly autoResolveMinutes: number
	readonly claimToken: string
	readonly makeIssueId: () => ErrorIssueId
	readonly makeIncidentId: () => ErrorIncidentId
	readonly makeEventId: () => ErrorIssueEventId
}

export interface PersistErrorTickWindowResult {
	readonly issuesTouched: number
	readonly incidentsOpened: number
	readonly incidentsResolved: number
	readonly pendingTriages: ReadonlyArray<PendingErrorTriage>
}

type TickTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

const insertEvent = (
	tx: TickTransaction,
	input: PersistErrorTickWindowInput,
	issueId: ErrorIssueId,
	type: ErrorIssueEventInsert["type"],
	options: {
		readonly fromState?: ErrorIssueEventInsert["fromState"]
		readonly toState?: ErrorIssueEventInsert["toState"]
		readonly payload?: Record<string, unknown>
	} = {},
) =>
	tx.insert(errorIssueEvents).values({
		id: input.makeEventId(),
		orgId: input.orgId,
		issueId,
		actorId: input.actorId,
		type,
		fromState: options.fromState ?? null,
		toState: options.toState ?? null,
		payloadJson: options.payload ?? {},
		createdAt: new Date(input.windowEndMs),
	})

const openNotificationsEnabled = (
	policy: ErrorNotificationPolicyRow,
	reason: ErrorIncidentReason,
	count: number,
): boolean =>
	policy.enabled &&
	count >= policy.minOccurrenceCount &&
	((reason === "first_seen" && policy.notifyOnFirstSeen) ||
		(reason === "regression" && policy.notifyOnRegression))

const insertNotificationRows = async (
	tx: TickTransaction,
	input: PersistErrorTickWindowInput,
	payload: NotificationPayload,
) => {
	if (input.destinationIds.length === 0) return
	const suffix = payload.kind === "open" ? "open" : "resolve"
	const deliveryKey = `err:${input.orgId}:${payload.incidentId}:${suffix}`
	await tx
		.insert(errorNotificationDeliveries)
		.values(
			input.destinationIds.map((destinationId) => ({
				id: randomUUID(),
				orgId: input.orgId,
				destinationId,
				deliveryKey,
				payloadJson: payload,
				status: "queued" as const,
				attemptCount: 0,
				scheduledAt: new Date(input.windowEndMs),
				claimedAt: null,
				claimExpiresAt: null,
				claimedBy: null,
				attemptedAt: null,
				errorMessage: null,
				createdAt: new Date(input.windowEndMs),
				updatedAt: new Date(input.windowEndMs),
			})),
		)
		.onConflictDoNothing({
			target: [errorNotificationDeliveries.deliveryKey, errorNotificationDeliveries.destinationId],
		})
}

/**
 * Apply one claimed, half-open evaluator window atomically. The durable cursor
 * advances only if every issue, incident, event, and notification-outbox write
 * commits. A transaction retry is safe because none of its generated IDs can
 * escape a rolled-back attempt.
 */
export const persistErrorTickWindow = (
	db: DatabaseClient,
	input: PersistErrorTickWindowInput,
): Promise<PersistErrorTickWindowResult> =>
	db.transaction(async (tx) => {
		const fingerprints = [...new Set(input.rows.map((row) => row.fingerprintHash))]
		const existingIssues =
			fingerprints.length === 0
				? []
				: await tx
						.select()
						.from(errorIssues)
						.where(
							and(
								eq(errorIssues.orgId, input.orgId),
								inArray(errorIssues.fingerprintHash, fingerprints),
							),
						)
		const issueByFingerprint = new Map(existingIssues.map((row) => [row.fingerprintHash, row]))
		const observed: Array<{
			readonly issueId: ErrorIssueId
			readonly row: ErrorTickScanRow
			readonly wasNew: boolean
			readonly wasRegression: boolean
			readonly priorSeverity: IssueSeverity | null
		}> = []

		for (const row of input.rows) {
			let prior: ErrorIssueRow | undefined = issueByFingerprint.get(row.fingerprintHash)
			if (
				prior?.workflowState === "wontfix" &&
				(prior.snoozeUntil == null || prior.snoozeUntil.getTime() > input.windowEndMs)
			) {
				continue
			}

			let issueId: ErrorIssueId
			let wasNew = false
			let wasRegression = false

			if (!prior) {
				const candidateId = input.makeIssueId()
				const inserted = await tx
					.insert(errorIssues)
					.values({
						id: candidateId,
						orgId: input.orgId,
						fingerprintHash: row.fingerprintHash,
						serviceName: row.serviceName,
						exceptionType: row.exceptionType,
						exceptionMessage: row.exceptionMessage,
						errorLabel: row.errorLabel,
						topFrame: row.topFrame,
						workflowState: "triage",
						priority: 3,
						assignedActorId: null,
						leaseHolderActorId: null,
						leaseExpiresAt: null,
						claimedAt: null,
						notes: null,
						firstSeenAt: new Date(row.firstSeenMs),
						lastSeenAt: new Date(row.lastSeenMs),
						occurrenceCount: row.count,
						resolvedAt: null,
						resolvedByActorId: null,
						snoozeUntil: null,
						archivedAt: null,
						createdAt: new Date(input.windowEndMs),
						updatedAt: new Date(input.windowEndMs),
					})
					.onConflictDoNothing({ target: [errorIssues.orgId, errorIssues.fingerprintHash] })
					.returning()

				prior = inserted[0]
				if (prior) {
					issueId = prior.id
					wasNew = true
					issueByFingerprint.set(row.fingerprintHash, prior)
					await insertEvent(tx, input, issueId, "created", {
						toState: "triage",
						payload: {
							serviceName: row.serviceName,
							exceptionType: row.exceptionType,
							occurrenceCount: row.count,
						},
					})
				} else {
					// A rolling-deploy overlap can race an older worker that does not use
					// the cursor lease. Adopt the unique-index winner and count this window.
					const winner = (
						await tx
							.select()
							.from(errorIssues)
							.where(
								and(
									eq(errorIssues.orgId, input.orgId),
									eq(errorIssues.fingerprintHash, row.fingerprintHash),
								),
							)
							.limit(1)
					)[0]
					if (!winner) throw new Error("Error issue conflict winner disappeared")
					prior = winner
					issueId = winner.id
					issueByFingerprint.set(row.fingerprintHash, winner)
				}
			} else {
				issueId = prior.id
			}

			if (!wasNew) {
				await tx
					.update(errorIssues)
					.set({
						serviceName: row.serviceName,
						exceptionType: row.exceptionType,
						exceptionMessage: row.exceptionMessage,
						errorLabel: row.errorLabel,
						topFrame: row.topFrame,
						firstSeenAt: sql`least(${errorIssues.firstSeenAt}, ${new Date(row.firstSeenMs)})`,
						lastSeenAt: sql`greatest(${errorIssues.lastSeenAt}, ${new Date(row.lastSeenMs)})`,
						occurrenceCount: sql`${errorIssues.occurrenceCount} + ${row.count}`,
						updatedAt: new Date(input.windowEndMs),
					})
					.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, issueId)))

				if (prior.workflowState === "done") {
					wasRegression = true
					await tx
						.update(errorIssues)
						.set({
							workflowState: "triage",
							resolvedAt: null,
							resolvedByActorId: null,
							updatedAt: new Date(input.windowEndMs),
						})
						.where(and(eq(errorIssues.orgId, input.orgId), eq(errorIssues.id, issueId)))
					await insertEvent(tx, input, issueId, "state_change", {
						fromState: "done",
						toState: "triage",
						payload: { viaRegression: true },
					})
					await insertEvent(tx, input, issueId, "regression", {
						payload: { occurrenceCount: row.count },
					})
				}
			}

			observed.push({
				issueId,
				row,
				wasNew,
				wasRegression,
				priorSeverity: prior?.severity ?? null,
			})
		}

		const observedIssueIds = observed.map((entry) => entry.issueId)
		const states =
			observedIssueIds.length === 0
				? []
				: await tx
						.select()
						.from(errorIssueStates)
						.where(
							and(
								eq(errorIssueStates.orgId, input.orgId),
								inArray(errorIssueStates.issueId, observedIssueIds),
							),
						)
		const stateByIssue = new Map(states.map((row) => [row.issueId, row]))
		const pendingTriages: PendingErrorTriage[] = []
		let incidentsOpened = 0

		for (const entry of observed) {
			const state = stateByIssue.get(entry.issueId)
			if (state?.openIncidentId) {
				await tx
					.update(errorIncidents)
					.set({
						lastTriggeredAt: sql`greatest(${errorIncidents.lastTriggeredAt}, ${new Date(entry.row.lastSeenMs)})`,
						occurrenceCount: sql`${errorIncidents.occurrenceCount} + ${entry.row.count}`,
						updatedAt: new Date(input.windowEndMs),
					})
					.where(eq(errorIncidents.id, state.openIncidentId))
				await tx
					.update(errorIssueStates)
					.set({
						lastObservedOccurrenceAt: sql`greatest(${errorIssueStates.lastObservedOccurrenceAt}, ${new Date(entry.row.lastSeenMs)})`,
						lastEvaluatedAt: new Date(input.windowEndMs),
						updatedAt: new Date(input.windowEndMs),
					})
					.where(
						and(
							eq(errorIssueStates.orgId, input.orgId),
							eq(errorIssueStates.issueId, entry.issueId),
						),
					)
				continue
			}

			const reason: ErrorIncidentReason = entry.wasRegression ? "regression" : "first_seen"
			const incidentId = input.makeIncidentId()
			const claimed = await tx
				.insert(errorIssueStates)
				.values({
					orgId: input.orgId,
					issueId: entry.issueId,
					lastObservedOccurrenceAt: new Date(entry.row.lastSeenMs),
					lastEvaluatedAt: new Date(input.windowEndMs),
					openIncidentId: incidentId,
					updatedAt: new Date(input.windowEndMs),
				})
				.onConflictDoUpdate({
					target: [errorIssueStates.orgId, errorIssueStates.issueId],
					set: {
						lastObservedOccurrenceAt: new Date(entry.row.lastSeenMs),
						lastEvaluatedAt: new Date(input.windowEndMs),
						openIncidentId: incidentId,
						updatedAt: new Date(input.windowEndMs),
					},
					setWhere: isNull(errorIssueStates.openIncidentId),
				})
				.returning({ openIncidentId: errorIssueStates.openIncidentId })
			if (claimed[0]?.openIncidentId !== incidentId) continue

			await tx.insert(errorIncidents).values({
				id: incidentId,
				orgId: input.orgId,
				issueId: entry.issueId,
				status: "open",
				reason,
				firstTriggeredAt: new Date(entry.row.firstSeenMs),
				lastTriggeredAt: new Date(entry.row.lastSeenMs),
				resolvedAt: null,
				occurrenceCount: entry.row.count,
				createdAt: new Date(input.windowEndMs),
				updatedAt: new Date(input.windowEndMs),
			})
			incidentsOpened += 1

			if (openNotificationsEnabled(input.policy, reason, entry.row.count)) {
				await insertNotificationRows(tx, input, {
					kind: "open",
					issueId: entry.issueId,
					incidentId,
					serviceName: entry.row.serviceName,
					exceptionType: entry.row.exceptionType,
					severity: input.policy.severity,
					threshold: input.policy.minOccurrenceCount,
					count: entry.row.count,
				})
			}
			pendingTriages.push({
				issueId: entry.issueId,
				incidentId,
				reason,
				severity: entry.priorSeverity,
				row: entry.row,
			})
		}

		const staleBefore = new Date(input.windowEndMs - input.autoResolveMinutes * 60_000)
		const staleIncidents = await tx
			.select()
			.from(errorIncidents)
			.where(
				and(
					eq(errorIncidents.orgId, input.orgId),
					eq(errorIncidents.status, "open"),
					lt(errorIncidents.lastTriggeredAt, staleBefore),
				),
			)
		const staleIssueIds = [...new Set(staleIncidents.map((incident) => incident.issueId))]
		const staleIssues =
			staleIssueIds.length === 0
				? []
				: await tx
						.select()
						.from(errorIssues)
						.where(
							and(eq(errorIssues.orgId, input.orgId), inArray(errorIssues.id, staleIssueIds)),
						)
		const staleIssueById = new Map(staleIssues.map((issue) => [issue.id, issue]))
		let incidentsResolved = 0

		for (const incident of staleIncidents) {
			const flipped = await tx
				.update(errorIncidents)
				.set({
					status: "resolved",
					resolvedAt: new Date(input.windowEndMs),
					updatedAt: new Date(input.windowEndMs),
				})
				.where(and(eq(errorIncidents.id, incident.id), eq(errorIncidents.status, "open")))
				.returning({ id: errorIncidents.id })
			if (flipped.length === 0) continue

			await tx
				.update(errorIssueStates)
				.set({ openIncidentId: null, updatedAt: new Date(input.windowEndMs) })
				.where(
					and(
						eq(errorIssueStates.orgId, input.orgId),
						eq(errorIssueStates.issueId, incident.issueId),
					),
				)
			incidentsResolved += 1

			const issue = staleIssueById.get(incident.issueId)
			if (input.policy.enabled && input.policy.notifyOnResolve && issue) {
				await insertNotificationRows(tx, input, {
					kind: "resolve",
					issueId: incident.issueId,
					incidentId: incident.id,
					serviceName: issue.serviceName,
					exceptionType: issue.exceptionType,
					severity: input.policy.severity,
					threshold: input.policy.minOccurrenceCount,
					count: incident.occurrenceCount,
				})
			}
		}

		const advanced = await tx
			.update(errorTickStates)
			.set({
				processedThrough: new Date(input.windowEndMs),
				bootstrapCompleted: true,
				claimToken: null,
				claimExpiresAt: null,
				updatedAt: new Date(input.windowEndMs),
			})
			.where(
				and(eq(errorTickStates.orgId, input.orgId), eq(errorTickStates.claimToken, input.claimToken)),
			)
			.returning({ orgId: errorTickStates.orgId })
		if (advanced.length === 0) throw new Error("Error tick claim was lost before checkpoint commit")

		return {
			issuesTouched: observed.length,
			incidentsOpened,
			incidentsResolved,
			pendingTriages,
		}
	})
