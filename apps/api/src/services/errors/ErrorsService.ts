import { randomUUID } from "node:crypto"
import {
	ActorDocument,
	type ActorId,
	ERROR_INCIDENT_AUTO_RESOLVE_MINUTES,
	ErrorIncidentDocument,
	ErrorIssueDocument,
	ErrorIssueEventId as ErrorIssueEventIdSchema,
	type ErrorIssueId,
	ErrorIssueLeaseConflictError,
	ErrorIssueNotFoundError,
	ErrorIssueTransitionError,
	ErrorPersistenceError,
	ErrorValidationError,
	type OrgId,
	RoleName,
	UserId as UserIdSchema,
	type WorkflowState,
	CLOSED_WORKFLOW_STATES,
	canReachInReview,
	ErrorIssuePullRequestInvalidError,
	fixProposalRoute,
	parsePullRequestUrl,
} from "@maple/domain/http"
import { FINGERPRINT_VERSION } from "@maple/domain/tinybird/fingerprint"
import {
	actors,
	errorIncidents,
	errorNotificationDeliveries,
	type ErrorNotificationDeliveryRow,
	errorFingerprintCandidates,
	errorIssues,
	errorIssueEvents,
	type ErrorIssueRow,
	errorIssueStates,
	errorNotificationPolicies,
	errorTickStates,
	orgClickHouseSettings,
	orgIngestKeys,
} from "@maple/db"
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { CH, parseWarehouseDateTime, formatWarehouseDateTime } from "@maple/query-engine"
import { Cause, Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { INVESTIGATION_FANOUT_BINDING, maybeEnqueueTriage } from "@/services/errors/ai-triage-enqueue"
import { isErrorTickClaimLost, persistErrorTickWindow } from "@/services/errors/error-tick-persistence"
import { toPgText } from "@/platform/pg-text"
import { SYSTEM_ERRORS_AGENT_NAME } from "@/services/auth/system-actors"
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
import { actorRowToDocument, ErrorActorsService, type ErrorActorsPublicApi } from "./ErrorActorsService"
import {
	ErrorIssueReadModelsService,
	type ErrorIssueReadModelsPublicApi,
} from "./ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService, type ErrorIssueWorkflowPublicApi } from "./ErrorIssueWorkflowService"
import { IssueFixVerificationService } from "./IssueFixVerificationService"
import { ErrorPolicyService, type ErrorPolicyPublicApi } from "./ErrorPolicyService"
import { makeErrorDatabaseExecute, makePersistenceError } from "./error-persistence"
import { summarizeCause } from "@/platform/describe-cause"

export { describeCause, makePersistenceError } from "./error-persistence"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeEventIdSync = Schema.decodeUnknownSync(ErrorIssueEventIdSchema)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

// Lenient decoders for JSON stored in jsonb columns. Decode failures fall back
// to an empty/null value at each call site — stored blobs are best-effort.
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
/**
 * How long a fingerprint may sit below the promotion threshold before it is
 * forgotten. Long enough that a genuinely intermittent error still accumulates
 * across a day, short enough that one-off noise does not pile up.
 */
const CANDIDATE_RETENTION_MS = 24 * 60 * 60 * 1000
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
export interface ErrorsServiceApi
	extends
		ErrorActorsPublicApi,
		ErrorIssueWorkflowPublicApi,
		ErrorIssueReadModelsPublicApi,
		ErrorPolicyPublicApi {
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
		// Lease conflict included: proposing a fix claims the issue, so it can now
		// collide with an agent already holding it — which is the point.
		| ErrorPersistenceError
		| ErrorIssueNotFoundError
		| ErrorIssueTransitionError
		| ErrorIssueLeaseConflictError
		| ErrorIssuePullRequestInvalidError
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
	ErrorsServiceApi,
	never,
	| Database
	| WarehouseQueryService
	| EdgeCacheService
	| Env
	| NotificationDispatcher
	| ErrorActorsService
	| ErrorIssueWorkflowService
	| ErrorIssueReadModelsService
	| ErrorPolicyService
> = Effect.gen(function* () {
	const database = yield* Database
	const actorService = yield* ErrorActorsService
	const workflow = yield* ErrorIssueWorkflowService
	const readModels = yield* ErrorIssueReadModelsService
	const policies = yield* ErrorPolicyService
	// Optional on purpose. `propose_fix` works exactly as before without it — the
	// `prUrl` still lands on the event payload — and gains a durable, watchable
	// link when it is present. Requiring it would have forced the dependency
	// through every partial stub of this service in the test suite to buy
	// nothing: no caller wants a fix proposal to FAIL because a link could not
	// be stored.
	const fixVerification = yield* Effect.serviceOption(IssueFixVerificationService)
	const loadPolicyRow = policies.loadNotificationPolicyRow
	const defaultPolicy = policies.defaultNotificationPolicy
	const parsePolicyDestinations = policies.parseNotificationDestinationIds
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

	const dbExecute = makeErrorDatabaseExecute(database, "ErrorsService")

	const isoFromDate = (date: Date) => decodeIsoDateTimeStringSync(date.toISOString())

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

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
		knownOrgs: ReadonlyArray<OrgId>,
		nowMs: number,
	) {
		yield* Effect.annotateCurrentSpan("knownOrgs", knownOrgs.length)
		const byoRows = yield* dbExecute((db) =>
			db.selectDistinct({ orgId: orgClickHouseSettings.orgId }).from(orgClickHouseSettings),
		).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: OrgId }>))
		const byo = new Set<OrgId>(byoRows.map((r) => r.orgId))

		if (knownOrgs.length === 0) {
			yield* Effect.annotateCurrentSpan({ activeOrgs: byo.size, failedClosed: false })
			return byo as ReadonlySet<OrgId>
		}

		const compiled = CH.compile(
			CH.activeOrgsByErrorEventsQuery(),
			{ startTime: formatWarehouseDateTime(nowMs - ERROR_ACTIVE_DISCOVERY_WINDOW_MS) },
			{ rowSchema: CH.ActiveOrgsOutputSchema },
		)
		return yield* warehouse
			.crossOrgQuery(systemTenant(knownOrgs[0]!), compiled, {
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
					const active = new Set<OrgId>(byo)
					for (const row of rows) {
						active.add(row.orgId)
					}
					return active as ReadonlySet<OrgId>
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
								).pipe(Effect.annotateLogs({ error: summarizeCause(cause) }))
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
	const { registerAgent, listAgents, lookupActor, ensureUserActor, ensureSystemActor, touchActor } =
		actorService
	const rowToActor = actorRowToDocument
	const {
		requireIssue,
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
	// Events / audit log

	const recordAnomalyLinkEvent: ErrorsServiceApi["recordAnomalyLinkEvent"] = Effect.fn(
		"ErrorsService.recordAnomalyLinkEvent",
	)(function* (orgId, issueId, actorId, payload) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId, action: payload.action })
		yield* recordEvent(orgId, issueId, actorId, "anomaly_linked", { payload: { ...payload } })
	})

	// State transitions

	const transitionIssue: ErrorsServiceApi["transitionIssue"] = Effect.fn("ErrorsService.transitionIssue")(
		function* (orgId, actorId, issueId, toState, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId, toState })
			const timestamp = yield* Clock.currentTimeMillis
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

			// Moving an issue to `in_progress` IS claiming it, so take the lease.
			// This is the path the agents in the internal org actually used — walk
			// `triage → in_progress` by hand, then `→ in_review` — and it left every
			// issue unclaimed, which is why the lease had never once been held.
			// Best-effort: somebody else holding the lease is not a reason to refuse a
			// state change a human or agent is entitled to make, and `applyTransition`
			// already renews the lease of a holder who is still working.
			if (toState === "in_progress" && actorId !== null) {
				yield* acquireLease(orgId, actorId, issueId, DEFAULT_LEASE_DURATION_MS, timestamp).pipe(
					Effect.flatMap(({ leaseExpiresAt }) =>
						current.leaseHolderActorId === actorId
							? Effect.void
							: recordEvent(orgId, issueId, actorId, "claim", {
									payload: {
										leaseExpiresAt,
										leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
										viaTransition: true,
									},
									timestamp,
								}),
					),
					Effect.catchTag("@maple/http/errors/ErrorIssueLeaseConflictError", (conflict) =>
						Effect.logInfo("[Errors] in_progress transition left the lease with its holder").pipe(
							Effect.annotateLogs({ issueId, holder: conflict.currentHolderActorId }),
						),
					),
				)
			}

			const updated = yield* applyTransition(orgId, actorId, current, toState, {
				note: opts?.note,
				snoozeUntilMs,
				timestamp,
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

	/**
	 * Take (or renew) the lease on an issue and return the freshly-read row.
	 *
	 * Shared by `claimIssue` and `proposeFix`. Proposing a fix is picking the
	 * issue up — an agent that only ever calls `propose_fix` should still end up
	 * holding the lease, or the "two agents don't fix the same bug" guarantee is
	 * one an agent has to opt into, and none of them do: across 50 live issues in
	 * the internal org, not one had ever been claimed.
	 */
	const acquireLease = Effect.fn("ErrorsService.acquireLease")(function* (
		orgId: OrgId,
		actorId: ActorId,
		issueId: ErrorIssueId,
		leaseMs: number,
		timestamp: number,
	) {
		const leaseExpiresAt = timestamp + leaseMs
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

		return { row: claimed[0]!, leaseExpiresAt }
	})

	const claimIssue: ErrorsServiceApi["claimIssue"] = Effect.fn("ErrorsService.claimIssue")(
		function* (orgId, actorId, issueId, leaseDurationMs) {
			const timestamp = yield* Clock.currentTimeMillis
			const leaseMs = leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
			yield* Effect.annotateCurrentSpan({ orgId, issueId, actorId, leaseMs })

			const current = yield* requireIssue(orgId, issueId)
			if (CLOSED_WORKFLOW_STATES.has(current.workflowState)) {
				return yield* Effect.fail(
					new ErrorIssueTransitionError({
						message: `Cannot claim an issue in state '${current.workflowState}'`,
						issueId,
						fromState: current.workflowState,
						toState: "in_progress",
					}),
				)
			}

			const { row, leaseExpiresAt } = yield* acquireLease(orgId, actorId, issueId, leaseMs, timestamp)

			// Move to in_progress if the issue is still waiting to be picked up.
			// `regressed` belongs here with triage/todo: claiming a bug that came back
			// is starting work on it, and leaving it in `regressed` would strand it
			// outside the in-progress views.
			let next = row
			if (
				row.workflowState === "triage" ||
				row.workflowState === "regressed" ||
				row.workflowState === "todo"
			) {
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

	/**
	 * Record a proposed fix and put the issue under review.
	 *
	 * Three things happen in an order that matters, and the order is the fix to a
	 * real production bug. This used to write the `fix_proposed` event and link
	 * the PR *first*, then transition — so a proposal against a `triage` issue
	 * (the state most issues are in, and the state agents most often find them in)
	 * recorded both writes and only then failed with "Illegal transition from
	 * 'triage' to 'in_review'". The agent saw an error for something half-done.
	 *
	 * Now: everything that can be refused is refused before anything is written,
	 * the issue is claimed, and the walk to `in_review` follows a route the state
	 * machine actually permits.
	 */
	const proposeFix: ErrorsServiceApi["proposeFix"] = Effect.fn("ErrorsService.proposeFix")(
		function* (orgId, actorId, issueId, request) {
			const timestamp = yield* Clock.currentTimeMillis
			const current = yield* requireIssue(orgId, issueId)
			yield* Effect.annotateCurrentSpan({ orgId, issueId, fromState: current.workflowState })

			// Refuse up front, with a reason, rather than mid-write. `cancelled` and
			// `wontfix` cannot reach review; a closed issue has to be reopened
			// deliberately, which is a decision rather than a side effect of
			// attaching a patch.
			if (CLOSED_WORKFLOW_STATES.has(current.workflowState)) {
				return yield* Effect.fail(
					new ErrorIssueTransitionError({
						message: `Issue is '${current.workflowState}' and takes no more fixes. Reopen it first with transition_error_issue if this fix is still needed.`,
						issueId,
						fromState: current.workflowState,
						toState: "in_review",
					}),
				)
			}
			if (!canReachInReview(current.workflowState)) {
				return yield* Effect.fail(
					new ErrorIssueTransitionError({
						message: `An issue in '${current.workflowState}' cannot go under review. Move it to 'triage' first with transition_error_issue.`,
						issueId,
						fromState: current.workflowState,
						toState: "in_review",
					}),
				)
			}

			// A `pr_url` that is not a pull request URL is refused here, before any
			// write. It used to be accepted, swallowed by the best-effort link below,
			// and then reported back as `- PR: <url>` — so an agent that fat-fingered
			// a URL was told the fix was attached and would be verified after merge,
			// when nothing had been linked and no verification would ever run.
			if (request.prUrl !== undefined && parsePullRequestUrl(request.prUrl) === null) {
				return yield* Effect.fail(
					new ErrorIssuePullRequestInvalidError({
						message:
							"Not a recognizable GitHub pull request URL. Omit pr_url to record the fix without one.",
						rawUrl: request.prUrl,
					}),
				)
			}

			// Proposing a fix IS picking the issue up, so it takes the lease. If
			// somebody else holds one this fails here, before any write — which is
			// the duplicate-work collision the lease exists to catch, finally caught
			// on the path agents actually take.
			const { row, leaseExpiresAt } = yield* acquireLease(
				orgId,
				actorId,
				issueId,
				DEFAULT_LEASE_DURATION_MS,
				timestamp,
			)
			if (row.leaseHolderActorId !== current.leaseHolderActorId) {
				yield* recordEvent(orgId, issueId, actorId, "claim", {
					payload: {
						leaseExpiresAt,
						leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
						viaProposeFix: true,
					},
					timestamp,
				})
			}

			const payload: Record<string, unknown> = {
				patchSummary: request.patchSummary,
				...(request.prUrl ? { prUrl: request.prUrl } : undefined),
				...(request.artifacts ? { artifacts: request.artifacts } : undefined),
			} satisfies Record<string, unknown>
			yield* recordEvent(orgId, issueId, actorId, "fix_proposed", {
				payload,
				timestamp,
			})

			// Promote the free-text `prUrl` into a real link, so the merge webhook has
			// something to match on. A URL that is not a pull request, or a link that
			// cannot be stored, is not worth failing a fix proposal over — the
			// proposal itself already succeeded above.
			if (request.prUrl !== undefined && Option.isSome(fixVerification)) {
				yield* fixVerification.value
					.linkPullRequest(orgId, actorId, issueId, request.prUrl, "agent")
					.pipe(
						Effect.catch((error) =>
							Effect.logInfo("[FixVerification] propose_fix URL did not become a link").pipe(
								Effect.annotateLogs({ issueId, reason: error.message }),
							),
						),
					)
			}

			// Usually `triage → in_progress → in_review`; one hop from a state the
			// matrix lets straight through. Validated above, so no hop can fail here.
			let next = row
			for (const hop of fixProposalRoute(row.workflowState)) {
				next = yield* applyTransition(orgId, actorId, next, hop, {
					payload: { viaProposeFix: true },
					timestamp,
				})
			}
			yield* touchActor(orgId, actorId, timestamp)
			yield* maybeNotifyTransition(orgId, actorId, next, current.workflowState)
			return yield* hydrateIssue(orgId, next)
		},
	)
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

		const scanWindow = (endMs: number) =>
			Effect.gen(function* () {
				const tickParams = {
					orgId,
					startTime: formatWarehouseDateTime(windowStartMs),
					endTime: formatWarehouseDateTime(endMs),
				}
				const issuesCompiled = tickWindow.isBootstrap
					? CH.compile(CH.errorTickBootstrapIssuesQuery(), tickParams)
					: CH.compile(CH.errorTickIssuesQuery(), tickParams)
				return yield* warehouse
					.compiledQuery(tenant, issuesCompiled, {
						profile: "aggregation",
						context: "errorIssuesScan",
					})
					.pipe(
						Effect.mapError(makePersistenceError),
						Effect.tapError(() => releaseTickClaim(orgId, tickWindow.claimToken, nowMs)),
					)
			})

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

		// Every display string crosses from ClickHouse bytes into Postgres text
		// here — the one place to strip what Postgres refuses (`PgText` in `pg-text.ts`).
		const rows = issuesRaw.map((raw) => ({
			fingerprintHash: String(raw.fingerprintHash ?? ""),
			serviceName: toPgText(String(raw.serviceName ?? "")),
			exceptionType: toPgText(String(raw.exceptionType ?? "")),
			exceptionMessage: toPgText(String(raw.exceptionMessage ?? "")),
			errorLabel: toPgText(String(raw.errorLabel ?? "")),
			topFrame: toPgText(String(raw.topFrame ?? "")),
			// The warehouse returns every distinct build seen for the fingerprint in
			// the window; an older cluster that predates the column returns nothing.
			serviceVersions: Array.isArray(raw.serviceVersions)
				? raw.serviceVersions.map((version) => String(version)).filter((version) => version !== "")
				: [],
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
					serviceVersions: row.serviceVersions,
					count: row.count,
					firstSeenMs: parseWarehouseDateTime(row.firstSeen),
					lastSeenMs: parseWarehouseDateTime(row.lastSeen),
				})),
				policy,
				destinationIds: parsePolicyDestinations(policy.destinationIdsJson),
				windowEndMs,
				autoResolveMinutes: ERROR_INCIDENT_AUTO_RESOLVE_MINUTES,
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

		// Post-merge refutation. An issue sitting in `verifying` has a merged fix and
		// a running quiet window; an occurrence in this window from a build that was
		// NOT already running when the fix merged says the fix did not work. That is
		// a decisive answer, available right here from data the tick already read, so
		// it short-circuits the wait and the agent pass entirely.
		//
		// Same membership predicate as `isRegression`, and deliberately scoped by a
		// query rather than folded into `persistErrorTickWindow`: it must observe the
		// committed window, and it touches only the handful of issues in `verifying`.
		if (Option.isSome(fixVerification) && rows.length > 0) {
			const verifyingIssues = yield* dbExecute((db) =>
				db
					.select({
						id: errorIssues.id,
						fingerprintHash: errorIssues.fingerprintHash,
					})
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.workflowState, "verifying"))),
			)
			if (verifyingIssues.length > 0) {
				const versionsByFingerprint = new Map(
					rows.map((row) => [row.fingerprintHash, row.serviceVersions]),
				)
				yield* Effect.forEach(
					verifyingIssues,
					(issue) => {
						const observed = versionsByFingerprint.get(issue.fingerprintHash)
						if (observed === undefined) return Effect.void
						return fixVerification.value
							.refuteOnPostMergeOccurrence(orgId, issue.id, observed, nowMs)
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning(
										"[FixVerification] post-merge refutation check failed",
									).pipe(
										Effect.annotateLogs({
											orgId,
											issueId: issue.id,
											error: error.message,
										}),
									),
								),
							)
					},
					{ discard: true },
				)
			}
		}

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
			// Issues left behind by a fingerprint-algorithm bump. Their hashes can
			// never be produced again (v1 and v2 hashes cannot collide), so there is
			// nothing to wait for: archive them on sight instead of holding a dead
			// issue in `triage` until the resolved window retires it. Scoped to
			// error-kind — alert and integration issues key off their own
			// identifiers, not the ClickHouse fingerprint.
			const staleFingerprintRows = yield* dbExecute((db) =>
				db
					.update(errorIssues)
					.set({ archivedAt: new Date(nowMs), updatedAt: new Date(nowMs) })
					.where(
						and(
							eq(errorIssues.orgId, orgId),
							eq(errorIssues.kind, "error"),
							lt(errorIssues.fingerprintVersion, FINGERPRINT_VERSION),
							isNull(errorIssues.archivedAt),
						),
					)
					.returning({ id: errorIssues.id }),
			)

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
			issuesArchived = archivedRows.length + staleFingerprintRows.length

			// Candidates that never reached the promotion threshold. Without this the
			// holding table would accumulate every one-off fingerprint forever.
			yield* dbExecute((db) =>
				db
					.delete(errorFingerprintCandidates)
					.where(
						and(
							eq(errorFingerprintCandidates.orgId, orgId),
							lt(
								errorFingerprintCandidates.lastSeenAt,
								new Date(nowMs - CANDIDATE_RETENTION_MS),
							),
						),
					),
			)

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
	const runTick: ErrorsServiceApi["runTick"] = Effect.fn("ErrorsService.runTick")(function* () {
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
		const knownOrgs = new Set<OrgId>([...stateOrgs, ...issueOrgs, ...ingestOrgs.map((r) => r.orgId)])

		const activeOrgs = yield* resolveActiveOrgs([...knownOrgs], nowMs)
		// Orgs that hold issue/incident state must be scanned even with no recent
		// errors: the scan returning empty is what drives auto-resolution and
		// aging. Only pure ingest-key-only orgs with neither recent errors nor
		// existing state are skipped.
		const withState = new Set<OrgId>([...stateOrgs, ...issueOrgs])
		const isActive = (org: OrgId) => activeOrgs.has(org) || withState.has(org)
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
					return yield* processOrg(org, cutoffMs, nowMs, retentionRan)
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
											Effect.annotateLogs({ orgId: org, error: summarizeCause(cause) }),
										)
									} else {
										yield* Effect.logError("Error tick failed for org").pipe(
											Effect.annotateLogs({
												orgId: org,
												error: summarizeCause(cause),
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
		listIssues: readModels.listIssues,
		countOpenIssuesByService: readModels.countOpenIssuesByService,
		getIssue: readModels.getIssue,
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
		listIssueIncidents: readModels.listIssueIncidents,
		listOpenIncidents: readModels.listOpenIncidents,
		getNotificationPolicy: policies.getNotificationPolicy,
		upsertNotificationPolicy: policies.upsertNotificationPolicy,
		getEscalationPolicy: policies.getEscalationPolicy,
		upsertEscalationPolicy: policies.upsertEscalationPolicy,
		evaluateEscalationPolicy: policies.evaluateEscalationPolicy,
		listIssueEscalations: policies.listIssueEscalations,
		listRecentEscalations: policies.listRecentEscalations,
		runTick,
	})
})

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceApi>()(
	"@maple/api/services/ErrorsService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
