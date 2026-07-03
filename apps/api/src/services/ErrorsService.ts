import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ActorId as ActorIdSchema,
	ActorNotFoundError,
	ActorsListResponse,
	type AlertDestinationId,
	ErrorIncidentDocument,
	ErrorIncidentsListResponse,
	type ErrorIncidentReason,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
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
	IssueEscalationPolicyDocument,
	IssueEscalationPolicyRule,
	type IssueEscalationPolicyUpsertRequest,
	type IssueKind,
	type IssueSeverity,
	type IssueSeveritySource,
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
	alertDestinations,
	alertIncidents,
	errorIssueStates,
	errorNotificationPolicies,
	type ErrorNotificationPolicyRow,
	issueEscalationPolicies,
	type IssueEscalationPolicyRow,
	issueEscalations,
	orgClickHouseSettings,
	orgIngestKeys,
} from "@maple/db"
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { CH, parseWarehouseDateTime, warehouseDateTimeToIso } from "@maple/query-engine"
import { Array as Arr, Cause, Clock, Context, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { AI_TRIAGE_WORKFLOW_BINDING, maybeEnqueueTriage } from "../lib/ai-triage-enqueue"
import { escalationDedupeKey, escalationReasonFor } from "../lib/issue-severity"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import { dateToMs, msToDate } from "../lib/time"
import { NotificationDispatcher } from "./NotificationDispatcher"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { EdgeCacheService } from "@maple/query-engine/caching"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeActorIdSync = Schema.decodeUnknownSync(ActorIdSchema)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeTraceIdSync = Schema.decodeUnknownSync(TraceIdSchema)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanIdSchema)

// Lenient decoders for JSON stored in jsonb columns. Decode failures fall back
// to an empty/null value at each call site — stored blobs are best-effort.
const decodeStoredJsonRecord = Schema.decodeUnknownOption(
	Schema.Record(Schema.String, Schema.Unknown),
)
const decodeStoredJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_EVENTS_LIMIT = 100
const AUTO_RESOLVE_MINUTES = 30
const TICK_WINDOW_MS = 2 * 60_000
/** Active-org discovery window — a superset of the 2-min scan window so an org
 *  with recent (but not last-2-min) errors still gets scanned, with slack for
 *  cron jitter and MV write lag. */
const ERROR_ACTIVE_DISCOVERY_WINDOW_MS = 15 * 60_000
// Last-known active-org set, cached so a discovery failure can fail CLOSED
// (reuse the previous active set) instead of fanning out to every known org —
// the latter melts the warehouse exactly when it is already struggling. Keyed
// globally (discovery is cross-org, one set covers the whole managed workspace).
// TTL generous enough to survive a multi-hour warehouse brown-out; a slightly
// stale set only costs a few cheap empty scans of recently-idle orgs.
const ACTIVE_ORGS_CACHE_BUCKET = "errors-active-orgs"
const ACTIVE_ORGS_CACHE_KEY = "active"
const ACTIVE_ORGS_CACHE_TTL_S = 6 * 60 * 60
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

const BUSY_RETRY_SCHEDULE = Schedule.exponential("50 millis", 2.0).pipe(Schedule.both(Schedule.recurs(3)))

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
			readonly severity?: IssueSeverity | "unset"
			readonly kind?: IssueKind
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
	readonly recordAnomalyLinkEvent: (
		orgId: OrgId,
		issueId: ErrorIssueId,
		actorId: ActorId,
		payload: {
			readonly action: "linked" | "unlinked"
			readonly incidentId: string
			readonly signalType: string
			readonly serviceName: string
			readonly deploymentEnv: string
		},
	) => Effect.Effect<void, ErrorPersistenceError>
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
	readonly getEscalationPolicy: (
		orgId: OrgId,
	) => Effect.Effect<IssueEscalationPolicyDocument, ErrorPersistenceError>
	readonly upsertEscalationPolicy: (
		orgId: OrgId,
		userId: UserId,
		request: IssueEscalationPolicyUpsertRequest,
	) => Effect.Effect<IssueEscalationPolicyDocument, ErrorPersistenceError | ErrorValidationError>
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

const make: Effect.Effect<
	ErrorsServiceShape,
	never,
	Database | WarehouseQueryService | EdgeCacheService | Env | NotificationDispatcher
