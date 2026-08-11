import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	type AlertDestinationId,
	ErrorIncidentDocument,
	ErrorIncidentsListResponse,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	ErrorIssueEventId as ErrorIssueEventIdSchema,
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
	EscalationDestinationOutcome,
	EscalationPolicyEvaluationDocument,
	type EscalationPolicyEvaluationRequest,
	EscalationSkipReason,
	IssueEscalationAttemptDocument,
	IssueEscalationAttemptsResponse,
	IssueEscalationPolicyDocument,
	IssueEscalationPolicyRule,
	type IssueEscalationPolicyUpsertRequest,
	IssueListCursor,
	type IssueListCursorFields,
	IssueSeverityListCursor,
	type IssueSeverityListCursorFields,
	type IssueKind,
	type IssueSeverity,
	type OrgId,
	RoleName,
	SpanId as SpanIdSchema,
	TraceId as TraceIdSchema,
	type UserId,
	UserId as UserIdSchema,
	type WorkflowState,
	TERMINAL_WORKFLOW_STATES,
} from "@maple/domain/http"
import {
	actors,
	errorIncidents,
	type ErrorIncidentRow,
	errorNotificationDeliveries,
	type ErrorNotificationDeliveryRow,
	errorIssues,
	errorIssueEvents,
	type ErrorIssueRow,
	alertDestinations,
	errorIssueStates,
	errorNotificationPolicies,
	type ErrorNotificationPolicyRow,
	errorTickStates,
	issueEscalationPolicies,
	type IssueEscalationPolicyRow,
	type IssueEscalationRow,
	issueEscalations,
	orgClickHouseSettings,
	orgIngestKeys,
} from "@maple/db"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import {
	CH,
	parseWarehouseDateTime,
	warehouseDateTimeToIso,
	formatWarehouseDateTime,
} from "@maple/query-engine"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	HashSet,
	Layer,
	Match,
	Option,
	Ref,
	Schema,
} from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { INVESTIGATION_FANOUT_BINDING, maybeEnqueueTriage } from "@/services/errors/ai-triage-enqueue"
import { isErrorTickClaimLost, persistErrorTickWindow } from "@/services/errors/error-tick-persistence"
import { SYSTEM_ERRORS_AGENT_NAME } from "@/services/auth/system-actors"
import { evaluateEscalationPolicy } from "@/services/alerts/escalation-policy"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Database } from "@/platform/DatabaseLive"
import { selectDistinctOrgIds } from "@/platform/distinct-org-ids"
import { Env } from "@/platform/Env"
import { NotificationDispatcher, type NotificationRequest } from "@/services/alerts/NotificationDispatcher"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { EdgeCacheService } from "@maple/cache"
import {
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
} from "@/services/warehouse/warehouse-org-quarantine"
import { actorRowToDocument, ErrorActorsService, type ErrorActorsPublicShape } from "./ErrorActorsService"
import { ErrorIssueWorkflowService, type ErrorIssueWorkflowPublicShape } from "./ErrorIssueWorkflowService"
import { makeErrorDatabaseExecute, makePersistenceError } from "./error-persistence"

export { describeCause, makePersistenceError } from "./error-persistence"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const encodeIssueListCursor = Schema.encodeSync(IssueListCursor)
const encodeIssueSeverityListCursorRaw = Schema.encodeSync(IssueSeverityListCursor)
const encodeIssueSeverityListCursor = (fields: IssueSeverityListCursorFields): string =>
	`sev_${encodeIssueSeverityListCursorRaw(fields)}`
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeTraceIdSync = Schema.decodeUnknownSync(TraceIdSchema)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanIdSchema)

// Lenient decoders for JSON stored in jsonb columns. Decode failures fall back
// to an empty/null value at each call site — stored blobs are best-effort.
const decodeStoredJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const ErrorNotificationOutboxPayload = Schema.Struct({
	kind: Schema.Literals(["open", "resolve"]),
	issueId: Schema.String,
	incidentId: Schema.String,
	serviceName: Schema.String,
	exceptionType: Schema.String,
	severity: Schema.Literals(["warning", "critical"]),
	threshold: Schema.Number,
	count: Schema.Number,
})
type ErrorNotificationOutboxPayload = Schema.Schema.Type<typeof ErrorNotificationOutboxPayload>
const decodeErrorNotificationOutboxPayload = Schema.decodeUnknownOption(ErrorNotificationOutboxPayload)

const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
/** Fallback fingerprint-scan window for the issue list's env filter when the
 *  caller provides no time range (30d ≈ the issue-list retention horizon). */
const ENV_FINGERPRINT_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const AUTO_RESOLVE_MINUTES = 30
const TICK_MINUTE_MS = 60_000
/** Wait one full minute beyond bucket close so ordinary OTLP/exporter lag lands
 * before the event-time cursor makes the bucket immutable. */
const TICK_INGESTION_LAG_MS = TICK_MINUTE_MS
const TICK_BOOTSTRAP_WINDOW_MS = 2 * TICK_MINUTE_MS
/** Bound one warehouse query without dropping backlog: a lagging cursor advances
 * by at most this much per cron and continues catching up on later invocations.
 * Five minutes recovers a one-hour outage in ~12 crons while keeping the widest
 * possible apply at ~5x steady state, so a backlog can never grow a window the
 * transaction cannot commit inside its lease. */
const TICK_MAX_WINDOW_MS = 5 * TICK_MINUTE_MS
/** Time alone does not bound work: fingerprint cardinality can explode inside a
 * single minute (a UUID leaking into an exception message). Above this many
 * fingerprints the window is halved and rescanned before anything is applied. */
const TICK_MAX_WINDOW_ROWS = 20_000
/** Halving floor. The rollup is minute-grain, so a one-minute window is
 * indivisible — below that, splitting cannot shed rows. */
const TICK_MAX_WINDOW_SPLITS = 4
const TICK_CLAIM_TTL_MS = 5 * TICK_MINUTE_MS
const NOTIFICATION_CLAIM_TTL_MS = 30_000
const NOTIFICATION_OUTBOX_BATCH_SIZE = 100
const NOTIFICATION_MAX_ATTEMPTS = 5
/** Active-org discovery window — a superset of the bootstrap scan window so an org
 *  with recent errors still gets scanned, with slack for
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
/**
 * Retention runs one tick an hour. The phase is bucketed on the CRON period,
 * not on the evaluator's catch-up window: the alerting cron fires every minute,
 * so lifecycle work is bucketed on that one-minute cadence.
 */
