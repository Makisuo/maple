import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ActorId as ActorIdSchema,
	ActorNotFoundError,
	type ActorType,
	ActorsListResponse,
	type AlertDestinationId,
	type AlertSeverity,
	ErrorIncidentDocument,
	ErrorIncidentsListResponse,
	type ErrorIncidentReason,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	type ErrorIssueEventId,
	ErrorIssueEventId as ErrorIssueEventIdSchema,
	ErrorIssueEventDocument,
	ErrorIssueEventsResponse,
	type ErrorIssueEventType,
	type ErrorIssueId,
	ErrorIssueLeaseConflictError,
	ErrorIssueNotFoundError,
	ErrorIssueSampleTrace,
	ErrorIssueTransitionError,
	ErrorIssuesListResponse,
	ErrorIssueTimeseriesPoint,
	ErrorNotificationPolicyDocument,
	type ErrorNotificationPolicyUpsertRequest,
	ErrorPersistenceError,
	ErrorValidationError,
	type OrgId,
	RoleName,
	SpanId as SpanIdSchema,
	TraceId as TraceIdSchema,
	type UserId,
	UserId as UserIdSchema,
	type WorkflowState,
} from "@maple/domain/http"
import {
	actors,
	type ActorInsert,
	type ActorRow,
	errorIncidents,
	type ErrorIncidentRow,
	errorIssues,
	errorIssueEvents,
	type ErrorIssueEventInsert,
	type ErrorIssueEventRow,
	type ErrorIssueRow,
	errorIssueStates,
	errorNotificationPolicies,
	type ErrorNotificationPolicyRow,
	orgIngestKeys,
} from "@maple/db"
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { CH } from "@maple/query-engine"
import { Array as Arr, Cause, Context, Effect, Layer, Schedule, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { Database, DatabaseError, type DatabaseClient } from "./DatabaseLive"
import { Env } from "./Env"
import { NotificationDispatcher } from "./NotificationDispatcher"
import { WarehouseQueryService } from "./WarehouseQueryService"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeActorIdSync = Schema.decodeUnknownSync(ActorIdSchema)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeTraceIdSync = Schema.decodeUnknownSync(TraceIdSchema)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanIdSchema)

const DEFAULT_LIST_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_EVENTS_LIMIT = 100
const AUTO_RESOLVE_MINUTES = 30
const TICK_WINDOW_MS = 2 * 60_000
const RESOLVED_RETENTION_DAYS = 14
const ARCHIVED_RETENTION_DAYS = 90
const RETENTION_PHASE_EVERY_N_TICKS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEASE_DURATION_MS = 30 * 60_000
const SYSTEM_AGENT_NAME = "system-errors-tick"
const D1_INARRAY_CHUNK_SIZE = 90

export const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

export const makePersistenceError = (error: unknown): ErrorPersistenceError => {
	const baseFor = (message: string, raw: unknown) => {
		const cause = describeCause(raw)
		return cause === undefined ? { message } : { message, cause }
	}
	if (error instanceof DatabaseError) {
		return new ErrorPersistenceError(baseFor(error.message, error.cause))
	}
	if (error instanceof Error) {
		return new ErrorPersistenceError(baseFor(error.message, error.cause))
	}
	return new ErrorPersistenceError(baseFor("Error persistence failure", error))
}

// Concurrent ticks against D1 (file-locked SQLite under the hood) occasionally surface
// busy/locked errors. They're harmless to retry — the next attempt usually succeeds in
// ms. Only this predicate's match retries; anything else fails fast.
const BUSY_ERROR_PATTERN = /SQLITE_BUSY|database is locked|D1_BUSY|busy/i

const causeMessage = (cause: unknown): string | undefined => {
	if (cause instanceof Error) return cause.message
	if (typeof cause === "string") return cause
	return undefined
}

export const isBusyDatabaseError = (error: DatabaseError): boolean => {
	if (BUSY_ERROR_PATTERN.test(error.message)) return true
	const inner = causeMessage(error.cause)
	if (inner && BUSY_ERROR_PATTERN.test(inner)) return true
	return false
}

const BUSY_RETRY_SCHEDULE = Schedule.exponential("50 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(3)),
)

// ---------------------------------------------------------------------------
// Transition matrix. Rows = from, values = set of allowed "to" states.
// ---------------------------------------------------------------------------
const TRANSITIONS: Record<WorkflowState, ReadonlySet<WorkflowState>> = {
	triage: new Set<WorkflowState>(["todo", "in_progress", "cancelled", "wontfix"]),
	todo: new Set<WorkflowState>(["triage", "in_progress", "cancelled", "wontfix"]),
	in_progress: new Set<WorkflowState>(["triage", "todo", "in_review", "cancelled", "wontfix"]),
	in_review: new Set<WorkflowState>(["triage", "in_progress", "done", "cancelled", "wontfix"]),
	done: new Set<WorkflowState>(["triage", "in_progress", "cancelled", "wontfix"]),
	cancelled: new Set<WorkflowState>(),
	wontfix: new Set<WorkflowState>(["triage", "cancelled"]),
}

const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set(["done", "cancelled"])

