import { randomUUID } from "node:crypto"
import {
	errorFingerprintCandidates,
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
import { msToDate, msToSqlTimestamp } from "@/platform/time"
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
import { FINGERPRINT_VERSION } from "@maple/domain/tinybird/fingerprint"
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm"

export interface ErrorTickScanRow {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly topFrame: string
	readonly serviceVersion: string
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

/**
 * Carried in the thrown message because the driver and `Database.execute`
 * rewrap the error on its way out of the transaction, leaving the message as
 * the only field that survives intact. `isErrorTickClaimLost` is the only
 * supported way to test for it.
 */
/**
 * Occurrences a brand-new fingerprint must accumulate before it becomes an
 * Issue. Below this it waits in `error_fingerprint_candidates`.
 *
 * The gap this closes: a fingerprint used to become a durable row plus a
 * first-seen notification on its very first occurrence, so one unapplied
 * migration minted 2,531 issues in three days. Deliberately low — the cost of
 * the threshold is that a genuinely rare error is delayed until it recurs, and
 * anything that only ever happens once is not worth a triage row.
 */
const PROMOTION_MIN_OCCURRENCES = 3

/**
 * How long after an issue is resolved before an occurrence counts as a
 * regression. Covers the rollout window: a fix marked done is not live
 * everywhere the same second, and stragglers from the pre-fix build would
 * otherwise reopen the issue immediately.
 */
const REGRESSION_GRACE_MS = 60 * 60 * 1000

/** Cap on the per-issue build set, so a long-lived issue cannot grow unbounded. */
const MAX_TRACKED_VERSIONS = 50

/**
 * Whether an occurrence on a resolved issue is a genuine regression.
 *
 * Two guards, and the second is the one that matters for shipped clients.
 * `maple-cli` runs on other people's machines: after a fix ships, every old
 * binary in the wild keeps emitting the bug forever. Under the previous rule —
 * any occurrence on a `done` issue reopens it — those issues could never stay
 * fixed, which is why agents kept re-fixing the same bug.
 *
 * Version comparison is set MEMBERSHIP, never ordering: `maple-cli` reports
 * semver ("0.0.18") while the Workers report git SHAs, so "newer than the fix"
 * is not a question these strings can answer. A build already running when the
 * issue was resolved is an old client; a build we had not seen then is a real
 * regression, which is exactly the signal wanted.
 */
/** The transaction handle `persistErrorTickWindow` runs its statements on. */
type ErrorTickTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

/**
 * Accumulate not-yet-promoted fingerprints and return the ones that have now
 * earned an Issue, carrying their ACCUMULATED totals rather than this window's.
 *
 * Promotion deletes the candidate row, so a fingerprint is counted once: the
 * Issue takes over from here and the next occurrence lands on it directly.
 */
const promoteCandidates = async (
	tx: ErrorTickTransaction,
	input: PersistErrorTickWindowInput,
	unknownRows: ReadonlyArray<ErrorTickScanRow>,
	windowEnd: Date,
): Promise<ReadonlyArray<ErrorTickScanRow>> => {
	if (unknownRows.length === 0) return []

	const upserted = await tx
		.insert(errorFingerprintCandidates)
		.values(
			unknownRows.map((row) => ({
				orgId: input.orgId,
				fingerprintHash: row.fingerprintHash,
				serviceName: row.serviceName,
				exceptionType: row.exceptionType,
				exceptionMessage: row.exceptionMessage,
				errorLabel: row.errorLabel,
				topFrame: row.topFrame,
				serviceVersion: row.serviceVersion,
				occurrenceCount: row.count,
				firstSeenAt: msToDate(row.firstSeenMs),
				lastSeenAt: msToDate(row.lastSeenMs),
				updatedAt: windowEnd,
			})),
		)
		.onConflictDoUpdate({
			target: [errorFingerprintCandidates.orgId, errorFingerprintCandidates.fingerprintHash],
			set: {
				serviceName: sql`excluded.service_name`,
				exceptionType: sql`excluded.exception_type`,
				exceptionMessage: sql`excluded.exception_message`,
				errorLabel: sql`excluded.error_label`,
				topFrame: sql`excluded.top_frame`,
				serviceVersion: sql`excluded.service_version`,
				occurrenceCount: sql`${errorFingerprintCandidates.occurrenceCount} + excluded.occurrence_count`,
				firstSeenAt: sql`least(${errorFingerprintCandidates.firstSeenAt}, excluded.first_seen_at)`,
				lastSeenAt: sql`greatest(${errorFingerprintCandidates.lastSeenAt}, excluded.last_seen_at)`,
				updatedAt: sql`excluded.updated_at`,
			},
		})
		.returning()

	const ready = upserted.filter((row) => row.occurrenceCount >= PROMOTION_MIN_OCCURRENCES)
	if (ready.length === 0) return []

	await tx.delete(errorFingerprintCandidates).where(
		and(
			eq(errorFingerprintCandidates.orgId, input.orgId),
			inArray(
				errorFingerprintCandidates.fingerprintHash,
				ready.map((row) => row.fingerprintHash),
			),
		),
	)

	return ready.map((row) => ({
		fingerprintHash: row.fingerprintHash,
		serviceName: row.serviceName,
		exceptionType: row.exceptionType,
		exceptionMessage: row.exceptionMessage,
		errorLabel: row.errorLabel,
		topFrame: row.topFrame,
		serviceVersion: row.serviceVersion,
		count: row.occurrenceCount,
		firstSeenMs: row.firstSeenAt.getTime(),
		lastSeenMs: row.lastSeenAt.getTime(),
	}))
}

export const isRegression = (
	prior: Pick<ErrorIssueRow, "workflowState" | "resolvedAt" | "resolvedVersionsJson">,
	row: Pick<ErrorTickScanRow, "lastSeenMs" | "serviceVersion">,
): boolean => {
	if (prior.workflowState !== "done") return false

	const resolvedAtMs = prior.resolvedAt?.getTime()
	if (resolvedAtMs !== undefined && row.lastSeenMs < resolvedAtMs + REGRESSION_GRACE_MS) return false

	// An unknown build cannot be ruled out, so it stays a regression.
	if (row.serviceVersion !== "" && prior.resolvedVersionsJson.includes(row.serviceVersion)) {
		return false
	}

	return true
}

/** Union a newly observed build into an issue's tracked set, oldest dropped first. */
const mergeVersions = (existing: ReadonlyArray<string>, observed: string): ReadonlyArray<string> => {
	if (observed === "" || existing.includes(observed)) return existing
	const next = [...existing, observed]
	return next.length > MAX_TRACKED_VERSIONS ? next.slice(next.length - MAX_TRACKED_VERSIONS) : next
}

const CLAIM_LOST_MARKER = "[error-tick-claim-lost]"

export const isErrorTickClaimLost = (error: { readonly message: string }): boolean =>
	error.message.includes(CLAIM_LOST_MARKER)

/**
 * The evaluator no longer holds this org's cursor row. Only reachable when the
 * worker stalled long enough for the crash-recovery TTL to elapse and another
 * invocation took over, so the window must roll back rather than double-apply.
 */
// Database.execute rewraps transaction throws, so the marker-bearing native message is the intentional boundary.
// oxlint-disable-next-line effecttsgo/extends-native-error
export class ErrorTickClaimLost extends Error {
	readonly _tag = "ErrorTickClaimLost"
	constructor(
		readonly orgId: string,
		readonly stage: "preflight" | "checkpoint",
	) {
		super(`${CLAIM_LOST_MARKER} claim for ${orgId} was lost before ${stage}`)
		this.name = "ErrorTickClaimLost"
	}
}

/**
 * The scan groups by fingerprint, so duplicates are not expected — but a
 * multi-row `ON CONFLICT DO UPDATE` errors outright if the same conflict target
 * appears twice in one statement, so collapsing them is a correctness
 * requirement of the batched write rather than defensive tidying.
 */
const mergeScanRows = (rows: ReadonlyArray<ErrorTickScanRow>): ReadonlyArray<ErrorTickScanRow> => {
	const merged = new Map<string, ErrorTickScanRow>()
	for (const row of rows) {
		const prior = merged.get(row.fingerprintHash)
		merged.set(
			row.fingerprintHash,
			prior
				? {
						...row,
						count: prior.count + row.count,
						firstSeenMs: Math.min(prior.firstSeenMs, row.firstSeenMs),
						lastSeenMs: Math.max(prior.lastSeenMs, row.lastSeenMs),
					}
				: row,
		)
	}
	return [...merged.values()]
}

const buildEvent = (
	input: PersistErrorTickWindowInput,
	issueId: ErrorIssueId,
	type: ErrorIssueEventInsert["type"],
	options: {
		readonly fromState?: ErrorIssueEventInsert["fromState"]
		readonly toState?: ErrorIssueEventInsert["toState"]
		readonly payload?: Record<string, unknown>
	} = {},
): ErrorIssueEventInsert => ({
	id: input.makeEventId(),
	orgId: input.orgId,
	issueId,
	actorId: input.actorId,
	type,
	fromState: options.fromState ?? null,
	toState: options.toState ?? null,
	payloadJson: options.payload ?? {},
	createdAt: msToDate(input.windowEndMs),
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

const buildNotificationRows = (input: PersistErrorTickWindowInput, payload: NotificationPayload) => {
	const deliveryKey = `err:${input.orgId}:${payload.incidentId}:${payload.kind}`
	return input.destinationIds.map((destinationId) => ({
		id: randomUUID(),
		orgId: input.orgId,
		destinationId,
		deliveryKey,
		payloadJson: payload,
		status: "queued" as const,
		attemptCount: 0,
		scheduledAt: msToDate(input.windowEndMs),
		claimedAt: null,
		claimExpiresAt: null,
		claimedBy: null,
		attemptedAt: null,
		errorMessage: null,
		createdAt: msToDate(input.windowEndMs),
		updatedAt: msToDate(input.windowEndMs),
	}))
}

/**
 * Apply one claimed, half-open evaluator window atomically. The durable cursor
 * advances only if every issue, incident, event, and notification-outbox write
 * commits. A transaction retry is safe because none of its generated IDs can
 * escape a rolled-back attempt.
 *
 * Every write is set-based: the cost of a window is a fixed handful of
 * statements rather than a few per fingerprint. That is what keeps a wide
 * catch-up window inside its lease — a per-row loop over Hyperdrive turns a
 * large window into a transaction that cannot finish before the lease TTL,
 * and a window that can never commit never advances the cursor either.
 */
export const persistErrorTickWindow = (
	db: DatabaseClient,
	input: PersistErrorTickWindowInput,
): Promise<PersistErrorTickWindowResult> =>
	db.transaction(async (tx) => {
		const windowEnd = msToDate(input.windowEndMs)
		// The raw `sql` bulk updates below bind this with no column type behind it,
		// so it has to reach the driver as a string — see `msToSqlTimestamp`.
		const windowEndSql = msToSqlTimestamp(input.windowEndMs)

		// Lock the cursor row for the life of the transaction. `claimTickWindow`
		// skips locked rows, so an in-flight apply can no longer be stolen by the
		// next cron: the TTL degrades to pure crash recovery. Without this a slow
		// window is stolen, rolled back at the checkpoint, and retried at the same
		// width forever — the org silently stops producing issues.
		const held = await tx
			.select({ orgId: errorTickStates.orgId })
			.from(errorTickStates)
			.where(
				and(eq(errorTickStates.orgId, input.orgId), eq(errorTickStates.claimToken, input.claimToken)),
			)
			.for("update")
		if (held.length === 0) throw new ErrorTickClaimLost(input.orgId, "preflight")

		const rows = mergeScanRows(input.rows)
		const fingerprints = rows.map((row) => row.fingerprintHash)
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

		// The cursor row lock makes this evaluator the only writer of error-kind
		// issues for the org, so the prefetch is authoritative: a fingerprint
		// absent here is genuinely new. (Alert-kind issues use an `alert:` prefixed
		// fingerprint and cannot collide.)
		// A fingerprint with no Issue yet is not admitted on sight: it accumulates
		// in the candidate table and is promoted only once it clears
		// PROMOTION_MIN_OCCURRENCES. Promotion returns the ACCUMULATED totals, so a
		// newly promoted issue opens with the occurrences it earned rather than
		// just the ones in this window.
		const promoted = await promoteCandidates(
			tx,
			input,
			rows.filter((row) => !issueByFingerprint.has(row.fingerprintHash)),
			windowEnd,
		)
		const promotedByFingerprint = new Map(promoted.map((row) => [row.fingerprintHash, row]))

		const applicable: Array<{
			readonly row: ErrorTickScanRow
			readonly prior: ErrorIssueRow | undefined
			readonly regression: boolean
		}> = []
		for (const scanned of rows) {
			const prior = issueByFingerprint.get(scanned.fingerprintHash)
			const row = promotedByFingerprint.get(scanned.fingerprintHash) ?? scanned

			// Still short of the promotion threshold — it stays a candidate.
			if (prior === undefined && !promotedByFingerprint.has(scanned.fingerprintHash)) continue

			// `wontfix` suppresses the issue until its snooze elapses; a null snooze
			// means suppressed indefinitely.
			if (
				prior?.workflowState === "wontfix" &&
				(prior.snoozeUntil == null || prior.snoozeUntil.getTime() > input.windowEndMs)
			) {
				continue
			}
			applicable.push({ row, prior, regression: prior !== undefined && isRegression(prior, row) })
		}

		const events: Array<ErrorIssueEventInsert> = []
		const notifications: Array<ReturnType<typeof buildNotificationRows>[number]> = []

		const observed: Array<{
			readonly issueId: ErrorIssueId
			readonly row: ErrorTickScanRow
			readonly wasRegression: boolean
			readonly priorSeverity: IssueSeverity | null
		}> = []

		if (applicable.length > 0) {
			// One upsert covers new, ongoing, and regressed fingerprints. The SET
			// expressions all read the pre-update row, so the regression flip and the
			// counter accumulation stay consistent with each other.
			const upserted = await tx
				.insert(errorIssues)
				.values(
					applicable.map(({ row, prior }) => ({
						id: input.makeIssueId(),
						orgId: input.orgId,
						fingerprintHash: row.fingerprintHash,
						fingerprintVersion: FINGERPRINT_VERSION,
						serviceName: row.serviceName,
						exceptionType: row.exceptionType,
						exceptionMessage: row.exceptionMessage,
						errorLabel: row.errorLabel,
						topFrame: row.topFrame,
						workflowState: "triage" as const,
						priority: 3,
						assignedActorId: null,
						leaseHolderActorId: null,
						leaseExpiresAt: null,
						claimedAt: null,
						notes: null,
						firstSeenAt: msToDate(row.firstSeenMs),
						lastSeenAt: msToDate(row.lastSeenMs),
						occurrenceCount: row.count,
						seenVersionsJson: mergeVersions(prior?.seenVersionsJson ?? [], row.serviceVersion),
						resolvedAt: null,
						resolvedByActorId: null,
						snoozeUntil: null,
						archivedAt: null,
						createdAt: windowEnd,
						updatedAt: windowEnd,
					})),
				)
				.onConflictDoUpdate({
					target: [errorIssues.orgId, errorIssues.fingerprintHash],
					set: {
						fingerprintVersion: sql`excluded.fingerprint_version`,
						serviceName: sql`excluded.service_name`,
						exceptionType: sql`excluded.exception_type`,
						exceptionMessage: sql`excluded.exception_message`,
						errorLabel: sql`excluded.error_label`,
						topFrame: sql`excluded.top_frame`,
						firstSeenAt: sql`least(${errorIssues.firstSeenAt}, excluded.first_seen_at)`,
						lastSeenAt: sql`greatest(${errorIssues.lastSeenAt}, excluded.last_seen_at)`,
						occurrenceCount: sql`${errorIssues.occurrenceCount} + excluded.occurrence_count`,
						// The merged set is computed against the pre-update row and arrives
						// via the INSERT values, so this stays one statement.
						seenVersionsJson: sql`excluded.seen_versions_json`,
						// Reopening is NOT decided here. It used to be
						// `case when workflow_state = 'done' then 'triage'`, which reopened a
						// fixed issue on any occurrence at all — including one from a build
						// that predates the fix. That needs the issue's resolved-build set,
						// which SQL cannot reach from `excluded`, so `isRegression` decides in
						// TypeScript and the targeted update below applies it.
						updatedAt: sql`excluded.updated_at`,
					},
				})
				.returning({
					id: errorIssues.id,
					fingerprintHash: errorIssues.fingerprintHash,
				})

			const idByFingerprint = new Map(upserted.map((row) => [row.fingerprintHash, row.id]))

			for (const { row, prior, regression } of applicable) {
				const issueId = idByFingerprint.get(row.fingerprintHash)
				if (!issueId) throw new Error(`Error issue upsert returned no row for ${row.fingerprintHash}`)

				if (!prior) {
					events.push(
						buildEvent(input, issueId, "created", {
							toState: "triage",
							payload: {
								serviceName: row.serviceName,
								exceptionType: row.exceptionType,
								occurrenceCount: row.count,
							},
						}),
					)
				}

				const wasRegression = regression
				if (wasRegression) {
					events.push(
						buildEvent(input, issueId, "state_change", {
							fromState: "done",
							toState: "regressed",
							payload: { viaRegression: true },
						}),
						buildEvent(input, issueId, "regression", {
							payload: { occurrenceCount: row.count },
						}),
					)
				}

				observed.push({
					issueId,
					row,
					wasRegression,
					priorSeverity: prior?.severity ?? null,
				})
			}

			// Apply the reopen decided above. Reopening lands in `regressed`, not
			// `triage`: an issue that was fixed and came back is not the same thing
			// as one nobody has looked at, and flattening the two is what let the
			// same bug be picked up and fixed again from scratch.
			const regressedIds = observed.filter((entry) => entry.wasRegression).map((entry) => entry.issueId)
			if (regressedIds.length > 0) {
				await tx
					.update(errorIssues)
					.set({
						workflowState: "regressed",
						resolvedAt: null,
						resolvedByActorId: null,
						lastRegressedAt: windowEnd,
						regressionCount: sql`${errorIssues.regressionCount} + 1`,
						updatedAt: windowEnd,
					})
					.where(and(eq(errorIssues.orgId, input.orgId), inArray(errorIssues.id, regressedIds)))
			}
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

		const refreshing: Array<{
			readonly incidentId: ErrorIncidentId
			readonly issueId: ErrorIssueId
			readonly row: ErrorTickScanRow
		}> = []
		const claiming: Array<{
			readonly incidentId: ErrorIncidentId
			readonly reason: ErrorIncidentReason
			readonly entry: (typeof observed)[number]
		}> = []
		for (const entry of observed) {
			const openIncidentId = stateByIssue.get(entry.issueId)?.openIncidentId
			if (openIncidentId) {
				refreshing.push({ incidentId: openIncidentId, issueId: entry.issueId, row: entry.row })
			} else {
				claiming.push({
					incidentId: input.makeIncidentId(),
					reason: entry.wasRegression ? "regression" : "first_seen",
					entry,
				})
			}
		}

		if (refreshing.length > 0) {
			const incidentValues = sql.join(
				refreshing.map(
					(item) =>
						sql`(${item.incidentId}::text, ${msToSqlTimestamp(item.row.lastSeenMs)}::timestamptz, ${item.row.count}::integer)`,
				),
				sql`, `,
			)
			await tx.execute(sql`
				update ${errorIncidents} as t
				set last_triggered_at = greatest(t.last_triggered_at, v.last_seen),
				    occurrence_count = t.occurrence_count + v.cnt,
				    updated_at = ${windowEndSql}::timestamptz
				from (values ${incidentValues}) as v(incident_id, last_seen, cnt)
				where t.id = v.incident_id
			`)

			const stateValues = sql.join(
				refreshing.map(
					(item) =>
						sql`(${item.issueId}::text, ${msToSqlTimestamp(item.row.lastSeenMs)}::timestamptz)`,
				),
				sql`, `,
			)
			await tx.execute(sql`
				update ${errorIssueStates} as t
				set last_observed_occurrence_at = greatest(t.last_observed_occurrence_at, v.last_seen),
				    last_evaluated_at = ${windowEndSql}::timestamptz,
				    updated_at = ${windowEndSql}::timestamptz
				from (values ${stateValues}) as v(issue_id, last_seen)
				where t.org_id = ${input.orgId} and t.issue_id = v.issue_id
			`)
		}

		const pendingTriages: PendingErrorTriage[] = []
		let incidentsOpened = 0

		if (claiming.length > 0) {
			// The conditional upsert is the single-open-incident guard: a row whose
			// `open_incident_id` is already set fails the `setWhere` and is therefore
			// absent from RETURNING, so the claimed set is exactly what came back.
			const claimed = await tx
				.insert(errorIssueStates)
				.values(
					claiming.map((item) => ({
						orgId: input.orgId,
						issueId: item.entry.issueId,
						lastObservedOccurrenceAt: msToDate(item.entry.row.lastSeenMs),
						lastEvaluatedAt: windowEnd,
						openIncidentId: item.incidentId,
						updatedAt: windowEnd,
					})),
				)
				.onConflictDoUpdate({
					target: [errorIssueStates.orgId, errorIssueStates.issueId],
					set: {
						lastObservedOccurrenceAt: sql`excluded.last_observed_occurrence_at`,
						lastEvaluatedAt: sql`excluded.last_evaluated_at`,
						openIncidentId: sql`excluded.open_incident_id`,
						updatedAt: sql`excluded.updated_at`,
					},
					setWhere: isNull(errorIssueStates.openIncidentId),
				})
				.returning({
					issueId: errorIssueStates.issueId,
					openIncidentId: errorIssueStates.openIncidentId,
				})

			const claimedIncidentByIssue = new Map(claimed.map((row) => [row.issueId, row.openIncidentId]))
			const opened = claiming.filter(
				(item) => claimedIncidentByIssue.get(item.entry.issueId) === item.incidentId,
			)

			if (opened.length > 0) {
				await tx.insert(errorIncidents).values(
					opened.map((item) => ({
						id: item.incidentId,
						orgId: input.orgId,
						issueId: item.entry.issueId,
						status: "open" as const,
						reason: item.reason,
						firstTriggeredAt: msToDate(item.entry.row.firstSeenMs),
						lastTriggeredAt: msToDate(item.entry.row.lastSeenMs),
						resolvedAt: null,
						occurrenceCount: item.entry.row.count,
						createdAt: windowEnd,
						updatedAt: windowEnd,
					})),
				)
				incidentsOpened = opened.length

				for (const item of opened) {
					if (openNotificationsEnabled(input.policy, item.reason, item.entry.row.count)) {
						notifications.push(
							...buildNotificationRows(input, {
								kind: "open",
								issueId: item.entry.issueId,
								incidentId: item.incidentId,
								serviceName: item.entry.row.serviceName,
								exceptionType: item.entry.row.exceptionType,
								severity: input.policy.severity,
								threshold: input.policy.minOccurrenceCount,
								count: item.entry.row.count,
							}),
						)
					}
					pendingTriages.push({
						issueId: item.entry.issueId,
						incidentId: item.incidentId,
						reason: item.reason,
						severity: item.entry.priorSeverity,
						row: item.entry.row,
					})
				}
			}
		}

		const staleBefore = msToDate(input.windowEndMs - input.autoResolveMinutes * 60_000)
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

		let incidentsResolved = 0
		if (staleIncidents.length > 0) {
			const staleIds = staleIncidents.map((incident) => incident.id)
			// `status = 'open'` in the predicate keeps the flip idempotent, and
			// RETURNING reports exactly which rows this transaction resolved.
			const flipped = await tx
				.update(errorIncidents)
				.set({ status: "resolved", resolvedAt: windowEnd, updatedAt: windowEnd })
				.where(
					and(
						eq(errorIncidents.orgId, input.orgId),
						inArray(errorIncidents.id, staleIds),
						eq(errorIncidents.status, "open"),
					),
				)
				.returning({ id: errorIncidents.id })
			const flippedIds = flipped.map((row) => row.id)
			incidentsResolved = flippedIds.length

			if (flippedIds.length > 0) {
				const resolvedIncidents = staleIncidents.filter((incident) =>
					flippedIds.includes(incident.id),
				)
				// Match on `open_incident_id` too: a state pointing at some other
				// incident must not be cleared by this one resolving.
				await tx
					.update(errorIssueStates)
					.set({ openIncidentId: null, updatedAt: windowEnd })
					.where(
						and(
							eq(errorIssueStates.orgId, input.orgId),
							inArray(
								errorIssueStates.issueId,
								resolvedIncidents.map((incident) => incident.issueId),
							),
							inArray(errorIssueStates.openIncidentId, flippedIds),
						),
					)

				if (input.policy.enabled && input.policy.notifyOnResolve) {
					const staleIssueIds = [...new Set(resolvedIncidents.map((incident) => incident.issueId))]
					const staleIssues = await tx
						.select()
						.from(errorIssues)
						.where(
							and(eq(errorIssues.orgId, input.orgId), inArray(errorIssues.id, staleIssueIds)),
						)
					const staleIssueById = new Map(staleIssues.map((issue) => [issue.id, issue]))
					for (const incident of resolvedIncidents) {
						const issue = staleIssueById.get(incident.issueId)
						if (!issue) continue
						notifications.push(
							...buildNotificationRows(input, {
								kind: "resolve",
								issueId: incident.issueId,
								incidentId: incident.id,
								serviceName: issue.serviceName,
								exceptionType: issue.exceptionType,
								severity: input.policy.severity,
								threshold: input.policy.minOccurrenceCount,
								count: incident.occurrenceCount,
							}),
						)
					}
				}
			}
		}

		if (events.length > 0) await tx.insert(errorIssueEvents).values(events)
		if (notifications.length > 0) {
			await tx
				.insert(errorNotificationDeliveries)
				.values(notifications)
				.onConflictDoNothing({
					target: [
						errorNotificationDeliveries.deliveryKey,
						errorNotificationDeliveries.destinationId,
					],
				})
		}

		const advanced = await tx
			.update(errorTickStates)
			.set({
				processedThrough: windowEnd,
				bootstrapCompleted: true,
				claimToken: null,
				claimExpiresAt: null,
				updatedAt: windowEnd,
			})
			.where(
				and(eq(errorTickStates.orgId, input.orgId), eq(errorTickStates.claimToken, input.claimToken)),
			)
			.returning({ orgId: errorTickStates.orgId })
		if (advanced.length === 0) throw new ErrorTickClaimLost(input.orgId, "checkpoint")

		return {
			issuesTouched: observed.length,
			incidentsOpened,
			incidentsResolved,
			pendingTriages,
		}
	})
