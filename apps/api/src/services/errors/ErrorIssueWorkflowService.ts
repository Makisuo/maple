import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ActorNotFoundError,
	ErrorIssueDocument,
	ErrorIssueEventId as ErrorIssueEventIdSchema,
	ErrorIssueEventDocument,
	ErrorIssueEventsResponse,
	type ErrorIssueEventType,
	type ErrorIssueId,
	ErrorIssueLeaseConflictError,
	ErrorIssueNotFoundError,
	ErrorIssueTransitionError,
	ErrorPersistenceError,
	IssueEscalationId as IssueEscalationIdSchema,
	type IssueSeverity,
	type IssueSeveritySource,
	type OrgId,
	type WorkflowState,
	WORKFLOW_TRANSITIONS,
	TERMINAL_WORKFLOW_STATES,
} from "@maple/domain/http"
import {
	alertIncidents,
	errorIncidents,
	errorIssues,
	errorIssueEvents,
	errorIssueStates,
	type ErrorIssueEventInsert,
	type ErrorIssueEventRow,
	type ErrorIssueRow,
	issueEscalations,
} from "@maple/db"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { readTxid, txidColumn } from "@/platform/electric-txid"
import { dateToMs, msToDate } from "@/platform/time"
import { ErrorActorsService } from "./ErrorActorsService"
import { makeErrorDatabaseExecute } from "./error-persistence"
import { escalationDedupeKey, escalationReasonFor } from "./issue-severity"

const StoredJsonRecord = Schema.Record(Schema.String, Schema.Unknown)
type StoredJsonRecord = typeof StoredJsonRecord.Type

const decodeStoredJsonRecord = Schema.decodeUnknownOption(StoredJsonRecord)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIssueEscalationIdSync = Schema.decodeUnknownSync(IssueEscalationIdSchema)
const decodeIssueDateTimeSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)

const DEFAULT_EVENTS_LIMIT = 100
const DEFAULT_LEASE_DURATION_MS = 30 * 60_000

export interface ErrorIssueWorkflowPublicApi {
	readonly heartbeatIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueLeaseConflictError
	>
	readonly releaseIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		opts?: { readonly transitionTo?: WorkflowState; readonly note?: string },
	) => Effect.Effect<
		ErrorIssueDocument,
		| ErrorPersistenceError
		| ErrorIssueNotFoundError
		| ErrorIssueLeaseConflictError
		| ErrorIssueTransitionError
	>
	readonly assignIssue: (
		orgId: OrgId,
		byActorId: ActorId,
		issueId: ErrorIssueId,
		toActorId: ActorId | null,
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ActorNotFoundError
	>
	readonly setSeverity: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		severity: IssueSeverity | null,
		opts?: { readonly note?: string; readonly source?: "ai" | "manual" },
	) => Effect.Effect<ErrorIssueDocument, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly commentOnIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		body: string,
		opts?: {
			readonly visibility?: "internal" | "public"
			readonly kind?: "comment" | "agent_note"
		},
	) => Effect.Effect<ErrorIssueEventDocument, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly listIssueEvents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		opts?: { readonly limit?: number },
	) => Effect.Effect<ErrorIssueEventsResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
}

/** Internal workflow kernel shared with the compatibility facade's broad operations and tick. */
export interface ErrorIssueWorkflowServiceApi extends ErrorIssueWorkflowPublicApi {
	readonly rowToIssue: (
		row: ErrorIssueRow,
		hasOpenIncident: boolean,
		actorMap: Map<ActorId, ActorDocument>,
	) => ErrorIssueDocument
	readonly requireIssue: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIssueRow, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly issuesWithOpenIncidents: (
		orgId: OrgId,
		issueIds: ReadonlyArray<ErrorIssueId>,
	) => Effect.Effect<Set<ErrorIssueId>, ErrorPersistenceError>
	/** Batch issue hydration shared by read models and mutation responses. */
	readonly hydrateIssueRows: (
		orgId: OrgId,
		rows: ReadonlyArray<ErrorIssueRow>,
	) => Effect.Effect<ReadonlyArray<ErrorIssueDocument>, ErrorPersistenceError>
	readonly hydrateIssue: (
		orgId: OrgId,
		row: ErrorIssueRow,
	) => Effect.Effect<ErrorIssueDocument, ErrorPersistenceError>
	readonly recordEvent: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId | null,
		type: ErrorIssueEventType,
		opts?: {
			readonly fromState?: WorkflowState | null
			readonly toState?: WorkflowState | null
			readonly payload?: StoredJsonRecord
			readonly timestamp?: number
		},
	) => Effect.Effect<unknown, ErrorPersistenceError>
	readonly applyTransition: (
		orgId: OrgId,
		actorId: ActorId | null,
		row: ErrorIssueRow,
		toState: WorkflowState,
		opts?: {
			readonly note?: string
			readonly snoozeUntilMs?: number | null
			readonly timestamp?: number
			readonly payload?: StoredJsonRecord
		},
	) => Effect.Effect<
		ErrorIssueRow,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueTransitionError
	>
}