> = Effect.gen(function* () {
	const database = yield* Database
	const warehouse = yield* WarehouseQueryService
	const edgeCache = yield* EdgeCacheService
	const env = yield* Env
	const dispatcher = yield* NotificationDispatcher
	// Optional: present only inside a Worker isolate. Used to kick off the
	// AI triage Workflow when an incident opens (org opt-in).
	const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
	const aiTriageWorkflowBinding = Option.match(workerEnv, {
		onNone: () => undefined,
		onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
	})

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

	const isoFromDate = (date: Date) => decodeIsoDateTimeStringSync(date.toISOString())

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

	// ---------------------------------------------------------------
	// Active-org gating
	//
	// The tick historically scanned the warehouse for every org that ever held
	// an ingest key — overwhelmingly idle orgs with zero recent errors, which
	// dominated Tinybird CPU. Instead, run ONE cross-org scan of recent error
	// events (pinned to managed Tinybird) and only scan orgs that show up.
	// BYO-ClickHouse orgs are invisible to that scan, so they are always treated
	// as active. Fails CLOSED: discovery fails precisely when the warehouse is
	// stressed, so the old "scan every known org" fallback amplified the outage
	// into a fan-out storm. Instead reuse the last-known active set from cache;
	// if none, fall back to just the BYO set. Orgs with existing issue/incident
	// state are still scanned by the caller (`withState`), so auto-resolution
	// keeps working even when discovery is down.
	// ---------------------------------------------------------------

	const resolveActiveOrgs = Effect.fn("ErrorsService.resolveActiveOrgs")(function* (
		knownOrgs: ReadonlyArray<string>,
		nowMs: number,
	) {
		const byoRows = yield* dbExecute((db) =>
			db.selectDistinct({ orgId: orgClickHouseSettings.orgId }).from(orgClickHouseSettings),
		).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: string }>))
		const byo = new Set<string>(byoRows.map((r) => r.orgId))

		if (knownOrgs.length === 0) return byo as ReadonlySet<string>

		const compiled = CH.compile(CH.activeOrgsByErrorEventsQuery(), {
			startTime: toTinybirdDateTime(nowMs - ERROR_ACTIVE_DISCOVERY_WINDOW_MS),
		})
		return yield* warehouse
			.compiledQuery(systemTenant(knownOrgs[0] as OrgId), compiled, {
				pinToIngestConfig: true,
				// Bound the one cross-org scan (no OrgId predicate ⇒ can't prune the
				// primary key): abort server-side at 5s instead of riding the ~30s
				// client timeout when the warehouse is slow.
				profile: "discovery",
				context: "errorActiveOrgsDiscovery",
			})
			.pipe(
				Effect.map((rows) => {
					const active = new Set<string>(byo)
					for (const row of rows) {
						const orgId = String((row as { orgId?: unknown }).orgId ?? "")
						if (orgId) active.add(orgId)
					}
					return active as ReadonlySet<string>
				}),
				// Cache the freshly-discovered set so a later discovery failure can
				// reuse it instead of fanning out to all known orgs. Best-effort.
				Effect.tap((active) =>
					edgeCache
						.rawPut(ACTIVE_ORGS_CACHE_BUCKET, ACTIVE_ORGS_CACHE_KEY, [...active], ACTIVE_ORGS_CACHE_TTL_S)
						.pipe(Effect.ignore),
				),
				// Fail CLOSED: reuse the last-known active set (or just BYO if cold).
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						yield* Effect.logWarning(
							"Error active-org discovery failed; reusing last-known active set",
						).pipe(Effect.annotateLogs({ error: Cause.pretty(cause) }))
						const cached = yield* edgeCache
							.rawGet<ReadonlyArray<string>>(ACTIVE_ORGS_CACHE_BUCKET, ACTIVE_ORGS_CACHE_KEY)
							.pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()))
						const active = new Set<string>(byo)
						for (const orgId of Option.getOrElse(cached, () => [] as ReadonlyArray<string>)) {
							active.add(orgId)
						}
						return active as ReadonlySet<string>
					}),
				),
			)
	})

	// ---------------------------------------------------------------
	// Actors
	// ---------------------------------------------------------------

	const parseCapabilities = (raw: unknown): ReadonlyArray<string> =>
		Option.getOrElse(decodeStoredJsonArray(raw), (): ReadonlyArray<unknown> => []).filter(
			(v): v is string => typeof v === "string",
		)

	const rowToActor = (row: ActorRow): ActorDocument =>
		new ActorDocument({
			id: row.id,
			type: row.type,
			userId: row.userId ?? null,
			agentName: row.agentName ?? null,
			model: row.model ?? null,
			capabilities: parseCapabilities(row.capabilitiesJson),
			lastActiveAt: row.lastActiveAt == null ? null : isoFromDate(row.lastActiveAt),
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

	// Best-effort: a failed lastActiveAt bump must never fail the calling
	// mutation, but persistent failures should still be diagnosable.
	const touchActor = (orgId: OrgId, actorId: ActorId, timestamp: number) =>
		dbExecute((db) =>
			db
				.update(actors)
				.set({ lastActiveAt: new Date(timestamp) })
				.where(and(eq(actors.orgId, orgId), eq(actors.id, actorId))),
		).pipe(
			Effect.tapCause((cause) =>
				Effect.logWarning("ErrorsService.touchActor failed to update lastActiveAt").pipe(
					Effect.annotateLogs({ orgId, actorId, cause: Cause.pretty(cause) }),
				),
			),
			Effect.ignore,
		)

	const ensureUserActor: ErrorsServiceShape["ensureUserActor"] = Effect.fn("ErrorsService.ensureUserActor")(
		function* (orgId, userId) {
			const existing = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "user"), eq(actors.userId, userId)))
					.limit(1),
			)
			if (existing[0]) return rowToActor(existing[0])

			const timestamp = yield* Clock.currentTimeMillis
			const id = newActorId()
			const insert: ActorInsert = {
				id,
				orgId,
				type: "user",
				userId,
				agentName: null,
				model: null,
				capabilitiesJson: [],
				createdBy: userId,
				createdAt: new Date(timestamp),
				lastActiveAt: new Date(timestamp),
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
		},
	)

	const ensureSystemActor = Effect.fn("ErrorsService.ensureSystemActor")(function* (orgId: OrgId) {
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

		const timestamp = yield* Clock.currentTimeMillis
		const id = newActorId()
		const insert: ActorInsert = {
			id,
			orgId,
			type: "agent",
			userId: null,
			agentName: SYSTEM_AGENT_NAME,
			model: null,
			capabilitiesJson: ["system", "auto-triage"],
			createdBy: null,
			createdAt: new Date(timestamp),
			lastActiveAt: new Date(timestamp),
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

			const timestamp = yield* Clock.currentTimeMillis
			const id = newActorId()
			const capabilities = request.capabilities ?? []
			const insert: ActorInsert = {
				id,
				orgId,
				type: "agent",
				userId: null,
				agentName: name,
				model: request.model ?? null,
				capabilitiesJson: capabilities,
				createdBy: byUserId,
				createdAt: new Date(timestamp),
				lastActiveAt: new Date(timestamp),
			}

			yield* dbExecute((db) => db.insert(actors).values(insert).onConflictDoNothing())

			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(actors)
					.where(and(eq(actors.orgId, orgId), eq(actors.type, "agent"), eq(actors.agentName, name)))
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

	const parseSourceRef = (json: unknown): Record<string, unknown> | null => {
		if (json == null) return null
		return Option.match(decodeStoredJsonRecord(json), {
			onNone: () => null,
			onSome: (parsed) => ({ ...parsed }),
		})
	}

	const rowToIssue = (
		row: ErrorIssueRow,
		hasOpenIncident: boolean,
		actorMap: Map<ActorId, ActorDocument>,
	) =>
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
			assignedActor: row.assignedActorId == null ? null : (actorMap.get(row.assignedActorId) ?? null),
			leaseHolder:
				row.leaseHolderActorId == null ? null : (actorMap.get(row.leaseHolderActorId) ?? null),
			leaseExpiresAt: row.leaseExpiresAt == null ? null : isoFromDate(row.leaseExpiresAt),
			claimedAt: row.claimedAt == null ? null : isoFromDate(row.claimedAt),
			notes: row.notes ?? null,
			firstSeenAt: isoFromDate(row.firstSeenAt),
			lastSeenAt: isoFromDate(row.lastSeenAt),
			occurrenceCount: row.occurrenceCount,
			resolvedAt: row.resolvedAt == null ? null : isoFromDate(row.resolvedAt),
			snoozeUntil: row.snoozeUntil == null ? null : isoFromDate(row.snoozeUntil),
			archivedAt: row.archivedAt == null ? null : isoFromDate(row.archivedAt),
			hasOpenIncident,
		})

	const rowToIncident = (row: ErrorIncidentRow) =>
		new ErrorIncidentDocument({
			id: row.id,
			issueId: row.issueId,
			status: row.status,
			reason: row.reason,
			firstTriggeredAt: isoFromDate(row.firstTriggeredAt),
			lastTriggeredAt: isoFromDate(row.lastTriggeredAt),
			resolvedAt: row.resolvedAt == null ? null : isoFromDate(row.resolvedAt),
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
			payload: Option.match(decodeStoredJsonRecord(row.payloadJson), {
				onNone: (): Record<string, unknown> => ({}),
				onSome: (parsed) => ({ ...parsed }),
			}),
			createdAt: isoFromDate(row.createdAt),
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
		// Two sources of "open incident": error_incidents for fingerprint
		// issues, and open alert_incidents linked via errorIssueId for
		// alert-backed issues. An issue id only ever appears in one of them.
		return Effect.forEach(Arr.chunksOf(issueIds, D1_INARRAY_CHUNK_SIZE), (chunk) =>
			Effect.all([
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
				dbExecute((db) =>
					db
						.select({ issueId: alertIncidents.errorIssueId })
						.from(alertIncidents)
						.where(
							and(
								eq(alertIncidents.orgId, orgId),
								eq(alertIncidents.status, "open"),
								inArray(alertIncidents.errorIssueId, chunk),
							),
						),
				),
			]),
		).pipe(
			Effect.map(
				(groups) =>
					new Set(
						groups.flatMap(([errorRows, alertRows]) => [
							...errorRows.map((r) => r.issueId),
							...alertRows.flatMap((r) =>
								r.issueId == null ? [] : [r.issueId as ErrorIssueId],
							),
						]),
					),
			),
		)
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

	const recordEvent = Effect.fn("ErrorsService.recordEvent")(function* (
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
	) {
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
			createdAt: new Date(timestamp),
		}
		return yield* dbExecute((db) => db.insert(errorIssueEvents).values(insert))
	})

	const recordAnomalyLinkEvent: ErrorsServiceShape["recordAnomalyLinkEvent"] = Effect.fn(
		"ErrorsService.recordAnomalyLinkEvent",
	)(function* (orgId, issueId, actorId, payload) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId, action: payload.action })
		yield* recordEvent(orgId, issueId, actorId, "anomaly_linked", { payload: { ...payload } })
	})

	const listIssueEvents: ErrorsServiceShape["listIssueEvents"] = Effect.fn("ErrorsService.listIssueEvents")(
		function* (orgId, issueId, opts) {
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
		},
	)

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
			if (opts.severity === "unset") conditions.push(isNull(errorIssues.severity))
			else if (opts.severity) conditions.push(eq(errorIssues.severity, opts.severity))
			if (opts.kind) conditions.push(eq(errorIssues.kind, opts.kind))
			if (opts.service) conditions.push(eq(errorIssues.serviceName, opts.service))
			if (opts.assignedActorId) conditions.push(eq(errorIssues.assignedActorId, opts.assignedActorId))
			if (!opts.includeArchived) conditions.push(isNull(errorIssues.archivedAt))
			if (opts.endTime) {
				const endMs = parseWarehouseDateTime(opts.endTime)
				if (Number.isFinite(endMs)) conditions.push(lt(errorIssues.firstSeenAt, new Date(endMs)))
			}
			if (opts.startTime) {
				const startMs = parseWarehouseDateTime(opts.startTime)
				if (Number.isFinite(startMs)) conditions.push(gt(errorIssues.lastSeenAt, new Date(startMs)))
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
			const endMs = opts.endTime ? parseWarehouseDateTime(opts.endTime) : yield* Clock.currentTimeMillis
			const startMs = opts.startTime
				? parseWarehouseDateTime(opts.startTime)
				: endMs - DEFAULT_DETAIL_WINDOW_MS
			const bucketSeconds = opts.bucketSeconds ?? 3600
			const sampleLimit = opts.sampleLimit ?? 25

			const tenant = systemTenant(orgId)

			// Non-error issues carry synthetic fingerprints (`alert:{ruleId}:…`)
			// that can never match warehouse rows — skip both queries instead of
			// paying two guaranteed-empty warehouse round trips.
			const isErrorKind = issueRow.kind === "error"

			const timeseriesCompiled = CH.compile(CH.errorIssueTimeseriesQuery(), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: toTinybirdDateTime(startMs),
				endTime: toTinybirdDateTime(endMs),
				bucketSeconds,
			})
			const timeseriesEffect = isErrorKind
				? warehouse
						.compiledQuery(tenant, timeseriesCompiled, { context: "errorIssueTimeseries" })
						.pipe(Effect.mapError((e) => makePersistenceError(e)))
				: Effect.succeed([])

			const samplesCompiled = CH.compile(CH.errorIssueSampleTracesQuery({ limit: sampleLimit }), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: toTinybirdDateTime(startMs),
				endTime: toTinybirdDateTime(endMs),
			})
			const samplesEffect = isErrorKind
				? warehouse
						.compiledQuery(tenant, samplesCompiled, { context: "errorIssueSampleTraces" })
						.pipe(Effect.mapError((e) => makePersistenceError(e)))
				: Effect.succeed([])

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
						bucket: decodeIsoDateTimeStringSync(warehouseDateTimeToIso(String(row.bucket))),
						count: Number(row.count ?? 0),
					}),
			)

			const sampleTraces = sampleRows.map(
				(row) =>
					new ErrorIssueSampleTrace({
						traceId: decodeTraceIdSync(String(row.traceId ?? "")),
						spanId: decodeSpanIdSync(String(row.spanId ?? "")),
						serviceName: String(row.serviceName ?? ""),
						timestamp: decodeIsoDateTimeStringSync(warehouseDateTimeToIso(String(row.timestamp))),
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
		const timestamp = opts.timestamp ?? (yield* Clock.currentTimeMillis)
		const fromState = row.workflowState
		if (fromState === toState) {
			return row
		}
		yield* validateTransition(row.id, fromState, toState)

		const update: Partial<ErrorIssueRow> = {
			workflowState: toState,
			updatedAt: new Date(timestamp),
		}

		if (toState === "done") {
			update.resolvedAt = new Date(timestamp)
			update.resolvedByActorId = actorId ?? null
		} else if (fromState === "done") {
			update.resolvedAt = null
			update.resolvedByActorId = null
		}

		if (toState === "wontfix") {
			if (opts.snoozeUntilMs !== undefined) {
				update.snoozeUntil = msToDate(opts.snoozeUntilMs)
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
						resolvedAt: new Date(timestamp),
						updatedAt: new Date(timestamp),
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
					.set({ openIncidentId: null, updatedAt: new Date(timestamp) })
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

	const transitionIssue: ErrorsServiceShape["transitionIssue"] = Effect.fn("ErrorsService.transitionIssue")(
		function* (orgId, actorId, issueId, toState, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId, toState })
			const current = yield* requireIssue(orgId, issueId)

			let snoozeUntilMs: number | null | undefined
			if (opts?.snoozeUntil !== undefined) {
				if (opts.snoozeUntil === null) {
					snoozeUntilMs = null
				} else {
					const parsed = parseWarehouseDateTime(opts.snoozeUntil)
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
		},
	)

	// ---------------------------------------------------------------
	// Claim / lease
	// ---------------------------------------------------------------

	const leaseConflict = (issueId: ErrorIssueId, row: ErrorIssueRow | null) =>
		new ErrorIssueLeaseConflictError({
			message: "Issue is held by another actor",
			issueId,
			currentHolderActorId: row?.leaseHolderActorId ?? null,
			leaseExpiresAt: row?.leaseExpiresAt == null ? null : isoFromDate(row.leaseExpiresAt),
		})

	const claimIssue: ErrorsServiceShape["claimIssue"] = Effect.fn("ErrorsService.claimIssue")(
		function* (orgId, actorId, issueId, leaseDurationMs) {
			const timestamp = yield* Clock.currentTimeMillis
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
						leaseExpiresAt: new Date(leaseExpiresAt),
						claimedAt: new Date(timestamp),
						updatedAt: new Date(timestamp),
					})
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.id, issueId),
							or(
								isNull(errorIssues.leaseHolderActorId),
								eq(errorIssues.leaseHolderActorId, actorId),
								lt(errorIssues.leaseExpiresAt, new Date(timestamp)),
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

	const heartbeatIssue: ErrorsServiceShape["heartbeatIssue"] = Effect.fn("ErrorsService.heartbeatIssue")(
		function* (orgId, actorId, issueId) {
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
			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ leaseExpiresAt: new Date(leaseExpiresAt), updatedAt: new Date(timestamp) })
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
		},
	)

	const releaseIssue: ErrorsServiceShape["releaseIssue"] = Effect.fn("ErrorsService.releaseIssue")(
		function* (orgId, actorId, issueId, opts) {
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
						updatedAt: new Date(timestamp),
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
			const timestamp = yield* Clock.currentTimeMillis
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
					.set({ assignedActorId: toActorId, updatedAt: new Date(timestamp) })
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

	// Inserts an escalation-outbox row when severity is newly set or strictly
	// escalates; the alerting worker's escalation tick drains the outbox.
	// Detector-initial severity never escalates — only triage outcomes do.
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
					id: randomUUID(),
					orgId,
					issueId,
					severity: to,
					source,
					reason,
					runId: null,
					payloadJson: {},
					status: "queued",
					attempts: 0,
					dedupeKey: escalationDedupeKey(orgId, issueId, to),
					error: null,
					createdAt: new Date(timestamp),
					processedAt: null,
				})
				.onConflictDoNothing(),
		)
	})

	const setSeverity: ErrorsServiceShape["setSeverity"] = Effect.fn("ErrorsService.setSeverity")(
		function* (orgId, actorId, issueId, severity, opts) {
			const timestamp = yield* Clock.currentTimeMillis
			const source = opts?.source ?? "manual"
			yield* Effect.annotateCurrentSpan({ orgId, issueId, severity: severity ?? "null", source })
			const current = yield* requireIssue(orgId, issueId)

			// Precedence: manual > ai. An AI write never clobbers a manual
			// severity; the human's call stands until a human changes it.
			if (source === "ai" && current.severitySource === "manual") {
				return yield* hydrateIssue(orgId, current)
			}

			const nextSource: IssueSeveritySource | null = severity === null ? null : source
			const changed = current.severity !== severity || current.severitySource !== nextSource
			if (!changed) {
				return yield* hydrateIssue(orgId, current)
			}

			yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ severity, severitySource: nextSource, updatedAt: new Date(timestamp) })
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId))),
			)

			if (current.severity !== severity) {
				const payload: Record<string, unknown> = {
					from: current.severity,
					to: severity,
					source,
				}
				if (opts?.note) payload.note = opts.note
				yield* recordEvent(orgId, issueId, actorId, "severity_change", {
					payload,
					timestamp,
				})
			}

			if (severity !== null) {
				yield* enqueueSeverityEscalation(orgId, issueId, current.severity, severity, source)
			}

			yield* touchActor(orgId, actorId, timestamp)
			const next = yield* requireIssue(orgId, issueId)
			return yield* hydrateIssue(orgId, next)
		},
	)

	const commentOnIssue: ErrorsServiceShape["commentOnIssue"] = Effect.fn("ErrorsService.commentOnIssue")(
		function* (orgId, actorId, issueId, body, opts) {
			const timestamp = yield* Clock.currentTimeMillis
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
				payloadJson: payload,
				createdAt: new Date(timestamp),
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
					payloadJson: payload,
					createdAt: new Date(timestamp),
				},
				actorMap,
			)
		},
	)

	const proposeFix: ErrorsServiceShape["proposeFix"] = Effect.fn("ErrorsService.proposeFix")(
		function* (orgId, actorId, issueId, request) {
			const timestamp = yield* Clock.currentTimeMillis
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

	const decodeAlertDestinationIds = Schema.decodeUnknownOption(
		ErrorNotificationPolicyDocument.fields.destinationIds,
	)

	const defaultPolicy = (orgId: OrgId, timestamp: number): ErrorNotificationPolicyRow => ({
		orgId,
		enabled: false,
		destinationIdsJson: [],
		notifyOnFirstSeen: true,
		notifyOnRegression: true,
		notifyOnResolve: false,
		notifyOnTransitionInReview: false,
		notifyOnTransitionDone: false,
		notifyOnClaim: false,
		minOccurrenceCount: 1,
		severity: "warning",
		updatedAt: new Date(timestamp),
		updatedBy: "system",
	})

	const parsePolicyDestinations = (raw: unknown): ReadonlyArray<AlertDestinationId> =>
		Option.getOrElse(
			Option.flatMap(decodeStoredJsonArray(raw), (parsed) =>
				decodeAlertDestinationIds(parsed.filter((v) => typeof v === "string")),
			),
			() => [],
		)

	const rowToPolicy = (row: ErrorNotificationPolicyRow) =>
		new ErrorNotificationPolicyDocument({
			enabled: row.enabled,
			destinationIds: parsePolicyDestinations(row.destinationIdsJson),
			notifyOnFirstSeen: row.notifyOnFirstSeen,
			notifyOnRegression: row.notifyOnRegression,
			notifyOnResolve: row.notifyOnResolve,
			notifyOnTransitionInReview: row.notifyOnTransitionInReview,
			notifyOnTransitionDone: row.notifyOnTransitionDone,
			notifyOnClaim: row.notifyOnClaim,
			minOccurrenceCount: row.minOccurrenceCount,
			severity: row.severity,
			updatedAt: isoFromDate(row.updatedAt),
			updatedBy: decodeUserIdSync(row.updatedBy),
		})

	const loadPolicyRow = Effect.fn("ErrorsService.loadPolicyRow")(function* (orgId: OrgId) {
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
		const nowMs = yield* Clock.currentTimeMillis
		return rowToPolicy(row ?? defaultPolicy(orgId, nowMs))
	})

	const upsertNotificationPolicy: ErrorsServiceShape["upsertNotificationPolicy"] = Effect.fn(
		"ErrorsService.upsertNotificationPolicy",
	)(function* (orgId, userId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const existing = yield* loadPolicyRow(orgId)
		const timestamp = yield* Clock.currentTimeMillis
		const base = existing ?? defaultPolicy(orgId, timestamp)

		const nextDestinations =
			request.destinationIds !== undefined ? request.destinationIds : base.destinationIdsJson

		const toFlag = (value: boolean | undefined, fallback: boolean): boolean =>
			value === undefined ? fallback : value

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
			updatedAt: new Date(timestamp),
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

	// ---------------------------------------------------------------
	// Escalation policy (per-org severity → destination routing).
	// ---------------------------------------------------------------

	const decodeEscalationRules = Schema.decodeUnknownOption(
		Schema.Array(IssueEscalationPolicyRule),
	)

	const escalationRowToDocument = (row: IssueEscalationPolicyRow | null) =>
		new IssueEscalationPolicyDocument({
			enabled: row?.enabled ?? false,
			rules: row == null ? [] : Option.getOrElse(decodeEscalationRules(row.rulesJson), () => []),
			updatedAt: row == null ? null : isoFromDate(row.updatedAt),
			updatedBy: row == null || row.updatedBy === "system" ? null : decodeUserIdSync(row.updatedBy),
		})

	const loadEscalationPolicyRow = Effect.fn("ErrorsService.loadEscalationPolicyRow")(function* (
		orgId: OrgId,
	) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalationPolicies)
				.where(eq(issueEscalationPolicies.orgId, orgId))
				.limit(1),
		)
		return rows[0] ?? null
	})

	const getEscalationPolicy: ErrorsServiceShape["getEscalationPolicy"] = Effect.fn(
		"ErrorsService.getEscalationPolicy",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		return escalationRowToDocument(yield* loadEscalationPolicyRow(orgId))
	})

	const upsertEscalationPolicy: ErrorsServiceShape["upsertEscalationPolicy"] = Effect.fn(
		"ErrorsService.upsertEscalationPolicy",
	)(function* (orgId, userId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const existing = yield* loadEscalationPolicyRow(orgId)
		const timestamp = yield* Clock.currentTimeMillis

		if (request.rules !== undefined) {
			const seen = new Set<string>()
			for (const rule of request.rules) {
				if (seen.has(rule.severity)) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: "Escalation policy has duplicate severity rules",
							details: [rule.severity],
						}),
					)
				}
				seen.add(rule.severity)
			}

			// Reject destination IDs that don't belong to this org at write time.
			// Dispatch re-filters by org anyway (no cross-org leak), but a typo'd
			// or foreign ID would otherwise only surface much later as a silently
			// "skipped" escalation with reason no_enabled_destinations.
			const referencedIds = Array.from(new Set(request.rules.flatMap((rule) => rule.destinationIds)))
			if (referencedIds.length > 0) {
				const ownedRows = yield* Effect.forEach(
					Arr.chunksOf(referencedIds, D1_INARRAY_CHUNK_SIZE),
					(chunk) =>
						dbExecute((db) =>
							db
								.select({ id: alertDestinations.id })
								.from(alertDestinations)
								.where(
									and(
										eq(alertDestinations.orgId, orgId),
										inArray(alertDestinations.id, chunk),
									),
								),
						),
				)
				const owned = new Set(ownedRows.flatMap((rows) => rows.map((r) => r.id)))
				const unknown = referencedIds.filter((id) => !owned.has(id))
				if (unknown.length > 0) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: "Escalation policy references unknown destinations",
							details: unknown,
						}),
					)
				}
			}
		}

		const merged: IssueEscalationPolicyRow = {
			orgId,
			enabled: request.enabled !== undefined ? request.enabled : (existing?.enabled ?? false),
			rulesJson: request.rules !== undefined ? request.rules : (existing?.rulesJson ?? []),
			updatedAt: new Date(timestamp),
			updatedBy: userId,
		}

		yield* dbExecute((db) =>
			db
				.insert(issueEscalationPolicies)
				.values(merged)
				.onConflictDoUpdate({
					target: issueEscalationPolicies.orgId,
					set: {
						enabled: merged.enabled,
						rulesJson: merged.rulesJson,
						updatedAt: merged.updatedAt,
						updatedBy: merged.updatedBy,
					},
				}),
		)

		return escalationRowToDocument(merged)
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
		if (!policy.enabled) return Effect.void
		if (params.count < policy.minOccurrenceCount) return Effect.void
		if (params.reason === "first_seen" && !policy.notifyOnFirstSeen) return Effect.void
		if (params.reason === "regression" && !policy.notifyOnRegression) return Effect.void

		const destinationIds = parsePolicyDestinations(policy.destinationIdsJson)
		if (destinationIds.length === 0) return Effect.void

		return dispatcher
			.dispatch(orgId, destinationIds, {
				deliveryKey: `err:${orgId}:${params.incidentId}:open`,
				ruleId: params.issueId,
				ruleName: `${params.exceptionType} in ${params.serviceName}`,
				groupKey: params.serviceName,
				signalType: "error_rate",
				severity: policy.severity,
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
		if (!policy.enabled) return Effect.void
		if (!policy.notifyOnResolve) return Effect.void

		const destinationIds = parsePolicyDestinations(policy.destinationIdsJson)
		if (destinationIds.length === 0) return Effect.void

		return dispatcher
			.dispatch(orgId, destinationIds, {
				deliveryKey: `err:${orgId}:${params.incidentId}:resolve`,
				ruleId: params.issueId,
				ruleName: `${params.exceptionType} in ${params.serviceName}`,
				groupKey: params.serviceName,
				signalType: "error_rate",
				severity: policy.severity,
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

	const maybeNotifyTransition = Effect.fn("ErrorsService.maybeNotifyTransition")(function* (
		orgId: OrgId,
		actorId: ActorId | null,
		row: ErrorIssueRow,
		fromState: WorkflowState,
	) {
		const policyRow = yield* loadPolicyRow(orgId)
		if (!policyRow || !policyRow.enabled) return
		const toState = row.workflowState
		if (toState === fromState) return
		const destinationIds = parsePolicyDestinations(policyRow.destinationIdsJson)
		if (destinationIds.length === 0) return

		const shouldNotify =
			(toState === "in_review" && policyRow.notifyOnTransitionInReview) ||
			(toState === "done" && policyRow.notifyOnTransitionDone)
		if (!shouldNotify) return

		yield* dispatcher
			.dispatch(orgId, destinationIds, {
				deliveryKey: `err:${orgId}:${row.id}:transition:${toState}:${row.updatedAt.getTime()}`,
				ruleId: row.id,
				ruleName: `${row.exceptionType} in ${row.serviceName}`,
				groupKey: row.serviceName,
				signalType: "error_rate",
				severity: policyRow.severity,
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

	const maybeNotifyClaim = Effect.fn("ErrorsService.maybeNotifyClaim")(function* (
		orgId: OrgId,
		actorId: ActorId,
		row: ErrorIssueRow,
	) {
		const policyRow = yield* loadPolicyRow(orgId)
		if (!policyRow || !policyRow.enabled) return
		if (!policyRow.notifyOnClaim) return
		const destinationIds = parsePolicyDestinations(policyRow.destinationIdsJson)
		if (destinationIds.length === 0) return

		yield* dispatcher
			.dispatch(orgId, destinationIds, {
				deliveryKey: `err:${orgId}:${row.id}:claim:${(row.claimedAt ?? row.updatedAt).getTime()}`,
				ruleId: row.id,
				ruleName: `${row.exceptionType} in ${row.serviceName}`,
				groupKey: row.serviceName,
				signalType: "error_rate",
				severity: policyRow.severity,
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
						lt(errorIssues.leaseExpiresAt, new Date(nowMs)),
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
							updatedAt: new Date(nowMs),
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
		isActive: boolean,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, runRetention, isActive })
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
						lt(errorIssues.snoozeUntil, new Date(windowEndMs)),
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

		// `isActive` is false only for orgs with neither recent errors nor existing
		// issue/incident state, so skipping the scan loses nothing: there is
		// nothing to detect and nothing to resolve. The cheap D1 housekeeping above
		// (lease expiry, snooze wakeup) and below (retention) still runs for every
		// known org regardless.
		const issuesCompiled = CH.compile(CH.errorIssuesQuery({ limit: 500 }), {
			orgId,
			startTime: toTinybirdDateTime(windowStartMs),
			endTime: toTinybirdDateTime(windowEndMs),
		})
		const issuesRaw = isActive
			? yield* warehouse
					.compiledQuery(tenant, issuesCompiled, { profile: "list", context: "errorIssuesScan" })
					.pipe(Effect.mapError(makePersistenceError))
			: []

		const rows = issuesRaw.map((raw) => ({
			fingerprintHash: String(raw.fingerprintHash ?? ""),
			serviceName: String(raw.serviceName ?? ""),
			exceptionType: String(raw.exceptionType ?? ""),
			exceptionMessage: String(raw.exceptionMessage ?? ""),
			errorLabel: String(raw.errorLabel ?? ""),
			topFrame: String(raw.topFrame ?? ""),
			count: Number(raw.count ?? 0),
			affectedServicesCount: Number(raw.affectedServicesCount ?? 0),
			firstSeen: String(raw.firstSeen ?? ""),
			lastSeen: String(raw.lastSeen ?? ""),
		}))

		const fingerprintResults = yield* Effect.forEach(rows, (row) =>
			Effect.gen(function* () {
				const firstSeenMs = parseWarehouseDateTime(row.firstSeen)
				const lastSeenMs = parseWarehouseDateTime(row.lastSeen)
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
						(prior.snoozeUntil == null || prior.snoozeUntil.getTime() > windowEndMs)
					) {
						return { touched: 0, opened: 0 }
					}

					yield* dbExecute((db) =>
						db
							.update(errorIssues)
							.set({
								lastSeenAt: new Date(lastSeenMs),
								occurrenceCount: sql`${errorIssues.occurrenceCount} + ${row.count}`,
								errorLabel: row.errorLabel,
								updatedAt: new Date(windowEndMs),
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
							errorLabel: row.errorLabel,
							topFrame: row.topFrame,
							workflowState: "triage",
							priority: 3,
							assignedActorId: null,
							leaseHolderActorId: null,
							leaseExpiresAt: null,
							claimedAt: null,
							notes: null,
							firstSeenAt: new Date(firstSeenMs),
							lastSeenAt: new Date(lastSeenMs),
							occurrenceCount: row.count,
							resolvedAt: null,
							resolvedByActorId: null,
							snoozeUntil: null,
							archivedAt: null,
							createdAt: new Date(windowEndMs),
							updatedAt: new Date(windowEndMs),
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
						.where(and(eq(errorIssueStates.orgId, orgId), eq(errorIssueStates.issueId, issueId)))
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
							firstTriggeredAt: new Date(firstSeenMs),
							lastTriggeredAt: new Date(lastSeenMs),
							resolvedAt: null,
							occurrenceCount: row.count,
							createdAt: new Date(windowEndMs),
							updatedAt: new Date(windowEndMs),
						}),
					)

					yield* dbExecute((db) =>
						db
							.insert(errorIssueStates)
							.values({
								orgId,
								issueId,
								lastObservedOccurrenceAt: new Date(lastSeenMs),
								lastEvaluatedAt: new Date(windowEndMs),
								openIncidentId: incidentId,
								updatedAt: new Date(windowEndMs),
							})
							.onConflictDoUpdate({
								target: [errorIssueStates.orgId, errorIssueStates.issueId],
								set: {
									lastObservedOccurrenceAt: new Date(lastSeenMs),
									lastEvaluatedAt: new Date(windowEndMs),
									openIncidentId: incidentId,
									updatedAt: new Date(windowEndMs),
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

					// AI auto-triage (org opt-in). maybeEnqueueTriage never fails, so a
					// triage problem can't take down the error tick.
					yield* maybeEnqueueTriage({
						orgId,
						incidentKind: "error",
						incidentId,
						issueId,
						context: {
							kind: "error",
							reason,
							serviceName: row.serviceName,
							exceptionType: row.exceptionType,
							exceptionMessage: row.exceptionMessage,
							errorLabel: row.errorLabel,
							topFrame: row.topFrame,
							fingerprintHash: row.fingerprintHash,
							occurrenceCount: row.count,
							firstSeen: row.firstSeen,
							lastSeen: row.lastSeen,
							issueId,
						},
						workflowBinding: aiTriageWorkflowBinding,
					}).pipe(Effect.provideService(Database, database))

					return { touched: 1, opened: 1 }
				} else {
					yield* dbExecute((db) =>
						db
							.update(errorIncidents)
							.set({
								lastTriggeredAt: new Date(lastSeenMs),
								occurrenceCount: sql`${errorIncidents.occurrenceCount} + ${row.count}`,
								updatedAt: new Date(windowEndMs),
							})
							.where(eq(errorIncidents.id, openIncidentIdRaw)),
					)
					yield* dbExecute((db) =>
						db
							.update(errorIssueStates)
							.set({
								lastObservedOccurrenceAt: new Date(lastSeenMs),
								lastEvaluatedAt: new Date(windowEndMs),
								updatedAt: new Date(windowEndMs),
							})
							.where(
								and(eq(errorIssueStates.orgId, orgId), eq(errorIssueStates.issueId, issueId)),
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
						lt(errorIncidents.lastTriggeredAt, new Date(cutoffMs)),
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
							resolvedAt: new Date(windowEndMs),
							updatedAt: new Date(windowEndMs),
						})
						.where(eq(errorIncidents.id, incident.id)),
				)
				yield* dbExecute((db) =>
					db
						.update(errorIssueStates)
						.set({ openIncidentId: null, updatedAt: new Date(windowEndMs) })
						.where(
							and(
								eq(errorIssueStates.orgId, orgId),
								eq(errorIssueStates.issueId, incident.issueId),
							),
						),
				)

				if (policy.enabled && policy.notifyOnResolve) {
					const issueRows = yield* dbExecute((db) =>
						db
							.select({
								serviceName: errorIssues.serviceName,
								exceptionType: errorIssues.exceptionType,
							})
							.from(errorIssues)
							.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, incident.issueId)))
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
					.set({ archivedAt: new Date(windowEndMs), updatedAt: new Date(windowEndMs) })
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.workflowState, "done"),
							isNull(errorIssues.archivedAt),
							isNotNull(errorIssues.resolvedAt),
							lt(errorIssues.resolvedAt, new Date(resolvedCutoff)),
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
							lt(errorIssues.archivedAt, new Date(archivedCutoff)),
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
		const endMs = yield* Clock.currentTimeMillis
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

		const activeOrgs = yield* resolveActiveOrgs([...knownOrgs], endMs)
		// Orgs that hold issue/incident state must be scanned even with no recent
		// errors: the scan returning empty is what drives auto-resolution and
		// aging. Only pure ingest-key-only orgs with neither recent errors nor
		// existing state are skipped.
		const withState = new Set<string>([
			...stateOrgs.map((r) => r.orgId),
			...issueOrgs.map((r) => r.orgId),
		])
		const isActive = (org: string) => activeOrgs.has(org) || withState.has(org)

		const emptyResult = {
			issuesTouched: 0,
			incidentsOpened: 0,
			incidentsResolved: 0,
			issuesReopened: 0,
			issuesArchived: 0,
			issuesDeleted: 0,
			leasesExpired: 0,
		}

		const orgFailures = yield* Ref.make(0)
		const results = yield* Effect.forEach(
			[...knownOrgs],
			(org) =>
				processOrg(org as OrgId, startMs, endMs, retentionRan, isActive(org)).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							yield* Effect.logError("Error tick failed for org").pipe(
								Effect.annotateLogs({
									orgId: org,
									error: Cause.pretty(cause),
								}),
							)
							yield* Ref.update(orgFailures, (n) => n + 1)
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
			orgsScanned: activeOrgs.size,
			orgFailures: yield* Ref.get(orgFailures),
			...totals,
		})

		return {
			orgsProcessed: knownOrgs.size,
			...totals,
			retentionRan,
		}
	})

	return ErrorsService.of({
		listIssues,
		getIssue,
		transitionIssue,
		claimIssue,
		heartbeatIssue,
		releaseIssue,
		assignIssue,
		setSeverity,
		commentOnIssue,
		proposeFix,
		listIssueEvents,
		recordAnomalyLinkEvent,
		registerAgent,
		listAgents,
		lookupActor,
		ensureUserActor,
		listIssueIncidents,
		listOpenIncidents,
		getNotificationPolicy,
		upsertNotificationPolicy,
		getEscalationPolicy,
		upsertEscalationPolicy,
		runTick,
	})
})

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceShape>()(
	"@maple/api/services/ErrorsService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