const RETENTION_PHASE_PERIOD_MS = 60_000
const RETENTION_PHASE_EVERY_N_TICKS = 60
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEASE_DURATION_MS = 30 * 60_000
const SYSTEM_AGENT_NAME = SYSTEM_ERRORS_AGENT_NAME
const ACTIONABLE_WORKFLOW_STATES: ReadonlyArray<WorkflowState> = [
	"triage",
	"todo",
	"in_progress",
	"in_review",
]

/** Shared SQL ordering expression for the UI's critical-first issue ordering. */
const issueSeverityOrder = sql<number>`CASE ${errorIssues.severity}
	WHEN 'critical' THEN 0
	WHEN 'high' THEN 1
	WHEN 'medium' THEN 2
	WHEN 'low' THEN 3
	ELSE 4
END`

const severitySortRank = (severity: IssueSeverity | null): number =>
	Match.value(severity).pipe(
		Match.when("critical", () => 0),
		Match.when("high", () => 1),
		Match.when("medium", () => 2),
		Match.when("low", () => 3),
		Match.when(null, () => 4),
		Match.exhaustive,
	)

export interface ErrorsServiceShape extends ErrorActorsPublicShape, ErrorIssueWorkflowPublicShape {
	readonly listIssues: (
		orgId: OrgId,
		opts: {
			readonly workflowState?: WorkflowState
			readonly severity?: IssueSeverity | "unset"
			readonly kind?: IssueKind
			readonly service?: string
			/** Only issues whose fingerprint the warehouse observed in this
			 *  deployment environment (within startTime/endTime, defaulting to the
			 *  trailing 30d). Costs one warehouse round-trip; excludes alert-kind
			 *  issues (synthetic fingerprints carry no environment). */
			readonly deploymentEnv?: string
			readonly assignedActorId?: ActorId
			readonly includeArchived?: boolean
			readonly startTime?: string
			readonly endTime?: string
			readonly limit?: number
			readonly cursor?: IssueListCursorFields | IssueSeverityListCursorFields
			readonly actionable?: boolean
			readonly sort?: "last_seen" | "severity"
		},
	) => Effect.Effect<ErrorIssuesListResponse, ErrorPersistenceError>
	/**
	 * Fleet-level open (actionable-state) error-issue counts grouped by service
	 * name. One Postgres GROUP BY over the org's actionable subset; alert-kind
	 * issues are excluded because their serviceName can be empty or synthetic.
	 */
	readonly countOpenIssuesByService: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<{ readonly serviceName: string; readonly openCount: number }>,
		ErrorPersistenceError
	>
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
	readonly evaluateEscalationPolicy: (
		orgId: OrgId,
		request: EscalationPolicyEvaluationRequest,
	) => Effect.Effect<EscalationPolicyEvaluationDocument, ErrorPersistenceError>
	readonly listIssueEscalations: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<IssueEscalationAttemptsResponse, ErrorPersistenceError>
	readonly listRecentEscalations: (
		orgId: OrgId,
		limit?: number,
	) => Effect.Effect<IssueEscalationAttemptsResponse, ErrorPersistenceError>
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
	| Database
	| WarehouseQueryService
	| EdgeCacheService
	| Env
	| NotificationDispatcher
	| ErrorActorsService
	| ErrorIssueWorkflowService
> = Effect.gen(function* () {
	const database = yield* Database
	const actorService = yield* ErrorActorsService
	const workflow = yield* ErrorIssueWorkflowService
	const warehouse = yield* WarehouseQueryService
	const edgeCache = yield* EdgeCacheService
	const env = yield* Env
	const dispatcher = yield* NotificationDispatcher
	// Optional: present only inside a Worker isolate. Used to kick off the
	// AI triage Workflow when an incident opens (org opt-in).
	const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
	const investigationFanoutBinding = Option.match(workerEnv, {
		onNone: () => undefined,
		onSome: (e) => e[INVESTIGATION_FANOUT_BINDING],
	})

	const newErrorIssueId = () => decodeErrorIssueIdSync(randomUUID())
	const newErrorIncidentId = () => decodeErrorIncidentIdSync(randomUUID())
	const newEventId = () => decodeEventIdSync(randomUUID())

	const dbExecute = makeErrorDatabaseExecute(database)

	const isoFromDate = (date: Date) => decodeIsoDateTimeStringSync(date.toISOString())

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

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

	const resolveActiveOrgs = Effect.fn("ErrorsService.resolveActiveOrgs")(function* (
		knownOrgs: ReadonlyArray<string>,
		nowMs: number,
	) {
		yield* Effect.annotateCurrentSpan("knownOrgs", knownOrgs.length)
		const byoRows = yield* dbExecute((db) =>
			db.selectDistinct({ orgId: orgClickHouseSettings.orgId }).from(orgClickHouseSettings),
		).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: string }>))
		const byo = new Set<string>(byoRows.map((r) => r.orgId))

		if (knownOrgs.length === 0) {
			yield* Effect.annotateCurrentSpan({ activeOrgs: byo.size, failedClosed: false })
			return byo as ReadonlySet<string>
		}

		const compiled = CH.compile(CH.activeOrgsByErrorEventsQuery(), {
			startTime: formatWarehouseDateTime(nowMs - ERROR_ACTIVE_DISCOVERY_WINDOW_MS),
		})
		return yield* warehouse
			.crossOrgQuery(systemTenant(knownOrgs[0] as OrgId), compiled, {
				// Bound the one cross-org scan (no OrgId predicate ⇒ can't prune the
				// primary key): abort server-side at 5s instead of riding the ~30s
				// client timeout when the warehouse is slow.
				profile: "discovery",
				context: "errorActiveOrgsDiscovery",
				justification:
					"enumerate orgs with recent error events so the error-issue sweep skips idle orgs",
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
				Effect.tap((active) =>
					Effect.annotateCurrentSpan({ activeOrgs: active.size, failedClosed: false }),
				),
				// Cache the freshly-discovered set so a later discovery failure can
				// reuse it instead of fanning out to all known orgs. Best-effort.
				Effect.tap((active) =>
					edgeCache
						.rawPut(
							ACTIVE_ORGS_CACHE_BUCKET,
							ACTIVE_ORGS_CACHE_KEY,
							[...active],
							ACTIVE_ORGS_CACHE_TTL_S,
						)
						.pipe(Effect.ignore),
				),
				// Fail CLOSED on a genuine discovery failure: reuse the last-known active
				// set. Interrupts (isolate teardown) are NOT failures — re-raise them so
				// the tick cancels promptly instead of running the fallback.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.gen(function* () {
								yield* Effect.logWarning(
									"Error active-org discovery failed; reusing last-known active set",
								).pipe(Effect.annotateLogs({ error: Cause.pretty(cause) }))
								const cached = yield* edgeCache
									.rawGet<ReadonlyArray<string>>(
										ACTIVE_ORGS_CACHE_BUCKET,
										ACTIVE_ORGS_CACHE_KEY,
									)
									.pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()))
								const active = new Set<string>(byo)
								for (const orgId of Option.getOrElse(
									cached,
									() => [] as ReadonlyArray<string>,
								)) {
									active.add(orgId)
								}
								yield* Effect.annotateCurrentSpan({
									activeOrgs: active.size,
									failedClosed: true,
								})
								return active as ReadonlySet<string>
							}),
				),
			)
	})

	// Actors
	const {
		registerAgent,
		listAgents,
		lookupActor,
		ensureUserActor,
		ensureSystemActor,
		touchActor,
		collectActorDocs,
	} = actorService
	const rowToActor = actorRowToDocument
	const {
		rowToIssue,
		requireIssue,
		issuesWithOpenIncidents,
		hydrateIssue,
		recordEvent,
		applyTransition,
		heartbeatIssue,
		releaseIssue,
		assignIssue,
		setSeverity,
		commentOnIssue,
		listIssueEvents,
	} = workflow

	// Issue row -> document mapping

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

	// Events / audit log

	const recordAnomalyLinkEvent: ErrorsServiceShape["recordAnomalyLinkEvent"] = Effect.fn(
		"ErrorsService.recordAnomalyLinkEvent",
	)(function* (orgId, issueId, actorId, payload) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId, action: payload.action })
		yield* recordEvent(orgId, issueId, actorId, "anomaly_linked", { payload: { ...payload } })
	})

	// Issue list + detail

	const listIssues: ErrorsServiceShape["listIssues"] = Effect.fn("ErrorsService.listIssues")(
		function* (orgId, opts) {
			const sort = opts.sort ?? "last_seen"
			yield* Effect.annotateCurrentSpan({
				orgId,
				workflowState: opts.workflowState ?? "all",
				limit: opts.limit ?? 100,
				sort,
				...(opts.deploymentEnv ? { deploymentEnv: opts.deploymentEnv } : {}),
			})
			const conditions = [eq(errorIssues.orgId, orgId)]
			if (opts.workflowState) conditions.push(eq(errorIssues.workflowState, opts.workflowState))
			if (opts.actionable)
				conditions.push(inArray(errorIssues.workflowState, ACTIONABLE_WORKFLOW_STATES))
			if (opts.severity === "unset") conditions.push(isNull(errorIssues.severity))
			else if (opts.severity) conditions.push(eq(errorIssues.severity, opts.severity))
			if (opts.kind) conditions.push(eq(errorIssues.kind, opts.kind))
			if (opts.service) conditions.push(eq(errorIssues.serviceName, opts.service))
			// `""` is a real filter (the raw value spans without a deployment env
			// carry — the UI's synthetic "unknown" label), so check for undefined.
			if (opts.deploymentEnv !== undefined) {
				// Issue rows carry no environment (a fingerprint spans environments), so
				// the env filter intersects against the fingerprints the warehouse saw in
				// the selected environment over the requested window. Alert-kind issues
				// have synthetic fingerprints that never match warehouse rows, so an env
				// filter implicitly narrows the list to error-kind issues.
				const nowMs = yield* Clock.currentTimeMillis
				const endMs = opts.endTime ? parseWarehouseDateTime(opts.endTime) : Number.NaN
				const startMs = opts.startTime ? parseWarehouseDateTime(opts.startTime) : Number.NaN
				const scanEndMs = Number.isFinite(endMs) ? endMs : nowMs
				const scanStartMs = Number.isFinite(startMs)
					? startMs
					: scanEndMs - ENV_FINGERPRINT_DEFAULT_WINDOW_MS
				const compiled = CH.compile(
					CH.errorFingerprintsQuery({
						services: opts.service ? [opts.service] : undefined,
						deploymentEnvs: [opts.deploymentEnv],
					}),
					{
						orgId,
						startTime: formatWarehouseDateTime(scanStartMs),
						endTime: formatWarehouseDateTime(scanEndMs),
					},
				)
				const fingerprintRows = yield* warehouse
					.compiledQuery(systemTenant(orgId), compiled, { context: "errorIssueEnvFingerprints" })
					.pipe(Effect.mapError((error) => makePersistenceError(error)))
				const hashes = fingerprintRows
					.map((row) => row.fingerprintHash)
					.filter((hash) => hash.length > 0)
				if (hashes.length === 0) {
					yield* Effect.annotateCurrentSpan({ issueCount: 0, hasMore: false })
					return new ErrorIssuesListResponse({ issues: [] })
				}
				conditions.push(inArray(errorIssues.fingerprintHash, hashes))
			}
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
			if (opts.cursor) {
				const cursorSeenAt = new Date(opts.cursor.lastSeenAt)
				// Keyset continuation must mirror the selected ordering exactly.
				const keyset =
					sort === "severity" && "severityRank" in opts.cursor
						? or(
								gt(issueSeverityOrder, opts.cursor.severityRank),
								and(
									eq(issueSeverityOrder, opts.cursor.severityRank),
									or(
										lt(errorIssues.lastSeenAt, cursorSeenAt),
										and(
											eq(errorIssues.lastSeenAt, cursorSeenAt),
											lt(errorIssues.id, opts.cursor.id),
										),
									),
								),
							)
						: or(
								lt(errorIssues.lastSeenAt, cursorSeenAt),
								and(
									eq(errorIssues.lastSeenAt, cursorSeenAt),
									lt(errorIssues.id, opts.cursor.id),
								),
							)
				if (keyset) conditions.push(keyset)
			}

			const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
			// Fetch one extra row: its presence means another page exists.
			const fetched = yield* dbExecute((db) => {
				const query = db
					.select()
					.from(errorIssues)
					.where(and(...conditions))
				return (
					sort === "severity"
						? query.orderBy(
								issueSeverityOrder,
								desc(errorIssues.lastSeenAt),
								desc(errorIssues.id),
							)
						: query.orderBy(desc(errorIssues.lastSeenAt), desc(errorIssues.id))
				).limit(limit + 1)
			})
			const hasMore = fetched.length > limit
			const rows = hasMore ? fetched.slice(0, limit) : fetched

			const issueIds = rows.map((r) => r.id)
			const openSet = yield* issuesWithOpenIncidents(orgId, issueIds)
			const actorMap = yield* collectActorDocs(
				orgId,
				rows.flatMap((r) => [r.assignedActorId ?? null, r.leaseHolderActorId ?? null]),
			)

			const issuesResult = rows.map((r) => rowToIssue(r, openSet.has(r.id), actorMap))
			yield* Effect.annotateCurrentSpan({ issueCount: issuesResult.length, hasMore })
			const lastRow = rows.at(-1)
			const nextCursor =
				hasMore && lastRow
					? sort === "severity"
						? encodeIssueSeverityListCursor({
								severityRank: severitySortRank(lastRow.severity),
								lastSeenAt: lastRow.lastSeenAt.getTime(),
								id: decodeErrorIssueIdSync(lastRow.id),
							})
						: encodeIssueListCursor({
								lastSeenAt: lastRow.lastSeenAt.getTime(),
								id: decodeErrorIssueIdSync(lastRow.id),
							})
					: undefined
			return new ErrorIssuesListResponse(
				nextCursor === undefined ? { issues: issuesResult } : { issues: issuesResult, nextCursor },
			)
		},
	)

	const countOpenIssuesByService: ErrorsServiceShape["countOpenIssuesByService"] = Effect.fn(
		"ErrorsService.countOpenIssuesByService",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db
				.select({
					serviceName: errorIssues.serviceName,
					openCount: sql<number>`count(*)::int`,
				})
				.from(errorIssues)
				.where(
					and(
						eq(errorIssues.orgId, orgId),
						inArray(errorIssues.workflowState, ACTIONABLE_WORKFLOW_STATES),
						eq(errorIssues.kind, "error"),
						isNull(errorIssues.archivedAt),
					),
				)
				.groupBy(errorIssues.serviceName),
		)
		const counts = rows.filter((row) => row.serviceName !== "")
		yield* Effect.annotateCurrentSpan({ serviceCount: counts.length })
		return counts
	})

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
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
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
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
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

	// State transitions

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

	// Claim / lease

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
			if (TERMINAL_WORKFLOW_STATES.has(current.workflowState)) {
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

	// Incidents (unchanged listings)

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

	// Notification policy (per-org) controlling incident delivery.

	const decodeAlertDestinationIds = Schema.decodeUnknownOption(
		ErrorNotificationPolicyDocument.fields.destinationIds,
	)

	// Mirrors the column defaults on `error_notification_policies` — an org with no
	// row must behave exactly like an org that just got one. Notifications are
	// enabled but route nowhere until a destination is picked, so the empty
	// `destinationIdsJson` (not `enabled`) is what holds delivery back. Setting
	// `enabled: false` here instead made CFG-NOTIF-01 report "turned off" for
	// row-less orgs and hid the real reason.
	const defaultPolicy = (orgId: OrgId, timestamp: number): ErrorNotificationPolicyRow => ({
		orgId,
		enabled: true,
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

	// Escalation policy (per-org severity → destination routing).

	const decodeEscalationRules = Schema.decodeUnknownOption(Schema.Array(IssueEscalationPolicyRule))

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
			const referencedIds = Arr.dedupe(Arr.flatMap(request.rules, (rule) => rule.destinationIds))
			if (referencedIds.length > 0) {
				const ownedRows = yield* dbExecute((db) =>
					db
						.select({ id: alertDestinations.id })
						.from(alertDestinations)
						.where(
							and(
								eq(alertDestinations.orgId, orgId),
								inArray(alertDestinations.id, referencedIds),
							),
						),
				)
				const owned = HashSet.fromIterable(Arr.map(ownedRows, (row) => row.id))
				const unknown = Arr.filter(referencedIds, (id) => !HashSet.has(owned, id))
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

	const decodeEscalationDeliveries = Schema.decodeUnknownOption(Schema.Array(EscalationDestinationOutcome))
	const decodeEscalationSkipReason = Schema.decodeUnknownOption(EscalationSkipReason)

	const escalationAttemptDocument = (row: IssueEscalationRow) =>
		new IssueEscalationAttemptDocument({
			id: row.id,
			issueId: row.issueId,
			investigationId: row.investigationId,
			severity: row.severity,
			source: row.source,
			reason: row.reason,
			status: row.status,
			attempts: row.attempts,
			skipReason:
				row.status === "skipped" ? Option.getOrNull(decodeEscalationSkipReason(row.error)) : null,
			deliveries: Option.getOrElse(decodeEscalationDeliveries(row.deliveryResultsJson), () => []),
			createdAt: isoFromDate(row.createdAt),
			processedAt: row.processedAt ? isoFromDate(row.processedAt) : null,
		})

	const evaluatePolicy: ErrorsServiceShape["evaluateEscalationPolicy"] = Effect.fn(
		"ErrorsService.evaluateEscalationPolicy",
	)(function* (orgId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const policy = yield* loadEscalationPolicyRow(orgId)
		const rules =
			policy == null ? [] : Option.getOrElse(decodeEscalationRules(policy.rulesJson), () => [])
		const referencedIds = Arr.dedupe(Arr.flatMap(rules, (rule) => rule.destinationIds))
		const enabledRows =
			referencedIds.length === 0
				? []
				: yield* dbExecute((db) =>
						db
							.select({ id: alertDestinations.id })
							.from(alertDestinations)
							.where(
								and(
									eq(alertDestinations.orgId, orgId),
									eq(alertDestinations.enabled, true),
									inArray(alertDestinations.id, referencedIds),
								),
							),
					)
		const decision = evaluateEscalationPolicy({
			enabled: policy?.enabled ?? false,
			rules,
			severity: request.severity,
			source: request.source,
			...(request.confidence === undefined ? {} : { confidence: request.confidence }),
			enabledDestinationIds: new Set(enabledRows.map((row) => row.id)),
		})
		return new EscalationPolicyEvaluationDocument({
			outcome: decision.outcome,
			destinationIds: [...decision.destinationIds],
			skipReason: decision.skipReason,
		})
	})

	const listIssueEscalations: ErrorsServiceShape["listIssueEscalations"] = Effect.fn(
		"ErrorsService.listIssueEscalations",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId })
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalations)
				.where(and(eq(issueEscalations.orgId, orgId), eq(issueEscalations.issueId, issueId)))
				.orderBy(desc(issueEscalations.createdAt)),
		)
		return new IssueEscalationAttemptsResponse({ attempts: rows.map(escalationAttemptDocument) })
	})

	const listRecentEscalations: ErrorsServiceShape["listRecentEscalations"] = Effect.fn(
		"ErrorsService.listRecentEscalations",
	)(function* (orgId, limit) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalations)
				.where(eq(issueEscalations.orgId, orgId))
				.orderBy(desc(issueEscalations.createdAt))
				.limit(limit ?? 25),
		)
		return new IssueEscalationAttemptsResponse({ attempts: rows.map(escalationAttemptDocument) })
	})

	const issueLinkUrl = (issueId: string) =>
		`${env.MAPLE_APP_BASE_URL}/errors/issues/${encodeURIComponent(issueId)}`

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

	const notificationWorkerId = `errors-${randomUUID()}`
	const claimableNotificationWhere = (currentTime: number) =>
		or(
			and(
				eq(errorNotificationDeliveries.status, "queued"),
				lte(errorNotificationDeliveries.scheduledAt, new Date(currentTime)),
			),
			and(
				eq(errorNotificationDeliveries.status, "processing"),
				isNotNull(errorNotificationDeliveries.claimExpiresAt),
				lte(errorNotificationDeliveries.claimExpiresAt, new Date(currentTime)),
			),
		)

	const notificationRequest = (
		row: ErrorNotificationDeliveryRow,
		payload: ErrorNotificationOutboxPayload,
	): NotificationRequest => ({
		deliveryKey: row.deliveryKey,
		ruleId: payload.issueId,
		ruleName: `${payload.exceptionType} in ${payload.serviceName}`,
		groupKey: payload.serviceName,
		signalType: "error_rate",
		severity: payload.severity,
		comparator: "gte",
		threshold: payload.threshold,
		eventType: payload.kind === "open" ? "trigger" : "resolve",
		incidentId: payload.incidentId,
		incidentStatus: payload.kind === "open" ? "open" : "resolved",
		dedupeKey: `error:${row.orgId}:${payload.issueId}`,
		windowMinutes: 1,
		value: payload.count,
		sampleCount: payload.count,
		linkUrl: issueLinkUrl(payload.issueId),
	})

	/**
	 * Drain a bounded batch from the error notification outbox. Delivery is
	 * at-least-once: a worker dying after the remote provider accepts a message
	 * but before the success update may retry it, so the stable deliveryKey is
	 * preserved for provider/consumer deduplication.
	 */
	const processNotificationOutbox = Effect.fn("ErrorsService.processNotificationOutbox")(function* () {
		const currentTime = yield* Clock.currentTimeMillis
		const due = yield* dbExecute((db) =>
			db
				.select()
				.from(errorNotificationDeliveries)
				.where(claimableNotificationWhere(currentTime))
				.orderBy(asc(errorNotificationDeliveries.scheduledAt))
				.limit(NOTIFICATION_OUTBOX_BATCH_SIZE),
		)

		yield* Effect.forEach(
			due,
			(row) =>
				Effect.gen(function* () {
					const claimedRows = yield* dbExecute((db) =>
						db
							.update(errorNotificationDeliveries)
							.set({
								status: "processing",
								attemptCount: sql`${errorNotificationDeliveries.attemptCount} + 1`,
								claimedAt: new Date(currentTime),
								claimExpiresAt: new Date(currentTime + NOTIFICATION_CLAIM_TTL_MS),
								claimedBy: notificationWorkerId,
								updatedAt: new Date(currentTime),
							})
							.where(
								and(
									eq(errorNotificationDeliveries.id, row.id),
									claimableNotificationWhere(currentTime),
								),
							)
							.returning(),
					)
					const claimed = claimedRows[0]
					if (!claimed) return

					const payloadOption = decodeErrorNotificationOutboxPayload(claimed.payloadJson)
					if (Option.isNone(payloadOption)) {
						yield* dbExecute((db) =>
							db
								.update(errorNotificationDeliveries)
								.set({
									status: "failed",
									attemptedAt: new Date(currentTime),
									errorMessage: "Stored error notification payload is invalid",
									claimedAt: null,
									claimExpiresAt: null,
									claimedBy: null,
									updatedAt: new Date(currentTime),
								})
								.where(
									and(
										eq(errorNotificationDeliveries.id, claimed.id),
										eq(errorNotificationDeliveries.claimedBy, notificationWorkerId),
									),
								),
						)
						return
					}

					const result = yield* dispatcher.dispatch(
						claimed.orgId,
						[claimed.destinationId],
						notificationRequest(claimed, payloadOption.value),
					)
					const destination = result.destinations?.[0]
					const delivered = destination?.status === "delivered" || result.delivered > 0
					const retryable = destination == null || destination.status === "failed"
					const exhausted = claimed.attemptCount >= NOTIFICATION_MAX_ATTEMPTS
					const retryDelayMs = Math.min(30_000 * 2 ** (claimed.attemptCount - 1), 15 * 60_000)

					yield* dbExecute((db) =>
						db
							.update(errorNotificationDeliveries)
							.set(
								delivered
									? {
											status: "success",
											attemptedAt: new Date(currentTime),
											errorMessage: null,
											claimedAt: null,
											claimExpiresAt: null,
											claimedBy: null,
											updatedAt: new Date(currentTime),
										}
									: retryable && !exhausted
										? {
												status: "queued",
												scheduledAt: new Date(currentTime + retryDelayMs),
												attemptedAt: new Date(currentTime),
												errorMessage:
													destination?.error ?? "Notification delivery failed",
												claimedAt: null,
												claimExpiresAt: null,
												claimedBy: null,
												updatedAt: new Date(currentTime),
											}
										: {
												status: "failed",
												attemptedAt: new Date(currentTime),
												errorMessage:
													destination?.error ??
													destination?.status ??
													"Notification delivery failed",
												claimedAt: null,
												claimExpiresAt: null,
												claimedBy: null,
												updatedAt: new Date(currentTime),
											},
							)
							.where(
								and(
									eq(errorNotificationDeliveries.id, claimed.id),
									eq(errorNotificationDeliveries.claimedBy, notificationWorkerId),
								),
							),
					)
				}),
			{ concurrency: 5 },
		)
	})

	// Scheduled tick

	/**
	 * The four unconditional reads at the head of every per-org tick, in ONE
	 * `Database.execute`. Under `DatabasePgLive` each execute dials and tears
	 * down its own postgres.js client, so the handshake count is what costs, not
	 * the statement count — same trade as `scrape-check-retention.ts`.
	 *
	 * The stale-incident sweep is deliberately NOT batched in here: it has to
	 * observe the `last_triggered_at` writes the fingerprint loop makes, so
	 * prefetching it would auto-resolve incidents this same tick re-triggered.
	 */
	const loadOrgTickPreamble = Effect.fn("ErrorsService.loadOrgTickPreamble")(function* (
		orgId: OrgId,
		nowMs: number,
	) {
		return yield* dbExecute(async (db) => {
			const actorRows = await db
				.select()
				.from(actors)
				.where(
					and(
						eq(actors.orgId, orgId),
						eq(actors.type, "agent"),
						eq(actors.agentName, SYSTEM_AGENT_NAME),
					),
				)
				.limit(1)
			const policyRows = await db
				.select()
				.from(errorNotificationPolicies)
				.where(eq(errorNotificationPolicies.orgId, orgId))
				.limit(1)
			const expiredLeases = await db
				.select()
				.from(errorIssues)
				.where(
					and(
						eq(errorIssues.orgId, orgId),
						isNotNull(errorIssues.leaseExpiresAt),
						lt(errorIssues.leaseExpiresAt, new Date(nowMs)),
					),
				)
			// Wake up wontfix issues whose snooze has elapsed, so that new events
			// observed in this tick are treated as regressions rather than skipped.
			const wakeCandidates = await db
				.select()
				.from(errorIssues)
				.where(
					and(
						eq(errorIssues.orgId, orgId),
						eq(errorIssues.workflowState, "wontfix"),
						isNotNull(errorIssues.snoozeUntil),
						lt(errorIssues.snoozeUntil, new Date(nowMs)),
					),
				)
			return {
				actorRow: actorRows[0] ?? null,
				policyRow: policyRows[0] ?? null,
				expiredLeases,
				wakeCandidates,
			}
		})
	})

	const expireLeasesForOrg = Effect.fn("ErrorsService.expireLeases")(function* (
		orgId: OrgId,
		nowMs: number,
		expired: ReadonlyArray<ErrorIssueRow>,
		systemActor: ActorDocument,
	) {
		if (expired.length === 0) return 0

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

	const claimTickWindow = Effect.fn("ErrorsService.claimTickWindow")(function* (
		orgId: OrgId,
		cutoffMs: number,
		nowMs: number,
	) {
		const claimToken = randomUUID()
		const initialProcessedThrough = new Date(cutoffMs - TICK_BOOTSTRAP_WINDOW_MS)
		const claim = yield* dbExecute(async (db) => {
			await db
				.insert(errorTickStates)
				.values({
					orgId,
					processedThrough: initialProcessedThrough,
					bootstrapCompleted: false,
					claimToken: null,
					claimExpiresAt: null,
					updatedAt: new Date(nowMs),
				})
				.onConflictDoNothing({ target: errorTickStates.orgId })

			// `for update skip locked` is what makes the TTL a crash-recovery
			// mechanism rather than a deadline. `persistErrorTickWindow` holds this
			// row locked for the life of its transaction, so a legitimately slow
			// apply is skipped here instead of being stolen and rolled back at its
			// checkpoint — the retry-forever loop that stalls an org permanently.
			// Only a dead worker leaves the row unlocked with a lapsed lease.
			const claimable = db
				.select({ orgId: errorTickStates.orgId })
				.from(errorTickStates)
				.where(
					and(
						eq(errorTickStates.orgId, orgId),
						lt(errorTickStates.processedThrough, new Date(cutoffMs)),
						or(
							isNull(errorTickStates.claimExpiresAt),
							lte(errorTickStates.claimExpiresAt, new Date(nowMs)),
						),
					),
				)
				.for("update", { skipLocked: true })

			const claimed = await db
				.update(errorTickStates)
				.set({
					claimToken,
					claimExpiresAt: new Date(nowMs + TICK_CLAIM_TTL_MS),
					updatedAt: new Date(nowMs),
				})
				.where(inArray(errorTickStates.orgId, claimable))
				.returning({
					processedThrough: errorTickStates.processedThrough,
					bootstrapCompleted: errorTickStates.bootstrapCompleted,
				})
			return claimed
		})
		const row = claim[0]
		if (!row) return null
		const windowStartMs = row.processedThrough.getTime()
		return {
			claimToken,
			isBootstrap: !row.bootstrapCompleted,
			windowStartMs,
			windowEndMs: Math.min(windowStartMs + TICK_MAX_WINDOW_MS, cutoffMs),
		}
	})

	const releaseTickClaim = (orgId: OrgId, claimToken: string, nowMs: number) =>
		dbExecute((db) =>
			db
				.update(errorTickStates)
				.set({ claimToken: null, claimExpiresAt: null, updatedAt: new Date(nowMs) })
				.where(and(eq(errorTickStates.orgId, orgId), eq(errorTickStates.claimToken, claimToken))),
		).pipe(Effect.ignore)

	const processOrg = Effect.fn("ErrorsService.processOrg")(function* (
		orgId: OrgId,
		cutoffMs: number,
		nowMs: number,
		runRetention: boolean,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, runRetention })
		const tickWindow = yield* claimTickWindow(orgId, cutoffMs, nowMs)
		if (!tickWindow) {
			return {
				issuesTouched: 0,
				incidentsOpened: 0,
				incidentsResolved: 0,
				issuesReopened: 0,
				issuesArchived: 0,
				issuesDeleted: 0,
				leasesExpired: 0,
			}
		}
		const { windowStartMs } = tickWindow
		yield* Effect.annotateCurrentSpan({ windowStartMs, windowEndMs: tickWindow.windowEndMs })
		const tenant = systemTenant(orgId)
		const preamble = yield* loadOrgTickPreamble(orgId, nowMs).pipe(
			Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)),
		)
		// The actor exists after an org's first tick, so the insert path is a
		// once-per-org cost rather than a per-tick round-trip.
		const systemActor = preamble.actorRow
			? rowToActor(preamble.actorRow)
			: yield* ensureSystemActor(orgId).pipe(
					Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)),
				)
		const policy = preamble.policyRow ?? defaultPolicy(orgId, nowMs)

		const leasesExpired = yield* expireLeasesForOrg(
			orgId,
			nowMs,
			preamble.expiredLeases,
			systemActor,
		).pipe(Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)))

		const wakeCandidates = preamble.wakeCandidates
		yield* Effect.forEach(wakeCandidates, (row) =>
			applyTransition(orgId, systemActor.id, row, "triage", {
				payload: { viaSnoozeWakeup: true },
				timestamp: nowMs,
			}),
		).pipe(Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)))
		const issuesReopened = wakeCandidates.length

		const scanWindow = (endMs: number) => {
			const tickParams = {
				orgId,
				startTime: formatWarehouseDateTime(windowStartMs),
				endTime: formatWarehouseDateTime(endMs),
			}
			const issuesCompiled = tickWindow.isBootstrap
				? CH.compile(CH.errorTickBootstrapIssuesQuery(), tickParams)
				: CH.compile(CH.errorTickIssuesQuery(), tickParams)
			return warehouse
				.compiledQuery(tenant, issuesCompiled, {
					profile: "aggregation",
					context: "errorIssuesScan",
				})
				.pipe(
					Effect.mapError(makePersistenceError),
					Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)),
				)
		}

		// Shed rows before the transaction rather than after it fails. A catch-up
		// window, or one minute of a fingerprint-cardinality explosion, can carry
		// far more fingerprints than an apply should hold open at once; halving the
		// window and rescanning costs one extra warehouse query and leaves the
		// remainder for the next cron. Steady state is a single minute and never
		// enters the loop.
		let windowEndMs = tickWindow.windowEndMs
		let issuesRaw = yield* scanWindow(windowEndMs)
		let splits = 0
		while (issuesRaw.length > TICK_MAX_WINDOW_ROWS && splits < TICK_MAX_WINDOW_SPLITS) {
			const widthMinutes = Math.round((windowEndMs - windowStartMs) / TICK_MINUTE_MS)
			if (widthMinutes <= 1) break
			windowEndMs = windowStartMs + Math.ceil(widthMinutes / 2) * TICK_MINUTE_MS
			splits += 1
			issuesRaw = yield* scanWindow(windowEndMs)
		}
		if (issuesRaw.length > TICK_MAX_WINDOW_ROWS) {
			// An indivisible minute over the cap. Applying it is still the right
			// call — skipping would lose the window — but it is a fingerprinting
			// problem, not a load problem, and it should be visible as one.
			yield* Effect.logWarning("Error tick window exceeds row cap at minimum width").pipe(
				Effect.annotateLogs({
					orgId,
					windowStartMs,
					windowEndMs,
					fingerprints: issuesRaw.length,
					cap: TICK_MAX_WINDOW_ROWS,
				}),
			)
		}
		yield* Effect.annotateCurrentSpan({
			windowEndMs,
			windowSplits: splits,
			scanFingerprints: issuesRaw.length,
		})

		const rows = issuesRaw.map((raw) => ({
			fingerprintHash: String(raw.fingerprintHash ?? ""),
			serviceName: String(raw.serviceName ?? ""),
			exceptionType: String(raw.exceptionType ?? ""),
			exceptionMessage: String(raw.exceptionMessage ?? ""),
			errorLabel: String(raw.errorLabel ?? ""),
			topFrame: String(raw.topFrame ?? ""),
			count: Number(raw.count ?? 0),
			firstSeen: String(raw.firstSeen ?? ""),
			lastSeen: String(raw.lastSeen ?? ""),
		}))

		const persistence = yield* dbExecute((db) =>
			persistErrorTickWindow(db, {
				orgId,
				actorId: systemActor.id,
				rows: rows.map((row) => ({
					fingerprintHash: row.fingerprintHash,
					serviceName: row.serviceName,
					exceptionType: row.exceptionType,
					exceptionMessage: row.exceptionMessage,
					errorLabel: row.errorLabel,
					topFrame: row.topFrame,
					count: row.count,
					firstSeenMs: parseWarehouseDateTime(row.firstSeen),
					lastSeenMs: parseWarehouseDateTime(row.lastSeen),
				})),
				policy,
				destinationIds: parsePolicyDestinations(policy.destinationIdsJson),
				windowEndMs,
				autoResolveMinutes: AUTO_RESOLVE_MINUTES,
				claimToken: tickWindow.claimToken,
				makeIssueId: newErrorIssueId,
				makeIncidentId: newErrorIncidentId,
				makeEventId: newEventId,
			}),
		).pipe(
			Effect.tapError((error) =>
				// A lost claim now means the worker stalled past the crash-recovery
				// TTL — the cursor row lock rules out an ordinary steal. Surface it as
				// its own signal so a recurring stall is distinguishable from a
				// warehouse or database failure.
				isErrorTickClaimLost(error)
					? Effect.logError("Error tick lost its cursor claim before commit").pipe(
							Effect.annotateLogs({
								orgId,
								windowStartMs,
								windowEndMs,
								fingerprints: rows.length,
								claimTtlMs: TICK_CLAIM_TTL_MS,
							}),
						)
					: Effect.void,
			),
			Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)),
		)

		// The authoritative state and notification outbox are committed above.
		// Workflow fan-out remains best-effort and runs only after that commit.
		yield* Effect.forEach(persistence.pendingTriages, (pending) =>
			maybeEnqueueTriage({
				orgId,
				incidentKind: "error",
				incidentId: pending.incidentId,
				issueId: pending.issueId,
				context: {
					kind: "error",
					reason: pending.reason,
					severity: pending.severity,
					serviceName: pending.row.serviceName,
					exceptionType: pending.row.exceptionType,
					exceptionMessage: pending.row.exceptionMessage,
					errorLabel: pending.row.errorLabel,
					topFrame: pending.row.topFrame,
					fingerprintHash: pending.row.fingerprintHash,
					occurrenceCount: pending.row.count,
					firstSeen: formatWarehouseDateTime(pending.row.firstSeenMs),
					lastSeen: formatWarehouseDateTime(pending.row.lastSeenMs),
					issueId: pending.issueId,
				},
				fanoutBinding: investigationFanoutBinding,
			}).pipe(Effect.provideService(Database, database)),
		)

		const issuesTouched = persistence.issuesTouched
		const incidentsOpened = persistence.incidentsOpened
		const incidentsResolved = persistence.incidentsResolved

		let issuesArchived = 0
		let issuesDeleted = 0

		if (runRetention) {
			const resolvedCutoff = nowMs - RESOLVED_RETENTION_DAYS * DAY_MS
			const archivedRows = yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ archivedAt: new Date(nowMs), updatedAt: new Date(nowMs) })
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

			const archivedCutoff = nowMs - ARCHIVED_RETENTION_DAYS * DAY_MS
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
				yield* dbExecute((db) =>
					db
						.delete(errorIncidents)
						.where(and(eq(errorIncidents.orgId, orgId), inArray(errorIncidents.issueId, ids))),
				)
				yield* dbExecute((db) =>
					db
						.delete(errorIssueStates)
						.where(
							and(eq(errorIssueStates.orgId, orgId), inArray(errorIssueStates.issueId, ids)),
						),
				)
				yield* dbExecute((db) =>
					db
						.delete(errorIssueEvents)
						.where(
							and(eq(errorIssueEvents.orgId, orgId), inArray(errorIssueEvents.issueId, ids)),
						),
				)
				yield* dbExecute((db) =>
					db
						.delete(errorIssues)
						.where(and(eq(errorIssues.orgId, orgId), inArray(errorIssues.id, ids))),
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

	// Align to the latest completed minute. Per-org cursor leases serialize
	// overlapping cron invocations; the cursor advances atomically with issue,
	// incident, audit-event, and notification-outbox writes.
	const runTick: ErrorsServiceShape["runTick"] = Effect.fn("ErrorsService.runTick")(function* () {
		const nowMs = yield* Clock.currentTimeMillis
		const cutoffMs = Math.floor(nowMs / TICK_MINUTE_MS) * TICK_MINUTE_MS - TICK_INGESTION_LAG_MS

		const retentionRan =
			Math.floor(nowMs / RETENTION_PHASE_PERIOD_MS) % RETENTION_PHASE_EVERY_N_TICKS === 0

		// `error_issue_states` and `error_issues` hold hundreds of thousands of rows
		// across a couple dozen orgs, so a plain `SELECT DISTINCT` scanned 160k/270k
		// rows a call — together ~36% of all database CPU. Walk the btree instead.
		// `org_ingest_keys` stays a plain DISTINCT on purpose: it is ~1 row per org,
		// where a loose index scan costs an index descent per row and wins nothing.
		const stateOrgs = yield* dbExecute((db) =>
			selectDistinctOrgIds(db, errorIssueStates, errorIssueStates.orgId),
		)
		const issueOrgs = yield* dbExecute((db) => selectDistinctOrgIds(db, errorIssues, errorIssues.orgId))
		const ingestOrgs = yield* dbExecute((db) =>
			db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
		)
		const knownOrgs = new Set<string>([...stateOrgs, ...issueOrgs, ...ingestOrgs.map((r) => r.orgId)])

		const activeOrgs = yield* resolveActiveOrgs([...knownOrgs], nowMs)
		// Orgs that hold issue/incident state must be scanned even with no recent
		// errors: the scan returning empty is what drives auto-resolution and
		// aging. Only pure ingest-key-only orgs with neither recent errors nor
		// existing state are skipped.
		const withState = new Set<string>([...stateOrgs, ...issueOrgs])
		const isActive = (org: string) => activeOrgs.has(org) || withState.has(org)
		// Everything `processOrg` does for an inactive org is a no-op read: lease
		// expiry, snooze wake-up and stale-incident resolution can only match rows
		// in error_issues / error_issue_states / error_incidents, and an org holding
		// any of those is in `withState` by construction. Visiting the rest cost 5
		// Postgres round-trips each per minute — ~1.6M/day, most of the statement
		// volume on the database — to discover nothing.
		const scanOrgs = [...knownOrgs].filter(isActive)

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
			scanOrgs,
			(org) =>
				Effect.gen(function* () {
					// Orgs whose warehouse rejected queries with an auth/config-class error
					// are parked (see warehouse-org-quarantine.ts) — retrying every tick
					// fails identically until an operator repairs the org's config.
					if (yield* isOrgWarehouseQuarantined(edgeCache, org)) {
						yield* Effect.logInfo("Skipping org with quarantined warehouse").pipe(
							Effect.annotateLogs({ orgId: org }),
						)
						return emptyResult
					}
					return yield* processOrg(org as OrgId, cutoffMs, nowMs, retentionRan)
				}).pipe(
					// Isolate genuine per-org failures/defects so one bad org can't fail the
					// whole tick. Interrupts (isolate teardown) are NOT per-org failures —
					// re-raise them so the tick cancels promptly instead of logging a
					// phantom failure and marching through the remaining orgs.
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.gen(function* () {
									const quarantined = yield* quarantineOnConfigClassCause(
										edgeCache,
										org,
										cause,
										nowMs,
									)
									if (quarantined) {
										yield* Effect.logInfo(
											"Org warehouse rejected queries with a config-class error; quarantined",
										).pipe(
											Effect.annotateLogs({ orgId: org, error: Cause.pretty(cause) }),
										)
									} else {
										yield* Effect.logError("Error tick failed for org").pipe(
											Effect.annotateLogs({
												orgId: org,
												error: Cause.pretty(cause),
											}),
										)
									}
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

		// Drain after evaluator transactions commit. If delivery fails, the row is
		// rescheduled with backoff and a future tick retries it.
		yield* processNotificationOutbox()

		yield* Effect.annotateCurrentSpan({
			orgsKnown: knownOrgs.size,
			orgsScanned: scanOrgs.length,
			orgFailures: yield* Ref.get(orgFailures),
			...totals,
		})

		return {
			orgsProcessed: scanOrgs.length,
			...totals,
			retentionRan,
		}
	})

	return ErrorsService.of({
		listIssues,
		countOpenIssuesByService,
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
		evaluateEscalationPolicy: evaluatePolicy,
		listIssueEscalations,
		listRecentEscalations,
		runTick,
	})
})

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceShape>()(
	"@maple/api/services/ErrorsService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