export interface ErrorsServiceShape {
	readonly listIssues: (
		orgId: OrgId,
		opts: {
			readonly workflowState?: WorkflowState
			readonly service?: string
			readonly deploymentEnv?: string
			readonly assignedActorId?: ActorId
			readonly includeArchived?: boolean
			readonly startTime?: string
			readonly endTime?: string
			readonly limit?: number
		},
	) => Effect.Effect<ErrorIssuesListResponse, ErrorPersistenceError>
	readonly getIssue: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		opts: {
			readonly startTime?: string
			readonly endTime?: string
			readonly bucketSeconds?: number
			readonly sampleLimit?: number
		},
	) => Effect.Effect<ErrorIssueDetailResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly transitionIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		toState: WorkflowState,
		opts?: { readonly note?: string; readonly snoozeUntil?: string | null },
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueTransitionError | ErrorValidationError
	>
	readonly claimIssue: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		leaseDurationMs?: number,
	) => Effect.Effect<
		ErrorIssueDocument,
		| ErrorPersistenceError
		| ErrorIssueNotFoundError
		| ErrorIssueLeaseConflictError
		| ErrorIssueTransitionError
	>
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
	readonly proposeFix: (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		request: {
			readonly patchSummary: string
			readonly prUrl?: string
			readonly artifacts?: ReadonlyArray<string>
		},
	) => Effect.Effect<
		ErrorIssueDocument,
		ErrorPersistenceError | ErrorIssueNotFoundError | ErrorIssueTransitionError
	>
	readonly listIssueEvents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		opts?: { readonly limit?: number },
	) => Effect.Effect<ErrorIssueEventsResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly registerAgent: (
		orgId: OrgId,
		byUserId: UserId,
		request: {
			readonly name: string
			readonly model?: string
			readonly capabilities?: ReadonlyArray<string>
		},
	) => Effect.Effect<ActorDocument, ErrorPersistenceError | ErrorValidationError>
	readonly listAgents: (orgId: OrgId) => Effect.Effect<ActorsListResponse, ErrorPersistenceError>
	readonly lookupActor: (
		orgId: OrgId,
		actorId: ActorId,
	) => Effect.Effect<ActorDocument, ErrorPersistenceError | ActorNotFoundError>
	readonly ensureUserActor: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<ActorDocument, ErrorPersistenceError>
	readonly listIssueIncidents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly listOpenIncidents: (
		orgId: OrgId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError>
	readonly getNotificationPolicy: (
		orgId: OrgId,
	) => Effect.Effect<ErrorNotificationPolicyDocument, ErrorPersistenceError>
	readonly upsertNotificationPolicy: (
		orgId: OrgId,
		userId: UserId,
		request: ErrorNotificationPolicyUpsertRequest,
	) => Effect.Effect<ErrorNotificationPolicyDocument, ErrorPersistenceError | ErrorValidationError>
	readonly runTick: () => Effect.Effect<
		{
			readonly orgsProcessed: number
			readonly issuesTouched: number
			readonly incidentsOpened: number
			readonly incidentsResolved: number
			readonly issuesReopened: number
			readonly issuesArchived: number
			readonly issuesDeleted: number
			readonly leasesExpired: number
			readonly retentionRan: boolean
		},
		ErrorPersistenceError
	>
}

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceShape>()("ErrorsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService
		const env = yield* Env
		const dispatcher = yield* NotificationDispatcher

		const now = () => Date.now()
		const newErrorIssueId = () => decodeErrorIssueIdSync(randomUUID())
		const newErrorIncidentId = () => decodeErrorIncidentIdSync(randomUUID())
		const newActorId = () => decodeActorIdSync(randomUUID())
		const newEventId = () => decodeEventIdSync(randomUUID())

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(
				Effect.retry({
					schedule: BUSY_RETRY_SCHEDULE,
					while: isBusyDatabaseError,
				}),
				Effect.tapError((error) =>
					Effect.logError("ErrorsService dbExecute failed").pipe(
						Effect.annotateLogs({
							message: error.message,
							cause: describeCause(error.cause) ?? "(none)",
						}),
					),
				),
				Effect.mapError(makePersistenceError),
			)

		const toTinybirdDateTime = (epochMs: number) =>
			new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

		const isoFromEpoch = (ms: number) => decodeIsoDateTimeStringSync(new Date(ms).toISOString())

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-errors"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		// ---------------------------------------------------------------
		// Actors
		// ---------------------------------------------------------------

		const parseCapabilities = (raw: string): ReadonlyArray<string> => {
			try {
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return []
				return parsed.filter((v): v is string => typeof v === "string")
			} catch {
				return []
			}
		}

		const rowToActor = (row: ActorRow): ActorDocument =>
			new ActorDocument({
				id: row.id,
				type: row.type,
				userId: row.userId ?? null,
				agentName: row.agentName ?? null,
				model: row.model ?? null,
				capabilities: parseCapabilities(row.capabilitiesJson),
				lastActiveAt: row.lastActiveAt == null ? null : isoFromEpoch(row.lastActiveAt),
			})

		const selectActorRow = (orgId: OrgId, actorId: ActorId) =>
			dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.id, actorId)))
					.limit(1),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const lookupActor: ErrorsServiceShape["lookupActor"] = Effect.fn("ErrorsService.lookupActor")(
			function* (orgId, actorId) {
				const row = yield* selectActorRow(orgId, actorId)
				if (!row) {
					return yield* Effect.fail(
						new ActorNotFoundError({
							message: `Actor '${actorId}' not found`,
							actorId,
						}),
					)
				}
				return rowToActor(row)
			},
		)

		const touchActor = (orgId: OrgId, actorId: ActorId, timestamp: number) =>
			dbExecute((db) =>
				db
					.update(actors)
					.set({ lastActiveAt: timestamp })
					.where(and(eq(actors.orgId, orgId), eq(actors.id, actorId))),
			).pipe(Effect.ignore)

		const ensureUserActor: ErrorsServiceShape["ensureUserActor"] = Effect.fn(
			"ErrorsService.ensureUserActor",
		)(function* (orgId, userId) {
			const existing = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "user"), eq(actors.userId, userId)))
					.limit(1),
			)
			if (existing[0]) return rowToActor(existing[0])

			const timestamp = now()
			const id = newActorId()
			const insert: ActorInsert = {
				id,
				orgId,
				type: "user",
				userId,
				agentName: null,
				model: null,
				capabilitiesJson: "[]",
				createdBy: userId,
				createdAt: timestamp,
				lastActiveAt: timestamp,
			}
			yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())
			const after = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "user"), eq(actors.userId, userId)))
					.limit(1),
			)
			const row = after[0]
			if (!row) {
				return yield* Effect.fail(
					new ErrorPersistenceError({
						message: "Failed to ensure user actor row",
					}),
				)
			}
			return rowToActor(row)
		})

		const ensureSystemActor = (orgId: OrgId) =>
			Effect.gen(function* () {
				const existing = yield* dbExecute((db) =>
					db
						.select()
						.from(actors)
						.where(
							and(
								eq(actors.orgId, orgId),
								eq(actors.type, "agent"),
								eq(actors.agentName, SYSTEM_AGENT_NAME),
							),
						)
						.limit(1),
				)
				if (existing[0]) return rowToActor(existing[0])

				const timestamp = now()
				const id = newActorId()
				const insert: ActorInsert = {
					id,
					orgId,
					type: "agent",
					userId: null,
					agentName: SYSTEM_AGENT_NAME,
					model: null,
					capabilitiesJson: JSON.stringify(["system", "auto-triage"]),
					createdBy: null,
					createdAt: timestamp,
					lastActiveAt: timestamp,
				}
				yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())
				const after = yield* dbExecute((db) =>
					db
						.select()
						.from(actors)
						.where(
							and(
								eq(actors.orgId, orgId),
								eq(actors.type, "agent"),
								eq(actors.agentName, SYSTEM_AGENT_NAME),
							),
						)
						.limit(1),
				)
				const row = after[0]
				if (!row) {
					return yield* Effect.fail(
						new ErrorPersistenceError({
							message: "Failed to ensure system actor row",
						}),
					)
				}
				return rowToActor(row)
			})

		const registerAgent: ErrorsServiceShape["registerAgent"] = Effect.fn("ErrorsService.registerAgent")(
			function* (orgId, byUserId, request) {
				const name = request.name.trim()
				if (name.length === 0) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: "Agent name must not be empty",
							details: [request.name],
						}),
					)
				}
				if (name === SYSTEM_AGENT_NAME) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: `Agent name '${SYSTEM_AGENT_NAME}' is reserved`,
							details: [name],
						}),
					)
				}

				const timestamp = now()
				const id = newActorId()
				const capabilities = request.capabilities ?? []
				const insert: ActorInsert = {
					id,
					orgId,
					type: "agent",
					userId: null,
					agentName: name,
					model: request.model ?? null,
					capabilitiesJson: JSON.stringify(capabilities),
					createdBy: byUserId,
					createdAt: timestamp,
					lastActiveAt: timestamp,
				}

				yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())

				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(actors)
						.where(
							and(
								eq(actors.orgId, orgId),
								eq(actors.type, "agent"),
								eq(actors.agentName, name),
							),
						)
						.limit(1),
				)
				const row = rows[0]
				if (!row) {
					return yield* Effect.fail(
						new ErrorPersistenceError({
							message: "Failed to register agent",
						}),
					)
				}
				if (row.id !== id) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: `An agent named '${name}' already exists for this org`,
							details: [name],
						}),
					)
				}
				return rowToActor(row)
			},
		)

		const listAgents: ErrorsServiceShape["listAgents"] = Effect.fn("ErrorsService.listAgents")(
			function* (orgId) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(actors)
						.where(and(eq(actors.orgId, orgId), eq(actors.type, "agent")))
						.orderBy(desc(actors.createdAt)),
				)
				return new ActorsListResponse({
					actors: rows.map(rowToActor),
				})
			},
		)

		// ---------------------------------------------------------------
		// Issue row -> document mapping
		// ---------------------------------------------------------------

		const collectActorDocs = (orgId: OrgId, actorIds: ReadonlyArray<ActorId | null>) => {
			const filtered = Array.from(new Set(actorIds.filter((v): v is ActorId => v != null)))
			if (filtered.length === 0) return Effect.succeed(new Map<ActorId, ActorDocument>())
			return Effect.forEach(Arr.chunksOf(filtered, D1_INARRAY_CHUNK_SIZE), (chunk) =>
				dbExecute((db) =>
					db
						.select()
						.from(actors)
						.where(and(eq(actors.orgId, orgId), inArray(actors.id, chunk))),
				),
			).pipe(
				Effect.map((groups) => {
					const map = new Map<ActorId, ActorDocument>()
					for (const rows of groups) {
						for (const row of rows) map.set(row.id, rowToActor(row))
					}
					return map
				}),
			)
		}

		const rowToIssue = (
			row: ErrorIssueRow,
			hasOpenIncident: boolean,
			actorMap: Map<ActorId, ActorDocument>,
		) =>
			new ErrorIssueDocument({
				id: row.id,
				fingerprintHash: row.fingerprintHash,
				serviceName: row.serviceName,
				exceptionType: row.exceptionType,
				exceptionMessage: row.exceptionMessage,
				topFrame: row.topFrame,
				workflowState: row.workflowState,
				priority: row.priority,
				assignedActor:
					row.assignedActorId == null ? null : (actorMap.get(row.assignedActorId) ?? null),
				leaseHolder:
					row.leaseHolderActorId == null ? null : (actorMap.get(row.leaseHolderActorId) ?? null),
				leaseExpiresAt: row.leaseExpiresAt == null ? null : isoFromEpoch(row.leaseExpiresAt),
				claimedAt: row.claimedAt == null ? null : isoFromEpoch(row.claimedAt),
				notes: row.notes ?? null,
				firstSeenAt: isoFromEpoch(row.firstSeenAt),
				lastSeenAt: isoFromEpoch(row.lastSeenAt),
				occurrenceCount: row.occurrenceCount,
				resolvedAt: row.resolvedAt == null ? null : isoFromEpoch(row.resolvedAt),
				snoozeUntil: row.snoozeUntil == null ? null : isoFromEpoch(row.snoozeUntil),
				archivedAt: row.archivedAt == null ? null : isoFromEpoch(row.archivedAt),
				hasOpenIncident,
			})

		const rowToIncident = (row: ErrorIncidentRow) =>
			new ErrorIncidentDocument({
				id: row.id,
				issueId: row.issueId,
				status: row.status,
				reason: row.reason,
				firstTriggeredAt: isoFromEpoch(row.firstTriggeredAt),
				lastTriggeredAt: isoFromEpoch(row.lastTriggeredAt),
				resolvedAt: row.resolvedAt == null ? null : isoFromEpoch(row.resolvedAt),
				occurrenceCount: row.occurrenceCount,
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
				payload: (() => {
					try {
						const parsed = JSON.parse(row.payloadJson)
						return parsed && typeof parsed === "object" && !Array.isArray(parsed)
							? (parsed as Record<string, unknown>)
							: {}
					} catch {
						return {}
					}
				})(),
				createdAt: isoFromEpoch(row.createdAt),
			})

		const requireIssue = Effect.fn("ErrorsService.requireIssue")(function* (
			orgId: OrgId,
			issueId: ErrorIssueId,
		) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
					.limit(1),
			)
			const row = rows[0]
			if (!row)
				return yield* Effect.fail(
					new ErrorIssueNotFoundError({
						message: "Error issue not found",
						resourceType: "issue",
						resourceId: issueId,
					}),
				)
			return row
		})

		const issuesWithOpenIncidents = (orgId: OrgId, issueIds: ReadonlyArray<ErrorIssueId>) => {
			if (issueIds.length === 0) return Effect.succeed(new Set<ErrorIssueId>())
			return Effect.forEach(Arr.chunksOf(issueIds, D1_INARRAY_CHUNK_SIZE), (chunk) =>
				dbExecute((db) =>
					db
						.select({ issueId: errorIncidents.issueId })
						.from(errorIncidents)
						.where(
							and(
								eq(errorIncidents.orgId, orgId),
								eq(errorIncidents.status, "open"),
								inArray(errorIncidents.issueId, chunk),
							),
						),
				),
			).pipe(Effect.map((groups) => new Set(groups.flatMap((rows) => rows.map((r) => r.issueId)))))
		}

		const hydrateIssue = Effect.fn("ErrorsService.hydrateIssue")(function* (
			orgId: OrgId,
			row: ErrorIssueRow,
		) {
			const openSet = yield* issuesWithOpenIncidents(orgId, [row.id])
			const actorMap = yield* collectActorDocs(orgId, [
				row.assignedActorId ?? null,
				row.leaseHolderActorId ?? null,
			])
			return rowToIssue(row, openSet.has(row.id), actorMap)
		})

		// ---------------------------------------------------------------
		// Events / audit log
		// ---------------------------------------------------------------

		const recordEvent = (
			orgId: OrgId,
			issueId: ErrorIssueId,
			actorId: ActorId | null,
			type: ErrorIssueEventType,
			opts: {
				readonly fromState?: WorkflowState | null
				readonly toState?: WorkflowState | null
				readonly payload?: Record<string, unknown>
				readonly timestamp?: number
			} = {},
		) => {
			const timestamp = opts.timestamp ?? now()
			const insert: ErrorIssueEventInsert = {
				id: newEventId(),
				orgId,
				issueId,
				actorId: actorId ?? null,
				type,
				fromState: opts.fromState ?? null,
				toState: opts.toState ?? null,
				payloadJson: JSON.stringify(opts.payload ?? {}),
				createdAt: timestamp,
			}
			return dbExecute((db) => db.insert(errorIssueEvents).values(insert))
		}

		const listIssueEvents: ErrorsServiceShape["listIssueEvents"] = Effect.fn(
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
			const actorMap = yield* collectActorDocs(
				orgId,
				rows.map((r) => r.actorId ?? null),
			)
			return new ErrorIssueEventsResponse({
				events: rows.map((row) => rowToEvent(row, actorMap)),
			})
		})

		// ---------------------------------------------------------------
		// Issue list + detail
		// ---------------------------------------------------------------

		const listIssues: ErrorsServiceShape["listIssues"] = Effect.fn("ErrorsService.listIssues")(
			function* (orgId, opts) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					workflowState: opts.workflowState ?? "all",
					limit: opts.limit ?? 100,
				})
				const conditions = [eq(errorIssues.orgId, orgId)]
				if (opts.workflowState) conditions.push(eq(errorIssues.workflowState, opts.workflowState))
				if (opts.service) conditions.push(eq(errorIssues.serviceName, opts.service))
				if (opts.assignedActorId)
					conditions.push(eq(errorIssues.assignedActorId, opts.assignedActorId))
				if (!opts.includeArchived) conditions.push(isNull(errorIssues.archivedAt))
				if (opts.endTime) {
					const endMs = Date.parse(opts.endTime)
					if (Number.isFinite(endMs)) conditions.push(lt(errorIssues.firstSeenAt, endMs))
				}
				if (opts.startTime) {
					const startMs = Date.parse(opts.startTime)
					if (Number.isFinite(startMs)) conditions.push(gt(errorIssues.lastSeenAt, startMs))
				}

				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(errorIssues)
						.where(and(...conditions))
						.orderBy(desc(errorIssues.lastSeenAt))
						.limit(opts.limit ?? 100),
				)

				const issueIds = rows.map((r) => r.id)
				const openSet = yield* issuesWithOpenIncidents(orgId, issueIds)
				const actorMap = yield* collectActorDocs(
					orgId,
					rows.flatMap((r) => [r.assignedActorId ?? null, r.leaseHolderActorId ?? null]),
				)

				const issuesResult = rows.map((r) => rowToIssue(r, openSet.has(r.id), actorMap))
				yield* Effect.annotateCurrentSpan("issueCount", issuesResult.length)
				return new ErrorIssuesListResponse({ issues: issuesResult })
			},
		)

		const getIssue: ErrorsServiceShape["getIssue"] = Effect.fn("ErrorsService.getIssue")(
			function* (orgId, issueId, opts) {
				yield* Effect.annotateCurrentSpan({ orgId, issueId })
				const issueRow = yield* requireIssue(orgId, issueId)
				const endMs = opts.endTime ? Date.parse(opts.endTime) : now()
				const startMs = opts.startTime ? Date.parse(opts.startTime) : endMs - DEFAULT_DETAIL_WINDOW_MS
				const bucketSeconds = opts.bucketSeconds ?? 3600
				const sampleLimit = opts.sampleLimit ?? 25

				const tenant = systemTenant(orgId)

				const timeseriesCompiled = CH.compile(CH.errorIssueTimeseriesQuery(), {
					orgId,
					fingerprintHash: issueRow.fingerprintHash,
					startTime: toTinybirdDateTime(startMs),
					endTime: toTinybirdDateTime(endMs),
					bucketSeconds,
				})
				const timeseriesEffect = warehouse
					.sqlQuery(tenant, timeseriesCompiled.sql, { context: "errorIssueTimeseries" })
					.pipe(
						Effect.map((rows) => timeseriesCompiled.castRows(rows)),
						Effect.mapError((e) => makePersistenceError(e)),
					)

				const samplesCompiled = CH.compile(CH.errorIssueSampleTracesQuery({ limit: sampleLimit }), {
					orgId,
					fingerprintHash: issueRow.fingerprintHash,
					startTime: toTinybirdDateTime(startMs),
					endTime: toTinybirdDateTime(endMs),
				})
				const samplesEffect = warehouse
					.sqlQuery(tenant, samplesCompiled.sql, { context: "errorIssueSampleTraces" })
					.pipe(
						Effect.map((rows) => samplesCompiled.castRows(rows)),
						Effect.mapError((e) => makePersistenceError(e)),
					)

				const incidentsEffect = dbExecute((db) =>
					db
						.select()
						.from(errorIncidents)
						.where(and(eq(errorIncidents.orgId, orgId), eq(errorIncidents.issueId, issueId)))
						.orderBy(desc(errorIncidents.lastTriggeredAt))
						.limit(50),
				)

				const [timeseriesRows, sampleRows, incidentRows] = yield* Effect.all(
					[timeseriesEffect, samplesEffect, incidentsEffect],
					{ concurrency: 3 },
				)

				const openSet = yield* issuesWithOpenIncidents(orgId, [issueRow.id])
				const actorMap = yield* collectActorDocs(orgId, [
					issueRow.assignedActorId ?? null,
					issueRow.leaseHolderActorId ?? null,
				])

				const timeseries = timeseriesRows.map(
					(row) =>
						new ErrorIssueTimeseriesPoint({
							bucket: decodeIsoDateTimeStringSync(new Date(String(row.bucket)).toISOString()),
							count: Number(row.count ?? 0),
						}),
				)

				const sampleTraces = sampleRows.map(
					(row) =>
						new ErrorIssueSampleTrace({
							traceId: decodeTraceIdSync(String(row.traceId ?? "")),
							spanId: decodeSpanIdSync(String(row.spanId ?? "")),
							serviceName: String(row.serviceName ?? ""),
							timestamp: decodeIsoDateTimeStringSync(
								new Date(String(row.timestamp)).toISOString(),
							),
							exceptionMessage: String(row.exceptionMessage ?? ""),
							durationMicros: Number(row.durationMicros ?? 0),
						}),
				)

				return new ErrorIssueDetailResponse({
					issue: rowToIssue(issueRow, openSet.has(issueRow.id), actorMap),
					timeseries,
					sampleTraces,
					incidents: incidentRows.map(rowToIncident),
				})
			},
		)

		// ---------------------------------------------------------------
		// State transitions
		// ---------------------------------------------------------------

		const validateTransition = (issueId: ErrorIssueId, from: WorkflowState, to: WorkflowState) => {
			const allowed = TRANSITIONS[from]
			if (!allowed.has(to)) {
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

		const applyTransition = Effect.fn("ErrorsService.applyTransition")(function* (
			orgId: OrgId,
			actorId: ActorId | null,
			row: ErrorIssueRow,
			toState: WorkflowState,
			opts: {
				readonly note?: string
				readonly snoozeUntilMs?: number | null
				readonly timestamp?: number
				readonly payload?: Record<string, unknown>
			} = {},
		) {
			const timestamp = opts.timestamp ?? now()
			const fromState = row.workflowState
			if (fromState === toState) {
				return row
			}
			yield* validateTransition(row.id, fromState, toState)

			const update: Partial<ErrorIssueRow> = {
				workflowState: toState,
				updatedAt: timestamp,
			}

			if (toState === "done") {
				update.resolvedAt = timestamp
				update.resolvedByActorId = actorId ?? null
			} else if (fromState === "done") {
				update.resolvedAt = null
				update.resolvedByActorId = null
			}

			if (toState === "wontfix") {
				if (opts.snoozeUntilMs !== undefined) {
					update.snoozeUntil = opts.snoozeUntilMs
				}
			} else if (fromState === "wontfix") {
				update.snoozeUntil = null
			}

			if (TERMINAL_STATES.has(toState)) {
				update.leaseHolderActorId = null
				update.leaseExpiresAt = null
				update.claimedAt = null
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
							resolvedAt: timestamp,
							updatedAt: timestamp,
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
						.set({ openIncidentId: null, updatedAt: timestamp })
						.where(and(eq(errorIssueStates.orgId, orgId), eq(errorIssueStates.issueId, row.id))),
				)
			}

			const notePayload: Record<string, unknown> = { ...opts.payload }
			if (opts.note) notePayload.note = opts.note

			yield* recordEvent(orgId, row.id, actorId, "state_change", {
				fromState,
				toState,
				payload: notePayload,
				timestamp,
			})

			if (actorId) yield* touchActor(orgId, actorId, timestamp)

			const next = yield* requireIssue(orgId, row.id)
			return next
		})

		const transitionIssue: ErrorsServiceShape["transitionIssue"] = Effect.fn(
			"ErrorsService.transitionIssue",
		)(function* (orgId, actorId, issueId, toState, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId, toState })
			const current = yield* requireIssue(orgId, issueId)

			let snoozeUntilMs: number | null | undefined
			if (opts?.snoozeUntil !== undefined) {
				if (opts.snoozeUntil === null) {
					snoozeUntilMs = null
				} else {
					const parsed = Date.parse(opts.snoozeUntil)
					if (!Number.isFinite(parsed)) {
						return yield* Effect.fail(
							new ErrorValidationError({
								message: "Invalid snoozeUntil timestamp",
								details: [String(opts.snoozeUntil)],
							}),
						)
					}
					snoozeUntilMs = parsed
				}
			}

			const updated = yield* applyTransition(orgId, actorId, current, toState, {
				note: opts?.note,
				snoozeUntilMs,
			})

			yield* maybeNotifyTransition(orgId, actorId, updated, current.workflowState)

			return yield* hydrateIssue(orgId, updated)
		})

		// ---------------------------------------------------------------
		// Claim / lease
		// ---------------------------------------------------------------

		const leaseConflict = (issueId: ErrorIssueId, row: ErrorIssueRow | null) =>
			new ErrorIssueLeaseConflictError({
				message: "Issue is held by another actor",
				issueId,
				currentHolderActorId: row?.leaseHolderActorId ?? null,
				leaseExpiresAt: row?.leaseExpiresAt == null ? null : isoFromEpoch(row.leaseExpiresAt),
			})

		const claimIssue: ErrorsServiceShape["claimIssue"] = Effect.fn("ErrorsService.claimIssue")(
			function* (orgId, actorId, issueId, leaseDurationMs) {
				const timestamp = now()
				const leaseMs = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
				const leaseExpiresAt = timestamp + leaseMs
				yield* Effect.annotateCurrentSpan({ orgId, issueId, actorId, leaseMs })

				const current = yield* requireIssue(orgId, issueId)
				if (TERMINAL_STATES.has(current.workflowState)) {
					return yield* Effect.fail(
						new ErrorIssueTransitionError({
							message: `Cannot claim an issue in state '${current.workflowState}'`,
							issueId,
							fromState: current.workflowState,
							toState: "in_progress",
						}),
					)
				}

				const claimed = yield* dbExecute((db) =>
					db
						.update(errorIssues)
						.set({
							leaseHolderActorId: actorId,
							leaseExpiresAt,
							claimedAt: timestamp,
							updatedAt: timestamp,
						})
						.where(
							and(
								eq(errorIssues.orgId, orgId),
								eq(errorIssues.id, issueId),
								or(
									isNull(errorIssues.leaseHolderActorId),
									eq(errorIssues.leaseHolderActorId, actorId),
									lt(errorIssues.leaseExpiresAt, timestamp),
								),
							),
						)
						.returning(),
				)

				if (claimed.length === 0) {
					const latestRows = yield* dbExecute((db) =>
						db
							.select()
							.from(errorIssues)
							.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
							.limit(1),
					)
					return yield* Effect.fail(leaseConflict(issueId, latestRows[0] ?? null))
				}

				const row = claimed[0]!

				// Move to in_progress if currently in triage/todo.
				let next = row
				if (row.workflowState === "triage" || row.workflowState === "todo") {
					next = yield* applyTransition(orgId, actorId, row, "in_progress", {
						payload: { viaClaim: true },
						timestamp,
					})
				} else {
					yield* recordEvent(orgId, issueId, actorId, "claim", {
						payload: {
							leaseExpiresAt,
							leaseDurationMs: leaseMs,
						},
						timestamp,
					})
					yield* touchActor(orgId, actorId, timestamp)
				}

				if (row.workflowState === "in_progress") {
					// Emit a claim event even on renewal so the audit log shows the pickup.
					yield* recordEvent(orgId, issueId, actorId, "claim", {
						payload: {
							leaseExpiresAt,
							leaseDurationMs: leaseMs,
							renewed: row.leaseHolderActorId === actorId,
						},
						timestamp,
					})
				}

				yield* maybeNotifyClaim(orgId, actorId, next)

				return yield* hydrateIssue(orgId, next)
			},
		)

		const heartbeatIssue: ErrorsServiceShape["heartbeatIssue"] = Effect.fn(
			"ErrorsService.heartbeatIssue",
		)(function* (orgId, actorId, issueId) {
			const timestamp = now()
			const current = yield* requireIssue(orgId, issueId)
			if (current.leaseHolderActorId !== actorId) {
				return yield* Effect.fail(leaseConflict(issueId, current))
			}
			const previous = current.leaseExpiresAt ?? timestamp
			const leaseMs = Math.max(DEFAULT_LEASE_DURATION_MS, previous - (current.claimedAt ?? previous))
			const leaseExpiresAt = timestamp + leaseMs
			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ leaseExpiresAt, updatedAt: timestamp })
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.id, issueId),
							eq(errorIssues.leaseHolderActorId, actorId),
						),
					),
			)
			yield* touchActor(orgId, actorId, timestamp)
			const next = yield* requireIssue(orgId, issueId)
			return yield* hydrateIssue(orgId, next)
		})

		const releaseIssue: ErrorsServiceShape["releaseIssue"] = Effect.fn("ErrorsService.releaseIssue")(
			function* (orgId, actorId, issueId, opts) {
				const timestamp = now()
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
							updatedAt: timestamp,
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

				yield* touchActor(orgId, actorId, timestamp)
				return yield* hydrateIssue(orgId, next)
			},
		)

		const assignIssue: ErrorsServiceShape["assignIssue"] = Effect.fn("ErrorsService.assignIssue")(
			function* (orgId, byActorId, issueId, toActorId) {
				const timestamp = now()
				const current = yield* requireIssue(orgId, issueId)
				if (toActorId !== null) {
					const actorRow = yield* selectActorRow(orgId, toActorId)
					if (!actorRow) {
						return yield* Effect.fail(
							new ActorNotFoundError({
								message: `Actor '${toActorId}' not found`,
								actorId: toActorId,
							}),
						)
					}
				}
				yield* dbExecute((db) =>
					db
						.update(errorIssues)
						.set({ assignedActorId: toActorId, updatedAt: timestamp })
						.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId))),
				)
				yield* recordEvent(orgId, issueId, byActorId, "assignment", {
					payload: {
						fromActorId: current.assignedActorId,
						toActorId,
					},
					timestamp,
				})
				yield* touchActor(orgId, byActorId, timestamp)
				const next = yield* requireIssue(orgId, issueId)
				return yield* hydrateIssue(orgId, next)
			},
		)

		const commentOnIssue: ErrorsServiceShape["commentOnIssue"] = Effect.fn(
			"ErrorsService.commentOnIssue",
		)(function* (orgId, actorId, issueId, body, opts) {
			const timestamp = now()
			yield* requireIssue(orgId, issueId)
			const type: ErrorIssueEventType = opts?.kind === "agent_note" ? "agent_note" : "comment"
			const payload: Record<string, unknown> = {
				body,
				visibility: opts?.visibility ?? "internal",
			}
			const id = newEventId()
			const insert: ErrorIssueEventInsert = {
				id,
				orgId,
				issueId,
				actorId,
				type,
				fromState: null,
				toState: null,
				payloadJson: JSON.stringify(payload),
				createdAt: timestamp,
			}
			yield* dbExecute((db) => db.insert(errorIssueEvents).values(insert))
			yield* touchActor(orgId, actorId, timestamp)
			const actorMap = yield* collectActorDocs(orgId, [actorId])
			return rowToEvent(
				{
					id,
					orgId,
					issueId,
					actorId,
					type,
					fromState: null,
					toState: null,
					payloadJson: JSON.stringify(payload),
					createdAt: timestamp,
				},
				actorMap,
			)
		})

		const proposeFix: ErrorsServiceShape["proposeFix"] = Effect.fn("ErrorsService.proposeFix")(
			function* (orgId, actorId, issueId, request) {
				const timestamp = now()
				const current = yield* requireIssue(orgId, issueId)
				const payload: Record<string, unknown> = {
					patchSummary: request.patchSummary,
					...(request.prUrl ? { prUrl: request.prUrl } : {}),
					...(request.artifacts ? { artifacts: request.artifacts } : {}),
				}
				yield* recordEvent(orgId, issueId, actorId, "fix_proposed", {
					payload,
					timestamp,
				})

				let next = current
				if (current.workflowState !== "in_review") {
					next = yield* applyTransition(orgId, actorId, current, "in_review", {
						payload: { viaProposeFix: true },
						timestamp,
					})
				}
				yield* touchActor(orgId, actorId, timestamp)
				yield* maybeNotifyTransition(orgId, actorId, next, current.workflowState)
				return yield* hydrateIssue(orgId, next)
			},
		)

		// ---------------------------------------------------------------
		// Incidents (unchanged listings)
		// ---------------------------------------------------------------

		const listIssueIncidents: ErrorsServiceShape["listIssueIncidents"] = Effect.fn(
			"ErrorsService.listIssueIncidents",
		)(function* (orgId, issueId) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId })
			yield* requireIssue(orgId, issueId)
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIncidents)
					.where(and(eq(errorIncidents.orgId, orgId), eq(errorIncidents.issueId, issueId)))
					.orderBy(desc(errorIncidents.lastTriggeredAt))
					.limit(200),
			)
			yield* Effect.annotateCurrentSpan("incidentCount", rows.length)
			return new ErrorIncidentsListResponse({
				incidents: rows.map(rowToIncident),
			})
		})

		const listOpenIncidents: ErrorsServiceShape["listOpenIncidents"] = Effect.fn(
			"ErrorsService.listOpenIncidents",
		)(function* (orgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIncidents)
					.where(and(eq(errorIncidents.orgId, orgId), eq(errorIncidents.status, "open")))
					.orderBy(desc(errorIncidents.lastTriggeredAt))
					.limit(500),
			)
			yield* Effect.annotateCurrentSpan("incidentCount", rows.length)
			return new ErrorIncidentsListResponse({
				incidents: rows.map(rowToIncident),
			})
		})

		// ---------------------------------------------------------------
		// Notification policy (per-org) controlling incident delivery.
		// ---------------------------------------------------------------

		const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(
			ErrorNotificationPolicyDocument.fields.destinationIds,
		)

		const defaultPolicy = (orgId: OrgId, timestamp: number): ErrorNotificationPolicyRow => ({
			orgId,
			enabled: 0,
			destinationIdsJson: "[]",
			notifyOnFirstSeen: 1,
			notifyOnRegression: 1,
			notifyOnResolve: 0,
			notifyOnTransitionInReview: 0,
			notifyOnTransitionDone: 0,
			notifyOnClaim: 0,
			minOccurrenceCount: 1,
			severity: "warning",
			updatedAt: timestamp,
			updatedBy: "system",
		})

		const parsePolicyDestinations = (raw: string): ReadonlyArray<AlertDestinationId> => {
			try {
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return []
				return decodeAlertDestinationIdSync(parsed.filter((v) => typeof v === "string"))
			} catch {
				return []
			}
		}

		const rowToPolicy = (row: ErrorNotificationPolicyRow) =>
			new ErrorNotificationPolicyDocument({
				enabled: row.enabled === 1,
				destinationIds: parsePolicyDestinations(row.destinationIdsJson),
				notifyOnFirstSeen: row.notifyOnFirstSeen === 1,
				notifyOnRegression: row.notifyOnRegression === 1,
				notifyOnResolve: row.notifyOnResolve === 1,
				notifyOnTransitionInReview: row.notifyOnTransitionInReview === 1,
				notifyOnTransitionDone: row.notifyOnTransitionDone === 1,
				notifyOnClaim: row.notifyOnClaim === 1,
				minOccurrenceCount: row.minOccurrenceCount,
				severity: row.severity as AlertSeverity,
				updatedAt: isoFromEpoch(row.updatedAt),
				updatedBy: row.updatedBy,
			})

		const loadPolicyRow = (orgId: OrgId) =>
			Effect.gen(function* () {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(errorNotificationPolicies)
						.where(eq(errorNotificationPolicies.orgId, orgId))
						.limit(1),
				)
				return rows[0] ?? null
			})

		const getNotificationPolicy: ErrorsServiceShape["getNotificationPolicy"] = Effect.fn(
			"ErrorsService.getNotificationPolicy",
		)(function* (orgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const row = yield* loadPolicyRow(orgId)
			return rowToPolicy(row ?? defaultPolicy(orgId, now()))
		})

		const upsertNotificationPolicy: ErrorsServiceShape["upsertNotificationPolicy"] = Effect.fn(
			"ErrorsService.upsertNotificationPolicy",
		)(function* (orgId, userId, request) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const existing = yield* loadPolicyRow(orgId)
			const base = existing ?? defaultPolicy(orgId, now())
			const timestamp = now()

			const nextDestinations =
				request.destinationIds !== undefined
					? JSON.stringify(request.destinationIds)
					: base.destinationIdsJson

			const toFlag = (value: boolean | undefined, fallback: number): number =>
				value === undefined ? fallback : value ? 1 : 0

			const merged: ErrorNotificationPolicyRow = {
				orgId,
				enabled: toFlag(request.enabled, base.enabled),
				destinationIdsJson: nextDestinations,
				notifyOnFirstSeen: toFlag(request.notifyOnFirstSeen, base.notifyOnFirstSeen),
				notifyOnRegression: toFlag(request.notifyOnRegression, base.notifyOnRegression),
				notifyOnResolve: toFlag(request.notifyOnResolve, base.notifyOnResolve),
				notifyOnTransitionInReview: toFlag(
					request.notifyOnTransitionInReview,
					base.notifyOnTransitionInReview,
				),
				notifyOnTransitionDone: toFlag(request.notifyOnTransitionDone, base.notifyOnTransitionDone),
				notifyOnClaim: toFlag(request.notifyOnClaim, base.notifyOnClaim),
				minOccurrenceCount:
					request.minOccurrenceCount !== undefined
						? request.minOccurrenceCount
						: base.minOccurrenceCount,
				severity: request.severity !== undefined ? request.severity : base.severity,
				updatedAt: timestamp,
				updatedBy: userId,
			}

			yield* dbExecute((db) =>
				db
					.insert(errorNotificationPolicies)
					.values(merged)
					.onConflictDoUpdate({
						target: errorNotificationPolicies.orgId,
						set: {
							enabled: merged.enabled,
							destinationIdsJson: merged.destinationIdsJson,
							notifyOnFirstSeen: merged.notifyOnFirstSeen,
							notifyOnRegression: merged.notifyOnRegression,
							notifyOnResolve: merged.notifyOnResolve,
							notifyOnTransitionInReview: merged.notifyOnTransitionInReview,
							notifyOnTransitionDone: merged.notifyOnTransitionDone,
							notifyOnClaim: merged.notifyOnClaim,
							minOccurrenceCount: merged.minOccurrenceCount,
							severity: merged.severity,
							updatedAt: merged.updatedAt,
							updatedBy: merged.updatedBy,
						},
					}),
			)

			return rowToPolicy(merged)
		})

		const issueLinkUrl = (issueId: string) =>
			`${env.MAPLE_APP_BASE_URL}/errors/issues/${encodeURIComponent(issueId)}`

		const notifyIncidentOpened = (
			orgId: OrgId,
			policy: ErrorNotificationPolicyRow,
			params: {
				readonly issueId: string
				readonly incidentId: string
				readonly reason: ErrorIncidentReason
				readonly serviceName: string
				readonly exceptionType: string
				readonly count: number
			},
		) => {
			if (policy.enabled !== 1) return Effect.void
			if (params.count < policy.minOccurrenceCount) return Effect.void
			if (params.reason === "first_seen" && policy.notifyOnFirstSeen !== 1) return Effect.void
			if (params.reason === "regression" && policy.notifyOnRegression !== 1) return Effect.void

			const destinationIds = parsePolicyDestinations(policy.destinationIdsJson)
			if (destinationIds.length === 0) return Effect.void

			return dispatcher
				.dispatch(orgId, destinationIds, {
					deliveryKey: `err:${orgId}:${params.incidentId}:open`,
					ruleId: params.issueId,
					ruleName: `${params.exceptionType} in ${params.serviceName}`,
					groupKey: params.serviceName,
					signalType: "error_rate",
					severity: policy.severity as AlertSeverity,
					comparator: "gte",
					threshold: policy.minOccurrenceCount,
					eventType: "trigger",
					incidentId: params.incidentId,
					incidentStatus: "open",
					dedupeKey: `error:${orgId}:${params.issueId}`,
					windowMinutes: 2,
					value: params.count,
					sampleCount: params.count,
					linkUrl: issueLinkUrl(params.issueId),
				})
				.pipe(Effect.asVoid)
		}

		const notifyIncidentResolved = (
			orgId: OrgId,
			policy: ErrorNotificationPolicyRow,
			params: {
				readonly issueId: string
				readonly incidentId: string
				readonly serviceName: string
				readonly exceptionType: string
				readonly occurrenceCount: number
			},
		) => {
			if (policy.enabled !== 1) return Effect.void
			if (policy.notifyOnResolve !== 1) return Effect.void

			const destinationIds = parsePolicyDestinations(policy.destinationIdsJson)
			if (destinationIds.length === 0) return Effect.void

			return dispatcher
				.dispatch(orgId, destinationIds, {
					deliveryKey: `err:${orgId}:${params.incidentId}:resolve`,
					ruleId: params.issueId,
					ruleName: `${params.exceptionType} in ${params.serviceName}`,
					groupKey: params.serviceName,
					signalType: "error_rate",
					severity: policy.severity as AlertSeverity,
					comparator: "gte",
					threshold: policy.minOccurrenceCount,
					eventType: "resolve",
					incidentId: params.incidentId,
					incidentStatus: "resolved",
					dedupeKey: `error:${orgId}:${params.issueId}`,
					windowMinutes: 2,
					value: params.occurrenceCount,
					sampleCount: params.occurrenceCount,
					linkUrl: issueLinkUrl(params.issueId),
				})
				.pipe(Effect.asVoid)
		}

		const maybeNotifyTransition = (
			orgId: OrgId,
			actorId: ActorId | null,
			row: ErrorIssueRow,
			fromState: WorkflowState,
		) =>
			Effect.gen(function* () {
				const policyRow = yield* loadPolicyRow(orgId)
				if (!policyRow || policyRow.enabled !== 1) return
				const toState = row.workflowState
				if (toState === fromState) return
				const destinationIds = parsePolicyDestinations(policyRow.destinationIdsJson)
				if (destinationIds.length === 0) return

				const shouldNotify =
					(toState === "in_review" && policyRow.notifyOnTransitionInReview === 1) ||
					(toState === "done" && policyRow.notifyOnTransitionDone === 1)
				if (!shouldNotify) return

				yield* dispatcher
					.dispatch(orgId, destinationIds, {
						deliveryKey: `err:${orgId}:${row.id}:transition:${toState}:${row.updatedAt}`,
						ruleId: row.id,
						ruleName: `${row.exceptionType} in ${row.serviceName}`,
						groupKey: row.serviceName,
						signalType: "error_rate",
						severity: policyRow.severity as AlertSeverity,
						comparator: "gte",
						threshold: policyRow.minOccurrenceCount,
						eventType: toState === "done" ? "resolve" : "trigger",
						incidentId: row.id,
						incidentStatus: toState === "done" ? "resolved" : "open",
						dedupeKey: `error:${orgId}:${row.id}`,
						windowMinutes: 2,
						value: row.occurrenceCount,
						sampleCount: row.occurrenceCount,
						linkUrl: issueLinkUrl(row.id),
					})
					.pipe(Effect.asVoid)
			})

		const maybeNotifyClaim = (orgId: OrgId, actorId: ActorId, row: ErrorIssueRow) =>
			Effect.gen(function* () {
				const policyRow = yield* loadPolicyRow(orgId)
				if (!policyRow || policyRow.enabled !== 1) return
				if (policyRow.notifyOnClaim !== 1) return
				const destinationIds = parsePolicyDestinations(policyRow.destinationIdsJson)
				if (destinationIds.length === 0) return

				yield* dispatcher
					.dispatch(orgId, destinationIds, {
						deliveryKey: `err:${orgId}:${row.id}:claim:${row.claimedAt ?? row.updatedAt}`,
						ruleId: row.id,
						ruleName: `${row.exceptionType} in ${row.serviceName}`,
						groupKey: row.serviceName,
						signalType: "error_rate",
						severity: policyRow.severity as AlertSeverity,
						comparator: "gte",
						threshold: policyRow.minOccurrenceCount,
						eventType: "trigger",
						incidentId: row.id,
						incidentStatus: "open",
						dedupeKey: `error:${orgId}:${row.id}:claim`,
						windowMinutes: 2,
						value: row.occurrenceCount,
						sampleCount: row.occurrenceCount,
						linkUrl: issueLinkUrl(row.id),
					})
					.pipe(Effect.asVoid)
			})

		// ---------------------------------------------------------------
		// Scheduled tick
		// ---------------------------------------------------------------

		const expireLeasesForOrg = Effect.fn("ErrorsService.expireLeases")(function* (
			orgId: OrgId,
			nowMs: number,
		) {
			const expired = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							isNotNull(errorIssues.leaseExpiresAt),
							lt(errorIssues.leaseExpiresAt, nowMs),
						),
					),
			)
			if (expired.length === 0) return 0

			const systemActor = yield* ensureSystemActor(orgId)
			yield* Effect.forEach(expired, (row) =>
				Effect.gen(function* () {
					const prevActorId = row.leaseHolderActorId
					yield* dbExecute((db) =>
						db
							.update(errorIssues)
							.set({
								leaseHolderActorId: null,
								leaseExpiresAt: null,
								claimedAt: null,
								updatedAt: nowMs,
							})
							.where(eq(errorIssues.id, row.id)),
					)
					yield* recordEvent(orgId, row.id, systemActor.id, "lease_expired", {
						payload: { previousHolderActorId: prevActorId },
						timestamp: nowMs,
					})
					if (row.workflowState === "in_progress") {
						const refreshed = yield* requireIssue(orgId, row.id)
						yield* applyTransition(orgId, systemActor.id, refreshed, "todo", {
							payload: { viaLeaseExpiry: true },
							timestamp: nowMs,
						})
					}
				}),
			)
			return expired.length
		})

		const processOrg = Effect.fn("ErrorsService.processOrg")(function* (
			orgId: OrgId,
			windowStartMs: number,
			windowEndMs: number,
			runRetention: boolean,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, runRetention })
			const tenant = systemTenant(orgId)
			const systemActor = yield* ensureSystemActor(orgId)
			const policy = (yield* loadPolicyRow(orgId)) ?? defaultPolicy(orgId, windowEndMs)

			const leasesExpired = yield* expireLeasesForOrg(orgId, windowEndMs)

			// Wake up wontfix issues whose snooze has elapsed, so that new events
			// observed in this tick are treated as regressions rather than skipped.
			const wakeCandidates = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIssues)
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.workflowState, "wontfix"),
							isNotNull(errorIssues.snoozeUntil),
							lt(errorIssues.snoozeUntil, windowEndMs),
						),
					),
			)
			yield* Effect.forEach(wakeCandidates, (row) =>
				applyTransition(orgId, systemActor.id, row, "triage", {
					payload: { viaSnoozeWakeup: true },
					timestamp: windowEndMs,
				}),
			)
			const issuesReopened = wakeCandidates.length

			const issuesCompiled = CH.compile(CH.errorIssuesQuery({ limit: 500 }), {
				orgId,
				startTime: toTinybirdDateTime(windowStartMs),
				endTime: toTinybirdDateTime(windowEndMs),
			})
			const issuesRaw = yield* warehouse
				.sqlQuery(tenant, issuesCompiled.sql, { context: "errorIssuesScan" })
				.pipe(Effect.mapError(makePersistenceError))

			const rows = issuesCompiled.castRows(issuesRaw).map((raw) => ({
				fingerprintHash: String(raw.fingerprintHash ?? ""),
				serviceName: String(raw.serviceName ?? ""),
				exceptionType: String(raw.exceptionType ?? ""),
				exceptionMessage: String(raw.exceptionMessage ?? ""),
				topFrame: String(raw.topFrame ?? ""),
				count: Number(raw.count ?? 0),
				affectedServicesCount: Number(raw.affectedServicesCount ?? 0),
				firstSeen: String(raw.firstSeen ?? ""),
				lastSeen: String(raw.lastSeen ?? ""),
			}))

			const fingerprintResults = yield* Effect.forEach(rows, (row) =>
				Effect.gen(function* () {
					const firstSeenMs = Date.parse(row.firstSeen)
					const lastSeenMs = Date.parse(row.lastSeen)
					const existing = yield* dbExecute((db) =>
						db
							.select()
							.from(errorIssues)
							.where(
								and(
									eq(errorIssues.orgId, orgId),
									eq(errorIssues.fingerprintHash, row.fingerprintHash),
								),
							)
							.limit(1),
					)

					const prior = existing[0]
					let issueId: ErrorIssueId
					let wasRegression = false
					let wasNew = false

					if (prior) {
						issueId = prior.id
						// If the issue is in wontfix with an active snooze, skip entirely.
						if (
							prior.workflowState === "wontfix" &&
							(prior.snoozeUntil == null || prior.snoozeUntil > windowEndMs)
						) {
							return { touched: 0, opened: 0 }
						}

						yield* dbExecute((db) =>
							db
								.update(errorIssues)
								.set({
									lastSeenAt: lastSeenMs,
									occurrenceCount: sql`${errorIssues.occurrenceCount} + ${row.count}`,
									updatedAt: windowEndMs,
								})
								.where(eq(errorIssues.id, prior.id)),
						)

						if (prior.workflowState === "done") {
							const refreshed = yield* requireIssue(orgId, prior.id)
							yield* applyTransition(orgId, systemActor.id, refreshed, "triage", {
								payload: { viaRegression: true },
								timestamp: windowEndMs,
							})
							yield* recordEvent(orgId, prior.id, systemActor.id, "regression", {
								payload: { occurrenceCount: row.count },
								timestamp: windowEndMs,
							})
							wasRegression = true
						}
					} else {
						wasNew = true
						issueId = newErrorIssueId()
						yield* dbExecute((db) =>
							db.insert(errorIssues).values({
								id: issueId,
								orgId,
								fingerprintHash: row.fingerprintHash,
								serviceName: row.serviceName,
								exceptionType: row.exceptionType,
								exceptionMessage: row.exceptionMessage,
								topFrame: row.topFrame,
								workflowState: "triage",
								priority: 3,
								assignedActorId: null,
								leaseHolderActorId: null,
								leaseExpiresAt: null,
								claimedAt: null,
								notes: null,
								firstSeenAt: firstSeenMs,
								lastSeenAt: lastSeenMs,
								occurrenceCount: row.count,
								resolvedAt: null,
								resolvedByActorId: null,
								snoozeUntil: null,
								archivedAt: null,
								createdAt: windowEndMs,
								updatedAt: windowEndMs,
							}),
						)
						yield* recordEvent(orgId, issueId, systemActor.id, "created", {
							toState: "triage",
							payload: {
								serviceName: row.serviceName,
								exceptionType: row.exceptionType,
								occurrenceCount: row.count,
							},
							timestamp: windowEndMs,
						})
					}

					const stateRow = yield* dbExecute((db) =>
						db
							.select()
							.from(errorIssueStates)
							.where(
								and(eq(errorIssueStates.orgId, orgId), eq(errorIssueStates.issueId, issueId)),
							)
							.limit(1),
					)
					const openIncidentIdRaw = stateRow[0]?.openIncidentId ?? null

					if (openIncidentIdRaw == null) {
						const reason: ErrorIncidentReason = wasNew
							? "first_seen"
							: wasRegression
								? "regression"
								: "first_seen"
						const incidentId = newErrorIncidentId()
						yield* dbExecute((db) =>
							db.insert(errorIncidents).values({
								id: incidentId,
								orgId,
								issueId,
								status: "open",
								reason,
								firstTriggeredAt: firstSeenMs,
								lastTriggeredAt: lastSeenMs,
								resolvedAt: null,
								occurrenceCount: row.count,
								createdAt: windowEndMs,
								updatedAt: windowEndMs,
							}),
						)

						yield* dbExecute((db) =>
							db
								.insert(errorIssueStates)
								.values({
									orgId,
									issueId,
									lastObservedOccurrenceAt: lastSeenMs,
									lastEvaluatedAt: windowEndMs,
									openIncidentId: incidentId,
									updatedAt: windowEndMs,
								})
								.onConflictDoUpdate({
									target: [errorIssueStates.orgId, errorIssueStates.issueId],
									set: {
										lastObservedOccurrenceAt: lastSeenMs,
										lastEvaluatedAt: windowEndMs,
										openIncidentId: incidentId,
										updatedAt: windowEndMs,
									},
								}),
						)

						yield* notifyIncidentOpened(orgId, policy, {
							issueId,
							incidentId,
							reason,
							serviceName: row.serviceName,
							exceptionType: row.exceptionType,
							count: row.count,
						})

						return { touched: 1, opened: 1 }
					} else {
						yield* dbExecute((db) =>
							db
								.update(errorIncidents)
								.set({
									lastTriggeredAt: lastSeenMs,
									occurrenceCount: sql`${errorIncidents.occurrenceCount} + ${row.count}`,
									updatedAt: windowEndMs,
								})
								.where(eq(errorIncidents.id, openIncidentIdRaw)),
						)
						yield* dbExecute((db) =>
							db
								.update(errorIssueStates)
								.set({
									lastObservedOccurrenceAt: lastSeenMs,
									lastEvaluatedAt: windowEndMs,
									updatedAt: windowEndMs,
								})
								.where(
									and(
										eq(errorIssueStates.orgId, orgId),
										eq(errorIssueStates.issueId, issueId),
									),
								),
						)
						return { touched: 1, opened: 0 }
					}
				}),
			)

			const issuesTouched = fingerprintResults.reduce((s, r) => s + r.touched, 0)
			const incidentsOpened = fingerprintResults.reduce((s, r) => s + r.opened, 0)

			// Auto-resolve stale incidents
			const cutoffMs = windowEndMs - AUTO_RESOLVE_MINUTES * 60_000
			const staleIncidents = yield* dbExecute((db) =>
				db
					.select()
					.from(errorIncidents)
					.where(
						and(
							eq(errorIncidents.orgId, orgId),
							eq(errorIncidents.status, "open"),
							lt(errorIncidents.lastTriggeredAt, cutoffMs),
						),
					),
			)
			yield* Effect.forEach(staleIncidents, (incident) =>
				Effect.gen(function* () {
					yield* dbExecute((db) =>
						db
							.update(errorIncidents)
							.set({
								status: "resolved",
								resolvedAt: windowEndMs,
								updatedAt: windowEndMs,
							})
							.where(eq(errorIncidents.id, incident.id)),
					)
					yield* dbExecute((db) =>
						db
							.update(errorIssueStates)
							.set({ openIncidentId: null, updatedAt: windowEndMs })
							.where(
								and(
									eq(errorIssueStates.orgId, orgId),
									eq(errorIssueStates.issueId, incident.issueId),
								),
							),
					)

					if (policy.enabled === 1 && policy.notifyOnResolve === 1) {
						const issueRows = yield* dbExecute((db) =>
							db
								.select({
									serviceName: errorIssues.serviceName,
									exceptionType: errorIssues.exceptionType,
								})
								.from(errorIssues)
								.where(
									and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, incident.issueId)),
								)
								.limit(1),
						)
						const issueRow = issueRows[0]
						if (issueRow) {
							yield* notifyIncidentResolved(orgId, policy, {
								issueId: incident.issueId,
								incidentId: incident.id,
								serviceName: issueRow.serviceName,
								exceptionType: issueRow.exceptionType,
								occurrenceCount: incident.occurrenceCount,
							})
						}
					}
				}),
			)
			const incidentsResolved = staleIncidents.length

			let issuesArchived = 0
			let issuesDeleted = 0

			if (runRetention) {
				const resolvedCutoff = windowEndMs - RESOLVED_RETENTION_DAYS * DAY_MS
				const archivedRows = yield* dbExecute((db) =>
					db
						.update(errorIssues)
						.set({ archivedAt: windowEndMs, updatedAt: windowEndMs })
						.where(
							and(
								eq(errorIssues.orgId, orgId),
								eq(errorIssues.workflowState, "done"),
								isNull(errorIssues.archivedAt),
								isNotNull(errorIssues.resolvedAt),
								lt(errorIssues.resolvedAt, resolvedCutoff),
							),
						)
						.returning({ id: errorIssues.id }),
				)
				issuesArchived = archivedRows.length

				const archivedCutoff = windowEndMs - ARCHIVED_RETENTION_DAYS * DAY_MS
				const toDelete = yield* dbExecute((db) =>
					db
						.select({ id: errorIssues.id })
						.from(errorIssues)
						.where(
							and(
								eq(errorIssues.orgId, orgId),
								isNotNull(errorIssues.archivedAt),
								lt(errorIssues.archivedAt, archivedCutoff),
							),
						)
						.limit(500),
				)
				if (toDelete.length > 0) {
					const ids = toDelete.map((r) => r.id)
					const idChunks = Arr.chunksOf(ids, D1_INARRAY_CHUNK_SIZE)
					yield* Effect.forEach(
						idChunks,
						(chunk) =>
							dbExecute((db) =>
								db
									.delete(errorIncidents)
									.where(
										and(
											eq(errorIncidents.orgId, orgId),
											inArray(errorIncidents.issueId, chunk),
										),
									),
							),
						{ discard: true },
					)
					yield* Effect.forEach(
						idChunks,
						(chunk) =>
							dbExecute((db) =>
								db
									.delete(errorIssueStates)
									.where(
										and(
											eq(errorIssueStates.orgId, orgId),
											inArray(errorIssueStates.issueId, chunk),
										),
									),
							),
						{ discard: true },
					)
					yield* Effect.forEach(
						idChunks,
						(chunk) =>
							dbExecute((db) =>
								db
									.delete(errorIssueEvents)
									.where(
										and(
											eq(errorIssueEvents.orgId, orgId),
											inArray(errorIssueEvents.issueId, chunk),
										),
									),
							),
						{ discard: true },
					)
					yield* Effect.forEach(
						idChunks,
						(chunk) =>
							dbExecute((db) =>
								db
									.delete(errorIssues)
									.where(and(eq(errorIssues.orgId, orgId), inArray(errorIssues.id, chunk))),
							),
						{ discard: true },
					)
					issuesDeleted = ids.length
				}
			}

			return {
				issuesTouched,
				incidentsOpened,
				incidentsResolved,
				issuesReopened,
				issuesArchived,
				issuesDeleted,
				leasesExpired,
			}
		})

		const runTick: ErrorsServiceShape["runTick"] = Effect.fn("ErrorsService.runTick")(function* () {
			const endMs = now()
			const startMs = endMs - TICK_WINDOW_MS

			const retentionRan = Math.floor(endMs / TICK_WINDOW_MS) % RETENTION_PHASE_EVERY_N_TICKS === 0

			const stateOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: errorIssueStates.orgId }).from(errorIssueStates),
			)
			const issueOrgs = yield* dbExecute((db) =>
				db
					.selectDistinct({ orgId: errorIssues.orgId })
					.from(errorIssues)
					.where(isNotNull(errorIssues.orgId)),
			)
			const ingestOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
			)
			const knownOrgs = new Set<string>([
				...stateOrgs.map((r) => r.orgId),
				...issueOrgs.map((r) => r.orgId),
				...ingestOrgs.map((r) => r.orgId),
			])

			const emptyResult = {
				issuesTouched: 0,
				incidentsOpened: 0,
				incidentsResolved: 0,
				issuesReopened: 0,
				issuesArchived: 0,
				issuesDeleted: 0,
				leasesExpired: 0,
			}

			let orgFailures = 0
			const results = yield* Effect.forEach(
				[...knownOrgs],
				(org) =>
					processOrg(org as OrgId, startMs, endMs, retentionRan).pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								yield* Effect.logError("Error tick failed for org").pipe(
									Effect.annotateLogs({
										orgId: org,
										error: Cause.pretty(cause),
									}),
								)
								orgFailures += 1
								return emptyResult
							}),
						),
					),
				{ concurrency: 4 },
			)

			const totals = results.reduce(
				(acc, r) => ({
					issuesTouched: acc.issuesTouched + r.issuesTouched,
					incidentsOpened: acc.incidentsOpened + r.incidentsOpened,
					incidentsResolved: acc.incidentsResolved + r.incidentsResolved,
					issuesReopened: acc.issuesReopened + r.issuesReopened,
					issuesArchived: acc.issuesArchived + r.issuesArchived,
					issuesDeleted: acc.issuesDeleted + r.issuesDeleted,
					leasesExpired: acc.leasesExpired + r.leasesExpired,
				}),
				emptyResult,
			)

			yield* Effect.annotateCurrentSpan({
				orgsKnown: knownOrgs.size,
				orgFailures,
				...totals,
			})

			return {
				orgsProcessed: knownOrgs.size,
				...totals,
				retentionRan,
			}
		})

		return {
			listIssues,
			getIssue,
			transitionIssue,
			claimIssue,
			heartbeatIssue,
			releaseIssue,
			assignIssue,
			commentOnIssue,
			proposeFix,
			listIssueEvents,
			registerAgent,
			listAgents,
			lookupActor,
			ensureUserActor,
			listIssueIncidents,
			listOpenIncidents,
			getNotificationPolicy,
			upsertNotificationPolicy,
			runTick,
		} satisfies ErrorsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