const make: Effect.Effect<ErrorIssueWorkflowServiceApi, never, Database | ErrorActorsService> = Effect.gen(
	function* () {
		const database = yield* Database
		const actors = yield* ErrorActorsService
		const dbExecute = makeErrorDatabaseExecute(database, "ErrorIssueWorkflowService")

		const newEventId = () => decodeEventIdSync(randomUUID())
		const newIssueEscalationId = () => decodeIssueEscalationIdSync(randomUUID())
		const isoFromDate = (date: Date) => decodeIssueDateTimeSync(date.toISOString())

		const parseSourceRef = (json: unknown): StoredJsonRecord | null => {
			if (json == null) return null
			return Option.match(decodeStoredJsonRecord(json), {
				onNone: () => null,
				onSome: (parsed) => ({ ...parsed }),
			})
		}

		const rowToIssue: ErrorIssueWorkflowServiceApi["rowToIssue"] = (row, hasOpenIncident, actorMap) =>
			new ErrorIssueDocument({
				id: row.id,
				kind: row.kind,
				fingerprintHash: row.fingerprintHash,
				serviceName: row.serviceName,
				exceptionType: row.exceptionType,
				exceptionMessage: row.exceptionMessage,
				errorLabel: row.errorLabel,
				topFrame: row.topFrame,
				workflowState: row.workflowState,
				priority: row.priority,
				severity: row.severity ?? null,
				severitySource: row.severitySource ?? null,
				sourceRef: parseSourceRef(row.sourceRefJson),
				assignedActor:
					row.assignedActorId == null ? null : (actorMap.get(row.assignedActorId) ?? null),
				leaseHolder:
					row.leaseHolderActorId == null ? null : (actorMap.get(row.leaseHolderActorId) ?? null),
				leaseExpiresAt: row.leaseExpiresAt == null ? null : isoFromDate(row.leaseExpiresAt),
				claimedAt: row.claimedAt == null ? null : isoFromDate(row.claimedAt),
				notes: row.notes ?? null,
				firstSeenAt: isoFromDate(row.firstSeenAt),
				lastSeenAt: isoFromDate(row.lastSeenAt),
				occurrenceCount: row.occurrenceCount,
				resolvedAt: row.resolvedAt == null ? null : isoFromDate(row.resolvedAt),
				lastResolvedAt: row.lastResolvedAt == null ? null : isoFromDate(row.lastResolvedAt),
				lastRegressedAt: row.lastRegressedAt == null ? null : isoFromDate(row.lastRegressedAt),
				regressionCount: row.regressionCount,
				resolvedVersions: row.resolvedVersionsJson,
				snoozeUntil: row.snoozeUntil == null ? null : isoFromDate(row.snoozeUntil),
				archivedAt: row.archivedAt == null ? null : isoFromDate(row.archivedAt),
				hasOpenIncident,
			})

		const rowToEvent = (
			row: ErrorIssueEventRow,
			actorMap: Map<ActorId, ActorDocument>,
		): ErrorIssueEventDocument =>
			new ErrorIssueEventDocument({
				id: row.id,
				issueId: row.issueId,
				actor: row.actorId == null ? null : (actorMap.get(row.actorId) ?? null),
				type: row.type,
				fromState: row.fromState ?? null,
				toState: row.toState ?? null,
				payload: Option.match(decodeStoredJsonRecord(row.payloadJson), {
					onNone: (): StoredJsonRecord => ({}),
					onSome: (parsed) => ({ ...parsed }),
				}),
				createdAt: isoFromDate(row.createdAt),
			})

		const requireIssue: ErrorIssueWorkflowServiceApi["requireIssue"] = Effect.fn(
			"ErrorsService.requireIssue",
		)(function* (orgId, issueId) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
					.limit(1),
			)
			const row = rows[0]
			if (!row) {
				return yield* Effect.fail(
					new ErrorIssueNotFoundError({
						message: "Error issue not found",
						issueId,
					}),
				)
			}
			return row
		})

		const issuesWithOpenIncidents: ErrorIssueWorkflowServiceApi["issuesWithOpenIncidents"] = (
			orgId,
			issueIds,
		) => {
			if (issueIds.length === 0) return Effect.succeed(new Set<ErrorIssueId>())
			return Effect.all([
				dbExecute((db) =>
					db
						.select({ issueId: errorIncidents.issueId })
						.from(errorIncidents)
						.where(
							and(
								eq(errorIncidents.orgId, orgId),
								eq(errorIncidents.status, "open"),
								inArray(errorIncidents.issueId, issueIds),
							),
						),
				),
				dbExecute((db) =>
					db
						.select({ issueId: alertIncidents.errorIssueId })
						.from(alertIncidents)
						.where(
							and(
								eq(alertIncidents.orgId, orgId),
								eq(alertIncidents.status, "open"),
								inArray(alertIncidents.errorIssueId, issueIds),
							),
						),
				),
			]).pipe(
				Effect.map(
					([errorRows, alertRows]) =>
						new Set([
							...errorRows.map((row) => row.issueId),
							...alertRows.flatMap((row) =>
								row.issueId == null ? [] : [row.issueId as ErrorIssueId],
							),
						]),
				),
			)
		}

		const hydrateIssueRows: ErrorIssueWorkflowServiceApi["hydrateIssueRows"] = (orgId, rows) =>
			Effect.gen(function* () {
				if (rows.length === 0) return []
				const openSet = yield* issuesWithOpenIncidents(
					orgId,
					rows.map((row) => row.id),
				)
				const actorMap = yield* actors.collectActorDocs(
					orgId,
					rows.flatMap((row) => [row.assignedActorId ?? null, row.leaseHolderActorId ?? null]),
				)
				return rows.map((row) => rowToIssue(row, openSet.has(row.id), actorMap))
			})

		const hydrateIssue: ErrorIssueWorkflowServiceApi["hydrateIssue"] = Effect.fn(
			"ErrorsService.hydrateIssue",
		)(function* (orgId, row) {
			const hydrated = yield* hydrateIssueRows(orgId, [row])
			return hydrated[0]!
		})

		const recordEvent: ErrorIssueWorkflowServiceApi["recordEvent"] = Effect.fn(
			"ErrorsService.recordEvent",
		)(function* (orgId, issueId, actorId, type, opts = {}) {
			const timestamp = opts.timestamp ?? (yield* Clock.currentTimeMillis)
			const insert: ErrorIssueEventInsert = {
				id: newEventId(),
				orgId,
				issueId,
				actorId: actorId ?? null,
				type,
				fromState: opts.fromState ?? null,
				toState: opts.toState ?? null,
				payloadJson: opts.payload ?? {},
				createdAt: msToDate(timestamp),
			}
			return yield* dbExecute((db) => db.insert(errorIssueEvents).values(insert))
		})

		const validateTransition = (issueId: ErrorIssueId, from: WorkflowState, to: WorkflowState) => {
			if (!WORKFLOW_TRANSITIONS[from].includes(to)) {
				return Effect.fail(
					new ErrorIssueTransitionError({
						message: `Illegal transition from '${from}' to '${to}'`,
						issueId,
						fromState: from,
						toState: to,
					}),
				)
			}
			return Effect.void
		}

		const applyTransition: ErrorIssueWorkflowServiceApi["applyTransition"] = Effect.fn(
			"ErrorsService.applyTransition",
		)(function* (orgId, actorId, row, toState, opts = {}) {
			const timestamp = opts.timestamp ?? (yield* Clock.currentTimeMillis)
			const fromState = row.workflowState
			if (fromState === toState) return row
			yield* validateTransition(row.id, fromState, toState)

			const update: Partial<ErrorIssueRow> = {
				workflowState: toState,
				updatedAt: msToDate(timestamp),
			}
			if (toState === "done") {
				update.resolvedAt = msToDate(timestamp)
				update.resolvedByActorId = actorId ?? null
				// Survives the next reopen, so a regressed issue can still show when it
				// was last fixed instead of looking untouched.
				update.lastResolvedAt = msToDate(timestamp)
				// Snapshot the builds this issue has been seen from. Occurrences from
				// any of them afterwards are old clients still running the broken
				// build, not a regression — see `isRegression` in
				// error-tick-persistence.ts. Without this, `maple-cli` issues could
				// never stay fixed: every binary already installed keeps reporting the
				// bug for as long as it is in use.
				update.resolvedVersionsJson = row.seenVersionsJson
			} else if (fromState === "done") {
				update.resolvedAt = null
				update.resolvedByActorId = null
			}
			if (toState === "wontfix") {
				if (opts.snoozeUntilMs !== undefined) update.snoozeUntil = msToDate(opts.snoozeUntilMs)
			} else if (fromState === "wontfix") {
				update.snoozeUntil = null
			}
			if (TERMINAL_WORKFLOW_STATES.has(toState)) {
				// Reaching a terminal state ends the work, so the lease ends with it.
				update.leaseHolderActorId = null
				update.leaseExpiresAt = null
				update.claimedAt = null
			} else if (actorId !== null && actorId !== undefined && row.leaseHolderActorId === actorId) {
				// Still working, and just proved it. Folded into this same UPDATE rather
				// than issued separately — the row is already being written.
				const previous = dateToMs(row.leaseExpiresAt) ?? timestamp
				update.leaseExpiresAt = msToDate(
					timestamp +
						Math.max(DEFAULT_LEASE_DURATION_MS, previous - (dateToMs(row.claimedAt) ?? previous)),
				)
			}

			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set(update)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, row.id))),
			)
			if (toState === "done") {
				yield* dbExecute((db) =>
					db
						.update(errorIncidents)
						.set({
							status: "resolved",
							resolvedAt: msToDate(timestamp),
							updatedAt: msToDate(timestamp),
						})
						.where(
							and(
								eq(errorIncidents.orgId, orgId),
								eq(errorIncidents.issueId, row.id),
								eq(errorIncidents.status, "open"),
							),
						),
				)
				yield* dbExecute((db) =>
					db
						.update(errorIssueStates)
						.set({ openIncidentId: null, updatedAt: msToDate(timestamp) })
						.where(and(eq(errorIssueStates.orgId, orgId), eq(errorIssueStates.issueId, row.id))),
				)
			}

			const notePayload: StoredJsonRecord = opts.note
				? { ...opts.payload, note: opts.note }
				: { ...opts.payload }
			yield* recordEvent(orgId, row.id, actorId, "state_change", {
				fromState,
				toState,
				payload: notePayload,
				timestamp,
			})
			if (actorId) yield* actors.touchActor(orgId, actorId, timestamp)
			return yield* requireIssue(orgId, row.id)
		})

		const leaseConflict = (issueId: ErrorIssueId, row: ErrorIssueRow | null) =>
			new ErrorIssueLeaseConflictError({
				message: "Issue is held by another actor",
				issueId,
				currentHolderActorId: row?.leaseHolderActorId ?? null,
				leaseExpiresAt: row?.leaseExpiresAt == null ? null : isoFromDate(row.leaseExpiresAt),
			})

		const heartbeatIssue: ErrorIssueWorkflowServiceApi["heartbeatIssue"] = Effect.fn(
			"ErrorsService.heartbeatIssue",
		)(function* (orgId, actorId, issueId) {
			const timestamp = yield* Clock.currentTimeMillis
			const current = yield* requireIssue(orgId, issueId)
			if (current.leaseHolderActorId !== actorId) {
				return yield* Effect.fail(leaseConflict(issueId, current))
			}
			const previous = dateToMs(current.leaseExpiresAt) ?? timestamp
			const leaseMs = Math.max(
				DEFAULT_LEASE_DURATION_MS,
				previous - (dateToMs(current.claimedAt) ?? previous),
			)
			const leaseExpiresAt = timestamp + leaseMs
			const heartbeatRows = yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({
						leaseExpiresAt: msToDate(leaseExpiresAt),
						updatedAt: msToDate(timestamp),
					})
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.id, issueId),
							eq(errorIssues.leaseHolderActorId, actorId),
						),
					)
					.returning(txidColumn),
			)
			yield* actors.touchActor(orgId, actorId, timestamp)
			const next = yield* requireIssue(orgId, issueId)
			const doc = yield* hydrateIssue(orgId, next)
			const txid = readTxid(heartbeatRows)
			return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
		})

		/**
		 * Push the lease deadline out because the holder is demonstrably still working.
		 *
		 * A lease used to expire on wall-clock time alone, renewable only by an explicit
		 * `heartbeat` call — and in practice nothing ever called it: agents claimed
		 * issues, worked them, and let the lease lapse, dropping the issue back to
		 * `todo` underneath them. Any mutating action by the holder is better evidence
		 * of liveness than a separate call the agent has to remember to make.
		 *
		 * Silent by design: a no-op for a non-holder (the caller's own conflict check
		 * owns that decision) and never a reason to fail the action it accompanies.
		 */
		const refreshLeaseIfHolder = Effect.fn("ErrorsService.refreshLeaseIfHolder")(function* (
			orgId: OrgId,
			actorId: ActorId,
			issueId: ErrorIssueId,
			current: ErrorIssueRow,
			timestamp: number,
		) {
			if (current.leaseHolderActorId !== actorId) return
			const previous = dateToMs(current.leaseExpiresAt) ?? timestamp
			// Preserve the lease LENGTH the holder originally asked for, exactly as
			// `heartbeatIssue` does — a claim with a 2h lease should keep renewing at 2h.
			const leaseMs = Math.max(
				DEFAULT_LEASE_DURATION_MS,
				previous - (dateToMs(current.claimedAt) ?? previous),
			)
			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ leaseExpiresAt: msToDate(timestamp + leaseMs) })
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.id, issueId),
							eq(errorIssues.leaseHolderActorId, actorId),
						),
					),
			)
		})

		const releaseIssue: ErrorIssueWorkflowServiceApi["releaseIssue"] = Effect.fn(
			"ErrorsService.releaseIssue",
		)(function* (orgId, actorId, issueId, opts) {
			const timestamp = yield* Clock.currentTimeMillis
			const current = yield* requireIssue(orgId, issueId)
			if (current.leaseHolderActorId !== null && current.leaseHolderActorId !== actorId) {
				return yield* Effect.fail(leaseConflict(issueId, current))
			}
			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({
						leaseHolderActorId: null,
						leaseExpiresAt: null,
						claimedAt: null,
						updatedAt: msToDate(timestamp),
					})
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId))),
			)
			yield* recordEvent(orgId, issueId, actorId, "release", {
				payload: opts?.note ? { note: opts.note } : {},
				timestamp,
			})
			const target: WorkflowState =
				opts?.transitionTo ??
				(current.workflowState === "in_progress" ? "todo" : current.workflowState)
			let next = yield* requireIssue(orgId, issueId)
			if (target !== next.workflowState) {
				next = yield* applyTransition(orgId, actorId, next, target, {
					payload: { viaRelease: true },
					timestamp,
				})
			}
			yield* actors.touchActor(orgId, actorId, timestamp)
			return yield* hydrateIssue(orgId, next)
		})

		const assignIssue: ErrorIssueWorkflowServiceApi["assignIssue"] = Effect.fn(
			"ErrorsService.assignIssue",
		)(function* (orgId, byActorId, issueId, toActorId) {
			const timestamp = yield* Clock.currentTimeMillis
			const current = yield* requireIssue(orgId, issueId)
			if (toActorId !== null && !(yield* actors.actorExists(orgId, toActorId))) {
				return yield* Effect.fail(
					new ActorNotFoundError({
						message: `Actor '${toActorId}' not found`,
						actorId: toActorId,
					}),
				)
			}
			const assignedRows = yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ assignedActorId: toActorId, updatedAt: msToDate(timestamp) })
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
					.returning(txidColumn),
			)
			yield* recordEvent(orgId, issueId, byActorId, "assignment", {
				payload: { fromActorId: current.assignedActorId, toActorId },
				timestamp,
			})
			yield* actors.touchActor(orgId, byActorId, timestamp)
			const next = yield* requireIssue(orgId, issueId)
			const doc = yield* hydrateIssue(orgId, next)
			const txid = readTxid(assignedRows)
			return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
		})

		const enqueueSeverityEscalation = Effect.fn("ErrorsService.enqueueSeverityEscalation")(function* (
			orgId: OrgId,
			issueId: ErrorIssueId,
			from: IssueSeverity | null,
			to: IssueSeverity,
			source: "ai" | "manual",
		) {
			const reason = escalationReasonFor(from, to)
			if (reason === null) return
			const timestamp = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db
					.insert(issueEscalations)
					.values({
						id: newIssueEscalationId(),
						orgId,
						issueId,
						severity: to,
						source,
						reason,
						runId: null,
						investigationId: null,
						payloadJson: {},
						deliveryResultsJson: [],
						status: "queued",
						attempts: 0,
						dedupeKey: escalationDedupeKey(orgId, issueId, to),
						error: null,
						createdAt: msToDate(timestamp),
						processedAt: null,
					})
					.onConflictDoNothing(),
			)
		})

		const setSeverity: ErrorIssueWorkflowServiceApi["setSeverity"] = Effect.fn(
			"ErrorsService.setSeverity",
		)(function* (orgId, actorId, issueId, severity, opts) {
			const timestamp = yield* Clock.currentTimeMillis
			const source = opts?.source ?? "manual"
			yield* Effect.annotateCurrentSpan({
				orgId,
				issueId,
				severity: severity ?? "null",
				source,
			})
			const current = yield* requireIssue(orgId, issueId)
			if (source === "ai" && current.severitySource === "manual") {
				return yield* hydrateIssue(orgId, current)
			}
			yield* refreshLeaseIfHolder(orgId, actorId, issueId, current, timestamp)
			const nextSource: IssueSeveritySource | null = severity === null ? null : source
			const changed = current.severity !== severity || current.severitySource !== nextSource
			if (!changed) return yield* hydrateIssue(orgId, current)

			const severityRows = yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({
						severity,
						severitySource: nextSource,
						updatedAt: msToDate(timestamp),
					})
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
					.returning(txidColumn),
			)
			if (current.severity !== severity) {
				const payload: StoredJsonRecord = opts?.note
					? { from: current.severity, to: severity, source, note: opts.note }
					: { from: current.severity, to: severity, source }
				yield* recordEvent(orgId, issueId, actorId, "severity_change", {
					payload,
					timestamp,
				})
			}
			if (severity !== null) {
				yield* enqueueSeverityEscalation(orgId, issueId, current.severity, severity, source)
			}
			yield* actors.touchActor(orgId, actorId, timestamp)
			const next = yield* requireIssue(orgId, issueId)
			const doc = yield* hydrateIssue(orgId, next)
			const txid = readTxid(severityRows)
			return txid === undefined ? doc : new ErrorIssueDocument({ ...doc, txid })
		})

		const commentOnIssue: ErrorIssueWorkflowServiceApi["commentOnIssue"] = Effect.fn(
			"ErrorsService.commentOnIssue",
		)(function* (orgId, actorId, issueId, body, opts) {
			const timestamp = yield* Clock.currentTimeMillis
			const current = yield* requireIssue(orgId, issueId)
			yield* refreshLeaseIfHolder(orgId, actorId, issueId, current, timestamp)
			const type: ErrorIssueEventType = opts?.kind === "agent_note" ? "agent_note" : "comment"
			const payload: StoredJsonRecord = {
				body,
				visibility: opts?.visibility ?? "internal",
			}
			const id = newEventId()
			const row: ErrorIssueEventRow = {
				id,
				orgId,
				issueId,
				actorId,
				type,
				fromState: null,
				toState: null,
				payloadJson: payload,
				createdAt: msToDate(timestamp),
			}
			yield* dbExecute((db) => db.insert(errorIssueEvents).values(row))
			yield* actors.touchActor(orgId, actorId, timestamp)
			const actorMap = yield* actors.collectActorDocs(orgId, [actorId])
			return rowToEvent(row, actorMap)
		})

		const listIssueEvents: ErrorIssueWorkflowServiceApi["listIssueEvents"] = Effect.fn(
			"ErrorsService.listIssueEvents",
		)(function* (orgId, issueId, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId })
			yield* requireIssue(orgId, issueId)
			const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_EVENTS_LIMIT, 1), 500)
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssueEvents)
					.where(and(eq(errorIssueEvents.orgId, orgId), eq(errorIssueEvents.issueId, issueId)))
					.orderBy(desc(errorIssueEvents.createdAt))
					.limit(limit),
			)
			const actorMap = yield* actors.collectActorDocs(
				orgId,
				rows.map((row) => row.actorId ?? null),
			)
			return new ErrorIssueEventsResponse({
				events: rows.map((row) => rowToEvent(row, actorMap)),
			})
		})

		return ErrorIssueWorkflowService.of({
			rowToIssue,
			requireIssue,
			issuesWithOpenIncidents,
			hydrateIssueRows,
			hydrateIssue,
			recordEvent,
			applyTransition,
			heartbeatIssue,
			releaseIssue,
			assignIssue,
			setSeverity,
			commentOnIssue,
			listIssueEvents,
		})
	},
)

export class ErrorIssueWorkflowService extends Context.Service<
	ErrorIssueWorkflowService,
	ErrorIssueWorkflowServiceApi
>()("@maple/api/services/errors/ErrorIssueWorkflowService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
