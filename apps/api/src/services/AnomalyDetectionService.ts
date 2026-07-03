import { randomUUID } from "node:crypto"
import {
	AnomalyDetectorSettingsDocument,
	type AnomalyDetectorSettingsUpdateRequest,
	AnomalyIncidentDocument,
	AnomalyIncidentFingerprint,
	AnomalyIncidentNotFoundError,
	AnomalyIncidentsListResponse,
	AnomalyIncidentTimeseriesResponse,
	AnomalyLinkedIssueNotFoundError,
	AnomalyTimeseriesBucket,
	type AnomalyIncidentId,
	type AnomalyIncidentStatus,
	AnomalyPersistenceError,
	AnomalySignalType,
	type AnomalyTimeseriesUnit,
	type ErrorIssueId,
	ErrorIssueId as ErrorIssueIdSchema,
	type OrgId,
	OrgId as OrgIdSchema,
	RoleName,
	type UserId,
	UserId as UserIdSchema,
} from "@maple/domain/http"
import {
	anomalyDetectorSettings,
	type AnomalyDetectorSettingsRow,
	anomalyDetectorStates,
	type AnomalyDetectorStateRow,
	anomalyIncidents,
	type AnomalyIncidentRow,
	errorIssues,
	orgClickHouseSettings,
	orgIngestKeys,
} from "@maple/db"
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import { CH, parseWarehouseDateTime } from "@maple/query-engine"
import { EdgeCacheService } from "@maple/query-engine/caching"
import { Array as Arr, Cause, Clock, Context, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { AI_TRIAGE_WORKFLOW_BINDING, maybeEnqueueTriage } from "../lib/ai-triage-enqueue"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Database, DatabaseError, type DatabaseClient } from "../lib/DatabaseLive"
import { dateToMs, msToDate } from "../lib/time"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import {
	evaluateErrorSpike,
	evaluateGoldenSignals,
	evaluateLogVolume,
	SENSITIVITY,
	type AnomalyEvaluation,
	type ErrorSpikeBaseline,
	type GoldenSignalSeries,
	type LogVolumeSeries,
} from "./anomaly/detection"
import { decideTransition, stateMachineConfigFor, type DetectorStateSnapshot } from "./anomaly/state-machine"
import {
	attachKeyFor,
	canAttach,
	headlineSeverity,
	markFingerprintResolved,
	parseFingerprints,
	REOPEN_WINDOW_MS,
	shouldReopen,
	upsertFingerprintEntry,
	type IncidentFingerprintEntry,
} from "./anomaly/consolidation"

const decodeIncidentIdSync = Schema.decodeUnknownSync(AnomalyIncidentDocument.fields.id)
const decodeMutedSignalResult = Schema.decodeUnknownResult(AnomalySignalType)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgIdSchema)
const decodeIsoSync = Schema.decodeUnknownSync(AnomalyIncidentDocument.fields.firstTriggeredAt)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeIssueIdSync = Schema.decodeUnknownSync(ErrorIssueIdSchema)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const HOUR_MS = 60 * 60 * 1000
const BASELINE_WINDOW_MS = 7 * 24 * HOUR_MS
const SPIKE_WINDOW_MS = 30 * 60 * 1000
/** Org-level claim lock TTL — slightly under the 5-minute tick cadence. */
const ORG_LOCK_TTL_MS = 4 * 60 * 1000
const NO_DATA_RESOLVE_MS = 60 * 60 * 1000
const MAX_OPENS_PER_TICK = 10
/** Cap evaluated golden-signal/log series to the busiest N per org. */
const MAX_SERIES_PER_ORG = 200
const STATE_RETENTION_MS = 14 * 24 * HOUR_MS
const RETENTION_PHASE_EVERY_N_TICKS = 36
const TICK_CADENCE_MS = 5 * 60 * 1000
const ERROR_SPIKE_BASELINE_CACHE_BUCKET = "anomaly-errbase"
/** KV buckets for the cached 7-day matched-hours baselines (golden + logs). */
const GOLDEN_BASELINE_CACHE_BUCKET = "anomaly-goldenbase"
const LOG_BASELINE_CACHE_BUCKET = "anomaly-logbase"
/** Active-org discovery window — covers the in-progress hour plus the prior one
 *  so an org that just started sending telemetry is picked up within a tick. */
const ANOMALY_ACTIVE_DISCOVERY_WINDOW_MS = 2 * HOUR_MS
/** Last-known active-org set. Lets discovery fail CLOSED (reuse the previous set)
 *  instead of evaluating every known org — the old fallback that turned a
 *  warehouse blip into a fan-out storm. See ErrorsService for the same pattern. */
const ANOMALY_ACTIVE_ORGS_CACHE_BUCKET = "anomaly-active-orgs"
const ANOMALY_ACTIVE_ORGS_CACHE_KEY = "active"
const ANOMALY_ACTIVE_ORGS_CACHE_TTL_S = 6 * 60 * 60
/** D1 caps bound parameters per statement (~100); mirror ErrorsService's chunking. */
const D1_INARRAY_CHUNK_SIZE = 90

const describeCause = (cause: unknown): string | undefined => {
	if (cause == null) return undefined
	if (cause instanceof Error) return cause.stack ?? cause.message
	if (typeof cause === "string") return cause
	try {
		return JSON.stringify(cause)
	} catch {
		return String(cause)
	}
}

const makePersistenceError = (error: unknown): AnomalyPersistenceError => {
	const message =
		error instanceof DatabaseError || error instanceof Error
			? error.message
			: "Anomaly persistence failure"
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return cause === undefined
		? new AnomalyPersistenceError({ message })
		: new AnomalyPersistenceError({ message, cause })
}

const BUSY_ERROR_PATTERN = /SQLITE_BUSY|database is locked|D1_BUSY|busy/i

const isBusyDatabaseError = (error: DatabaseError): boolean => {
	if (BUSY_ERROR_PATTERN.test(error.message)) return true
	const inner = error.cause instanceof Error ? error.cause.message : undefined
	return inner !== undefined && BUSY_ERROR_PATTERN.test(inner)
}

const BUSY_RETRY_SCHEDULE = Schedule.exponential("50 millis", 2.0).pipe(Schedule.both(Schedule.recurs(3)))

/**
 * Adapt a drizzle incident row (timestamptz → Date, jsonb → unknown[]) to the
 * ms-number/JSON-string shape the pure consolidation helpers operate on.
 */
const parseRowFingerprints = (row: AnomalyIncidentRow): IncidentFingerprintEntry[] =>
	parseFingerprints({
		detectorKey: row.detectorKey,
		fingerprintHash: row.fingerprintHash,
		errorIssueId: row.errorIssueId,
		severity: row.severity,
		openedValue: row.openedValue,
		lastObservedValue: row.lastObservedValue,
		firstTriggeredAt: row.firstTriggeredAt.getTime(),
		fingerprintsJson: JSON.stringify(row.fingerprintsJson),
	})

interface ErrorSpikeBaselineEntry extends ErrorSpikeBaseline {
	readonly fingerprintHash: string
	readonly deploymentEnv: string
}

interface AnomalyTickResult {
	readonly orgsProcessed: number
	readonly seriesEvaluated: number
	readonly incidentsOpened: number
	readonly incidentsAttached: number
	readonly incidentsReopened: number
	readonly incidentsContinued: number
	readonly incidentsResolved: number
	readonly orgFailures: number
}

export interface AnomalyDetectionServiceShape {
	readonly runTick: () => Effect.Effect<AnomalyTickResult, AnomalyPersistenceError>
	readonly listIncidents: (
		orgId: OrgId,
		opts: {
			readonly status?: AnomalyIncidentStatus
			readonly signalType?: AnomalySignalType
			readonly service?: string
			readonly deploymentEnv?: string
			readonly errorIssueId?: ErrorIssueId
			readonly startTime?: string
			readonly endTime?: string
			readonly limit?: number
		},
	) => Effect.Effect<AnomalyIncidentsListResponse, AnomalyPersistenceError>
	readonly getIncident: (
		orgId: OrgId,
		incidentId: AnomalyIncidentId,
	) => Effect.Effect<AnomalyIncidentDocument, AnomalyPersistenceError | AnomalyIncidentNotFoundError>
	readonly resolveIncidentManually: (
		orgId: OrgId,
		incidentId: AnomalyIncidentId,
	) => Effect.Effect<AnomalyIncidentDocument, AnomalyPersistenceError | AnomalyIncidentNotFoundError>
	readonly setIncidentIssue: (
		orgId: OrgId,
		incidentId: AnomalyIncidentId,
		issueId: ErrorIssueId | null,
	) => Effect.Effect<
		{ readonly incident: AnomalyIncidentDocument; readonly previousIssueId: ErrorIssueId | null },
		AnomalyPersistenceError | AnomalyIncidentNotFoundError | AnomalyLinkedIssueNotFoundError
	>
	readonly getIncidentTimeseries: (
		tenant: TenantContext,
		incidentId: AnomalyIncidentId,
		opts: { readonly startTime?: string; readonly endTime?: string },
	) => Effect.Effect<
		AnomalyIncidentTimeseriesResponse,
		AnomalyPersistenceError | AnomalyIncidentNotFoundError
	>
	readonly getSettings: (
		orgId: OrgId,
	) => Effect.Effect<AnomalyDetectorSettingsDocument, AnomalyPersistenceError>
	readonly updateSettings: (
		orgId: OrgId,
		userId: UserId,
		request: AnomalyDetectorSettingsUpdateRequest,
	) => Effect.Effect<AnomalyDetectorSettingsDocument, AnomalyPersistenceError>
}

const make = Effect.gen(function* () {
	const database = yield* Database
	const warehouse = yield* WarehouseQueryService
	const edgeCache = yield* EdgeCacheService
	// Optional: present only inside a Worker isolate. Used to kick off the
	// AI triage Workflow when an incident opens (org opt-in).
	const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
	const aiTriageWorkflowBinding = Option.match(workerEnv, {
		onNone: () => undefined,
		onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
	})

	const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
		database.execute(fn).pipe(
			Effect.retry({
				schedule: BUSY_RETRY_SCHEDULE,
				while: isBusyDatabaseError,
			}),
			Effect.tapError((error) =>
				Effect.logError("AnomalyDetectionService dbExecute failed").pipe(
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

	const isoFromEpoch = (ms: number) => decodeIsoSync(new Date(ms).toISOString())

	const isoFromDate = (date: Date) => decodeIsoSync(date.toISOString())

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-anomaly"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

	// -----------------------------------------------------------------
	// Active-org gating
	//
	// The tick historically evaluated every org with an ingest key, scanning a
	// 7-day window for each — overwhelmingly idle orgs, which dominated Tinybird
	// CPU. Instead, run ONE cross-org scan of the recent hourly MVs (pinned to
	// managed Tinybird) and only evaluate orgs that produced telemetry. Idle orgs
	// have no series to evaluate. BYO-ClickHouse orgs are invisible to that scan
	// and are always evaluated. Fails CLOSED: if discovery errors, reuse the
	// last-known active set from cache (or just BYO if cold) rather than
	// evaluating every known org — the old fan-out amplified warehouse stress.
	// -----------------------------------------------------------------

	const resolveActiveOrgs = Effect.fn("AnomalyDetectionService.resolveActiveOrgs")(function* (
		knownOrgs: ReadonlyArray<OrgId>,
		nowMs: number,
	) {
		const byoRows = yield* dbExecute((db) =>
			db.selectDistinct({ orgId: orgClickHouseSettings.orgId }).from(orgClickHouseSettings),
		).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: string }>))
		const byo = new Set<string>(byoRows.map((r) => r.orgId))

		if (knownOrgs.length === 0) return byo as ReadonlySet<string>

		const startTime = toTinybirdDateTime(nowMs - ANOMALY_ACTIVE_DISCOVERY_WINDOW_MS)
		const routingTenant = systemTenant(knownOrgs[0])
		return yield* Effect.all(
			[
				warehouse.compiledQuery(
					routingTenant,
					CH.compile(CH.activeOrgsByTracesQuery(), { startTime }),
					{ pinToIngestConfig: true, profile: "discovery", context: "anomalyActiveOrgsTraces" },
				),
				warehouse.compiledQuery(
					routingTenant,
					CH.compile(CH.activeOrgsByLogsQuery(), { startTime }),
					{ pinToIngestConfig: true, profile: "discovery", context: "anomalyActiveOrgsLogs" },
				),
			],
			{ concurrency: 2 },
		).pipe(
			Effect.map(([tracesRows, logsRows]) => {
				const active = new Set<string>(byo)
				for (const row of [...tracesRows, ...logsRows]) {
					const orgId = String((row as { orgId?: unknown }).orgId ?? "")
					if (orgId) active.add(orgId)
				}
				return active as ReadonlySet<string>
			}),
			// Cache the freshly-discovered set for reuse on a later discovery failure.
			Effect.tap((active) =>
				edgeCache
					.rawPut(
						ANOMALY_ACTIVE_ORGS_CACHE_BUCKET,
						ANOMALY_ACTIVE_ORGS_CACHE_KEY,
						[...active],
						ANOMALY_ACTIVE_ORGS_CACHE_TTL_S,
					)
					.pipe(Effect.ignore),
			),
			// Fail CLOSED: reuse the last-known active set (or just BYO if cold).
			Effect.catchCause((cause) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						"Anomaly active-org discovery failed; reusing last-known active set",
					).pipe(Effect.annotateLogs({ error: Cause.pretty(cause) }))
					const cached = yield* edgeCache
						.rawGet<ReadonlyArray<string>>(ANOMALY_ACTIVE_ORGS_CACHE_BUCKET, ANOMALY_ACTIVE_ORGS_CACHE_KEY)
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

	// -----------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------

	const parseMutedSignals = (raw: ReadonlyArray<string>): ReadonlyArray<AnomalySignalType> =>
		Arr.filterMap(raw, (value) => decodeMutedSignalResult(value))

	const settingsToDocument = (row: AnomalyDetectorSettingsRow): AnomalyDetectorSettingsDocument =>
		new AnomalyDetectorSettingsDocument({
			enabled: row.enabled,
			sensitivity: row.sensitivity,
			mutedSignals: parseMutedSignals(row.mutedSignalsJson),
			updatedAt: isoFromDate(row.updatedAt),
			updatedBy: row.updatedBy ?? null,
		})

	const loadSettingsRow = Effect.fn("AnomalyDetectionService.loadSettingsRow")(function* (orgId: OrgId) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(anomalyDetectorSettings)
				.where(eq(anomalyDetectorSettings.orgId, orgId))
				.limit(1),
		)
		return rows[0]
	})

	const ensureSettingsRow = Effect.fn("AnomalyDetectionService.ensureSettingsRow")(function* (
		orgId: OrgId,
		nowMs: number,
	) {
		const existing = yield* loadSettingsRow(orgId)
		if (existing) return existing
		yield* dbExecute((db) =>
			db
				.insert(anomalyDetectorSettings)
				.values({
					orgId,
					enabled: true,
					sensitivity: "normal",
					mutedSignalsJson: [],
					createdAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				.onConflictDoNothing(),
		)
		const refreshed = yield* loadSettingsRow(orgId)
		if (!refreshed) {
			return yield* Effect.fail(
				new AnomalyPersistenceError({ message: "Failed to create anomaly settings row" }),
			)
		}
		return refreshed
	})

	const getSettings: AnomalyDetectionServiceShape["getSettings"] = Effect.fn(
		"AnomalyDetectionService.getSettings",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const nowMs = yield* Clock.currentTimeMillis
		const row = yield* ensureSettingsRow(orgId, nowMs)
		return settingsToDocument(row)
	})

	const updateSettings: AnomalyDetectionServiceShape["updateSettings"] = Effect.fn(
		"AnomalyDetectionService.updateSettings",
	)(function* (orgId, userId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const nowMs = yield* Clock.currentTimeMillis
		const existing = yield* ensureSettingsRow(orgId, nowMs)
		const next = {
			enabled: request.enabled === undefined ? existing.enabled : request.enabled,
			sensitivity: request.sensitivity ?? existing.sensitivity,
			mutedSignalsJson:
				request.mutedSignals === undefined ? existing.mutedSignalsJson : request.mutedSignals,
			updatedAt: new Date(nowMs),
			updatedBy: userId,
		}
		yield* dbExecute((db) =>
			db.update(anomalyDetectorSettings).set(next).where(eq(anomalyDetectorSettings.orgId, orgId)),
		)
		const refreshed = yield* loadSettingsRow(orgId)
		return settingsToDocument(refreshed ?? { ...existing, ...next })
	})

	// -----------------------------------------------------------------
	// Incident reads
	// -----------------------------------------------------------------

	const incidentToDocument = (row: AnomalyIncidentRow): AnomalyIncidentDocument =>
		new AnomalyIncidentDocument({
			id: decodeIncidentIdSync(row.id),
			detectorKey: row.detectorKey,
			signalType: row.signalType,
			serviceName: row.serviceName,
			deploymentEnv: row.deploymentEnv,
			fingerprintHash: row.fingerprintHash ?? null,
			errorIssueId: row.errorIssueId ?? null,
			status: row.status,
			severity: row.severity,
			openedValue: row.openedValue,
			baselineMedian: row.baselineMedian,
			baselineSigma: row.baselineSigma,
			thresholdValue: row.thresholdValue,
			lastObservedValue: row.lastObservedValue,
			lastSampleCount: row.lastSampleCount,
			firstTriggeredAt: isoFromDate(row.firstTriggeredAt),
			lastTriggeredAt: isoFromDate(row.lastTriggeredAt),
			resolvedAt: row.resolvedAt ? isoFromDate(row.resolvedAt) : null,
			resolveReason: row.resolveReason ?? null,
			triageStatus: row.triageStatus,
			fingerprints:
				row.fingerprintHash === null
					? []
					: parseRowFingerprints(row).map(
							(entry) =>
								new AnomalyIncidentFingerprint({
									fingerprintHash: entry.fingerprintHash,
									errorIssueId:
										entry.errorIssueId === null
											? null
											: decodeIssueIdSync(entry.errorIssueId),
									openedValue: entry.openedValue,
									lastValue: entry.lastValue,
									severity: entry.severity,
									attachedAt: isoFromEpoch(entry.attachedAt),
									resolvedAt:
										entry.resolvedAt === null ? null : isoFromEpoch(entry.resolvedAt),
								}),
						),
			reopenCount: row.reopenCount,
			lastReopenedAt: row.lastReopenedAt ? isoFromDate(row.lastReopenedAt) : null,
		})

	const listIncidents: AnomalyDetectionServiceShape["listIncidents"] = Effect.fn(
		"AnomalyDetectionService.listIncidents",
	)(function* (orgId, opts) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const conditions = [
			eq(anomalyIncidents.orgId, orgId),
			opts.status ? eq(anomalyIncidents.status, opts.status) : undefined,
			opts.signalType ? eq(anomalyIncidents.signalType, opts.signalType) : undefined,
			opts.service ? eq(anomalyIncidents.serviceName, opts.service) : undefined,
			opts.deploymentEnv ? eq(anomalyIncidents.deploymentEnv, opts.deploymentEnv) : undefined,
			// Consolidated incidents carry secondary issue links inside
			// fingerprintsJson; the issue page should surface those too.
			opts.errorIssueId
				? or(
						eq(anomalyIncidents.errorIssueId, opts.errorIssueId),
						// jsonb has no LIKE operator; substring-match its text form.
						sql`${anomalyIncidents.fingerprintsJson}::text LIKE ${`%"${opts.errorIssueId}"%`}`,
					)
				: undefined,
			opts.startTime ? gte(anomalyIncidents.lastTriggeredAt, new Date(opts.startTime)) : undefined,
			opts.endTime ? lte(anomalyIncidents.firstTriggeredAt, new Date(opts.endTime)) : undefined,
		].filter((c): c is NonNullable<typeof c> => c !== undefined)
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(anomalyIncidents)
				.where(and(...conditions))
				.orderBy(desc(anomalyIncidents.lastTriggeredAt))
				.limit(opts.limit ?? 100),
		)
		return new AnomalyIncidentsListResponse({ incidents: rows.map(incidentToDocument) })
	})

	const requireIncidentRow = Effect.fn("AnomalyDetectionService.requireIncidentRow")(function* (
		orgId: OrgId,
		incidentId: AnomalyIncidentId,
	) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(anomalyIncidents)
				.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId)))
				.limit(1),
		)
		const row = rows[0]
		if (!row) {
			return yield* Effect.fail(
				new AnomalyIncidentNotFoundError({
					message: `No such anomaly incident: '${incidentId}'`,
					incidentId,
				}),
			)
		}
		return row
	})

	const getIncident: AnomalyDetectionServiceShape["getIncident"] = Effect.fn(
		"AnomalyDetectionService.getIncident",
	)(function* (orgId, incidentId) {
		yield* Effect.annotateCurrentSpan({ orgId, incidentId })
		const row = yield* requireIncidentRow(orgId, incidentId)
		return incidentToDocument(row)
	})

	// -----------------------------------------------------------------
	// Incident mutations
	// -----------------------------------------------------------------

	const resolveIncidentManually: AnomalyDetectionServiceShape["resolveIncidentManually"] = Effect.fn(
		"AnomalyDetectionService.resolveIncidentManually",
	)(function* (orgId, incidentId) {
		yield* Effect.annotateCurrentSpan({ orgId, incidentId })
		const row = yield* requireIncidentRow(orgId, incidentId)
		if (row.status === "resolved") return incidentToDocument(row)
		const nowMs = yield* Clock.currentTimeMillis
		yield* dbExecute((db) =>
			db
				.update(anomalyIncidents)
				.set({
					status: "resolved",
					resolveReason: "manual",
					resolvedAt: new Date(nowMs),
					updatedAt: new Date(nowMs),
				})
				.where(
					and(
						eq(anomalyIncidents.orgId, orgId),
						eq(anomalyIncidents.id, incidentId),
						// Guard against a concurrent tick resolving first.
						eq(anomalyIncidents.status, "open"),
					),
				),
		)
		// Detector-state consistency: clear the open pointer and start the
		// cooldown so the next tick doesn't immediately re-open the series.
		// Matched on openIncidentId (not detectorKey) so every series feeding
		// a consolidated incident is cleared, and a newer incident's state is
		// never clobbered.
		yield* dbExecute((db) =>
			db
				.update(anomalyDetectorStates)
				.set({
					openIncidentId: null,
					lastResolvedAt: new Date(nowMs),
					lastIncidentId: incidentId,
					consecutiveBreaches: 0,
					consecutiveHealthy: 0,
					updatedAt: new Date(nowMs),
				})
				.where(
					and(
						eq(anomalyDetectorStates.orgId, orgId),
						eq(anomalyDetectorStates.openIncidentId, incidentId),
					),
				),
		)
		const refreshed = yield* requireIncidentRow(orgId, incidentId)
		return incidentToDocument(refreshed)
	})

	const setIncidentIssue: AnomalyDetectionServiceShape["setIncidentIssue"] = Effect.fn(
		"AnomalyDetectionService.setIncidentIssue",
	)(function* (orgId, incidentId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, incidentId, issueId: issueId ?? "(none)" })
		const row = yield* requireIncidentRow(orgId, incidentId)
		if (issueId !== null) {
			const issueRows = yield* dbExecute((db) =>
				db
					.select({ id: errorIssues.id })
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId)))
					.limit(1),
			)
			if (issueRows.length === 0) {
				return yield* Effect.fail(
					new AnomalyLinkedIssueNotFoundError({
						message: `No such error issue: '${issueId}'`,
						issueId,
					}),
				)
			}
		}
		const nowMs = yield* Clock.currentTimeMillis
		yield* dbExecute((db) =>
			db
				.update(anomalyIncidents)
				.set({ errorIssueId: issueId, updatedAt: new Date(nowMs) })
				.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incidentId))),
		)
		const refreshed = yield* requireIncidentRow(orgId, incidentId)
		return {
			incident: incidentToDocument(refreshed),
			previousIssueId: row.errorIssueId ?? null,
		}
	})

	// -----------------------------------------------------------------
	// Incident timeseries — observed-vs-baseline chart data
	// -----------------------------------------------------------------

	/** Max chart window; matches the detector's own baseline horizon. */
	const TIMESERIES_MAX_WINDOW_MS = BASELINE_WINDOW_MS

	const getIncidentTimeseries: AnomalyDetectionServiceShape["getIncidentTimeseries"] = Effect.fn(
		"AnomalyDetectionService.getIncidentTimeseries",
	)(function* (tenant, incidentId, opts) {
		const orgId = tenant.orgId
		yield* Effect.annotateCurrentSpan({ orgId, incidentId })
		const row = yield* requireIncidentRow(orgId, incidentId)
		const nowMs = yield* Clock.currentTimeMillis

		const defaultStart = row.firstTriggeredAt.getTime() - 24 * HOUR_MS
		const defaultEnd = Math.min(nowMs, (dateToMs(row.resolvedAt) ?? nowMs) + 2 * HOUR_MS)
		const requestedStart = opts.startTime !== undefined ? Date.parse(opts.startTime) : defaultStart
		const requestedEnd = opts.endTime !== undefined ? Date.parse(opts.endTime) : defaultEnd
		const endMs = Math.min(Number.isFinite(requestedEnd) ? requestedEnd : defaultEnd, nowMs)
		const startUnclamped = Number.isFinite(requestedStart) ? requestedStart : defaultStart
		const startMs = Math.max(
			startUnclamped < endMs ? startUnclamped : defaultStart,
			endMs - TIMESERIES_MAX_WINDOW_MS,
		)

		const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		const trailingMinutes = Math.max(1, Math.floor((nowMs - currentHourStartMs) / 60_000))
		/** Per-minute rate matching evaluateGoldenSignals: sealed hours divide by 60, the in-progress hour by elapsed minutes. */
		const perMinute = (count: number, bucketStartMs: number) =>
			count / (bucketStartMs >= currentHourStartMs ? trailingMinutes : 60)

		const queryWindow = {
			orgId,
			startTime: toTinybirdDateTime(startMs),
			endTime: toTinybirdDateTime(endMs),
		}

		let unit: AnomalyTimeseriesUnit
		let bucketSeconds: number
		let buckets: AnomalyTimeseriesBucket[]

		if (row.signalType === "error_spike") {
			unit = "count_per_30m"
			bucketSeconds = SPIKE_WINDOW_MS / 1000
			// Consolidated incidents (several co-onset fingerprints) chart the
			// service's full error-event series; a single-fingerprint series
			// would under-represent the event.
			const activeFingerprints = parseRowFingerprints(row).filter((e) => e.resolvedAt === null)
			const compiled =
				activeFingerprints.length > 1
					? CH.compile(CH.anomalyErrorSpikeServiceTimeseriesQuery(), {
							...queryWindow,
							serviceName: row.serviceName,
							deploymentEnv: row.deploymentEnv,
							bucketSeconds,
						})
					: CH.compile(CH.anomalyErrorSpikeTimeseriesQuery(), {
							...queryWindow,
							fingerprintHash: row.fingerprintHash ?? "",
							deploymentEnv: row.deploymentEnv,
							bucketSeconds,
						})
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, {
					profile: "list",
					context: "anomalyIncidentTimeseries",
				})
				.pipe(Effect.mapError(makePersistenceError))
			buckets = rows.map((r) => {
				const count = Number(r.count ?? 0)
				return new AnomalyTimeseriesBucket({
					bucket: isoFromEpoch(parseWarehouseDateTime(String(r.bucket ?? ""))),
					value: count,
					sampleCount: count,
				})
			})
		} else if (row.signalType === "log_volume") {
			unit = "per_minute"
			bucketSeconds = 3600
			const compiled = CH.compile(CH.anomalyLogVolumeTimeseriesQuery(), {
				...queryWindow,
				serviceName: row.serviceName,
				deploymentEnv: row.deploymentEnv,
			})
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, {
					profile: "list",
					context: "anomalyIncidentTimeseries",
				})
				.pipe(Effect.mapError(makePersistenceError))
			buckets = rows.map((r) => {
				const hourMs = parseWarehouseDateTime(String(r.hour ?? ""))
				const errorLogCount = Number(r.errorLogCount ?? 0)
				return new AnomalyTimeseriesBucket({
					bucket: isoFromEpoch(hourMs),
					value: perMinute(errorLogCount, hourMs),
					sampleCount: errorLogCount,
				})
			})
		} else {
			bucketSeconds = 3600
			const compiled = CH.compile(CH.anomalyTraceSignalTimeseriesQuery(), {
				...queryWindow,
				serviceName: row.serviceName,
				deploymentEnv: row.deploymentEnv,
			})
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, {
					profile: "list",
					context: "anomalyIncidentTimeseries",
				})
				.pipe(Effect.mapError(makePersistenceError))
			const signalType = row.signalType
			unit =
				signalType === "error_rate"
					? "ratio"
					: signalType === "latency_p95"
						? "milliseconds"
						: "per_minute"
			buckets = rows.map((r) => {
				const hourMs = parseWarehouseDateTime(String(r.hour ?? ""))
				const requestCount = Number(r.requestCount ?? 0)
				const errorCount = Number(r.errorCount ?? 0)
				const p95Ms = Number(r.p95Ms ?? 0)
				const value =
					signalType === "error_rate"
						? requestCount > 0
							? errorCount / requestCount
							: 0
						: signalType === "latency_p95"
							? p95Ms
							: perMinute(requestCount, hourMs)
				return new AnomalyTimeseriesBucket({
					bucket: isoFromEpoch(hourMs),
					value,
					sampleCount: requestCount,
				})
			})
		}

		return new AnomalyIncidentTimeseriesResponse({
			signalType: row.signalType,
			unit,
			bucketSeconds,
			buckets,
			baselineMedian: row.baselineMedian,
			thresholdValue: row.thresholdValue,
		})
	})

	// -----------------------------------------------------------------
	// Tick: data fetch
	// -----------------------------------------------------------------

	interface HourRow {
		readonly hour: string
		readonly serviceName: string
		readonly deploymentEnv: string
	}

	/** Split matched-hour rows into the in-progress hour vs sealed baseline. */
	const splitRows = <R extends HourRow>(rows: ReadonlyArray<R>, currentHourStartMs: number) => {
		const current = new Map<string, R>()
		const baseline = new Map<string, R[]>()
		for (const row of rows) {
			const key = `${row.serviceName}\u0000${row.deploymentEnv}`
			if (parseWarehouseDateTime(row.hour) >= currentHourStartMs) {
				current.set(key, row)
			} else {
				const list = baseline.get(key)
				if (list) list.push(row)
				else baseline.set(key, [row])
			}
		}
		return { current, baseline }
	}

	const fetchGoldenSeries = Effect.fn("AnomalyDetectionService.fetchGoldenSeries")(function* (
		tenant: TenantContext,
		nowMs: number,
		currentHourStartMs: number,
	) {
		const hoursOfDay = CH.matchedHoursOfDay(new Date(nowMs).getUTCHours())
		const hourBucket = Math.floor(nowMs / HOUR_MS)

		// The 7-day matched-hours baseline only changes when the hour rolls over,
		// so compute it once per org per hour and share the blob from KV. Only the
		// in-progress hour is fetched fresh each tick (a single-hour scan) — this
		// cuts the heavy 7-day scan from 12×/hour to 1×/hour per org.
		const { value: baselineRows } = yield* edgeCache.getOrCompute(
			{
				bucket: GOLDEN_BASELINE_CACHE_BUCKET,
				key: `${tenant.orgId}:${hourBucket}`,
				ttlSeconds: 3600,
			},
			Effect.gen(function* () {
				const compiled = CH.compile(CH.anomalyTraceSignalsQuery({ hoursOfDay }), {
					orgId: tenant.orgId,
					startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
					endTime: toTinybirdDateTime(currentHourStartMs),
				})
				const rows = yield* warehouse
					.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "anomalyTraceSignalsBaseline",
					})
					.pipe(Effect.mapError(makePersistenceError))
				// `Hour <= currentHourStart` includes the in-progress hour; drop it so
				// the cached blob is purely sealed baseline.
				return rows
					.map((r) => ({
						hour: String(r.hour ?? ""),
						serviceName: String(r.serviceName ?? ""),
						deploymentEnv: String(r.deploymentEnv ?? ""),
						requestCount: Number(r.requestCount ?? 0),
						errorCount: Number(r.errorCount ?? 0),
						p95Ms: Number(r.p95Ms ?? 0),
					}))
					.filter((r) => parseWarehouseDateTime(r.hour) < currentHourStartMs)
			}),
		)

		const currentCompiled = CH.compile(CH.anomalyTraceSignalsQuery({ hoursOfDay }), {
			orgId: tenant.orgId,
			startTime: toTinybirdDateTime(currentHourStartMs),
			endTime: toTinybirdDateTime(nowMs),
		})
		const currentRows = yield* warehouse
			.compiledQuery(tenant, currentCompiled, {
				profile: "list",
				context: "anomalyTraceSignalsCurrent",
			})
			.pipe(Effect.mapError(makePersistenceError))
		const currentNormalized = currentRows.map((r) => ({
			hour: String(r.hour ?? ""),
			serviceName: String(r.serviceName ?? ""),
			deploymentEnv: String(r.deploymentEnv ?? ""),
			requestCount: Number(r.requestCount ?? 0),
			errorCount: Number(r.errorCount ?? 0),
			p95Ms: Number(r.p95Ms ?? 0),
		}))

		const { current, baseline } = splitRows([...baselineRows, ...currentNormalized], currentHourStartMs)

		const keys = new Set([...current.keys(), ...baseline.keys()])
		const series: GoldenSignalSeries[] = []
		for (const key of keys) {
			const [serviceName = "", deploymentEnv = ""] = key.split("\u0000")
			const cur = current.get(key)
			series.push({
				serviceName,
				deploymentEnv,
				current: {
					requestCount: cur?.requestCount ?? 0,
					errorCount: cur?.errorCount ?? 0,
					p95Ms: cur?.p95Ms ?? 0,
				},
				baseline: baseline.get(key) ?? [],
			})
		}
		// Bound per-org work to the busiest series.
		return series
			.sort(
				(a, b) =>
					Math.max(b.current.requestCount, b.baseline.length) -
					Math.max(a.current.requestCount, a.baseline.length),
			)
			.slice(0, MAX_SERIES_PER_ORG)
	})

	const fetchLogSeries = Effect.fn("AnomalyDetectionService.fetchLogSeries")(function* (
		tenant: TenantContext,
		nowMs: number,
		currentHourStartMs: number,
	) {
		const hoursOfDay = CH.matchedHoursOfDay(new Date(nowMs).getUTCHours())
		const hourBucket = Math.floor(nowMs / HOUR_MS)

		// Same split as fetchGoldenSeries: cache the sealed 7-day baseline per
		// hour, fetch only the in-progress hour fresh.
		const { value: baselineRows } = yield* edgeCache.getOrCompute(
			{
				bucket: LOG_BASELINE_CACHE_BUCKET,
				key: `${tenant.orgId}:${hourBucket}`,
				ttlSeconds: 3600,
			},
			Effect.gen(function* () {
				const compiled = CH.compile(CH.anomalyLogVolumeQuery({ hoursOfDay }), {
					orgId: tenant.orgId,
					startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
					endTime: toTinybirdDateTime(currentHourStartMs),
				})
				const rows = yield* warehouse
					.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "anomalyLogVolumeBaseline",
					})
					.pipe(Effect.mapError(makePersistenceError))
				return rows
					.map((r) => ({
						hour: String(r.hour ?? ""),
						serviceName: String(r.serviceName ?? ""),
						deploymentEnv: String(r.deploymentEnv ?? ""),
						errorLogCount: Number(r.errorLogCount ?? 0),
					}))
					.filter((r) => parseWarehouseDateTime(r.hour) < currentHourStartMs)
			}),
		)

		const currentCompiled = CH.compile(CH.anomalyLogVolumeQuery({ hoursOfDay }), {
			orgId: tenant.orgId,
			startTime: toTinybirdDateTime(currentHourStartMs),
			endTime: toTinybirdDateTime(nowMs),
		})
		const currentRows = yield* warehouse
			.compiledQuery(tenant, currentCompiled, {
				profile: "list",
				context: "anomalyLogVolumeCurrent",
			})
			.pipe(Effect.mapError(makePersistenceError))
		const currentNormalized = currentRows.map((r) => ({
			hour: String(r.hour ?? ""),
			serviceName: String(r.serviceName ?? ""),
			deploymentEnv: String(r.deploymentEnv ?? ""),
			errorLogCount: Number(r.errorLogCount ?? 0),
		}))

		const { current, baseline } = splitRows([...baselineRows, ...currentNormalized], currentHourStartMs)
		const keys = new Set([...current.keys(), ...baseline.keys()])
		const series: LogVolumeSeries[] = []
		for (const key of keys) {
			const [serviceName = "", deploymentEnv = ""] = key.split("\u0000")
			series.push({
				serviceName,
				deploymentEnv,
				current: { errorLogCount: current.get(key)?.errorLogCount ?? 0 },
				baseline: baseline.get(key) ?? [],
			})
		}
		return series.slice(0, MAX_SERIES_PER_ORG)
	})

	const fetchErrorSpikes = Effect.fn("AnomalyDetectionService.fetchErrorSpikes")(function* (
		tenant: TenantContext,
		nowMs: number,
	) {
		const currentCompiled = CH.compile(CH.anomalyErrorSpikeCurrentQuery({}), {
			orgId: tenant.orgId,
			startTime: toTinybirdDateTime(nowMs - SPIKE_WINDOW_MS),
			endTime: toTinybirdDateTime(nowMs),
		})
		const currentRows = yield* warehouse
			.compiledQuery(tenant, currentCompiled, {
				profile: "list",
				context: "anomalyErrorSpikeCurrent",
			})
			.pipe(Effect.mapError(makePersistenceError))

		const observations = currentRows.map((r) => ({
			fingerprintHash: String(r.fingerprintHash ?? ""),
			serviceName: String(r.serviceName ?? ""),
			deploymentEnv: String(r.deploymentEnv ?? ""),
			count: Number(r.count ?? 0),
		}))

		if (observations.length === 0) {
			return { observations, baselines: new Map<string, ErrorSpikeBaselineEntry>() }
		}

		// The 7d baseline blob is expensive relative to the tick cadence, so it
		// is computed once per hour per org and shared from KV (one query, one
		// blob — deliberately NOT the bucket cache, which fans out).
		const hourBucket = Math.floor(nowMs / HOUR_MS)
		const { value: baselineRows } = yield* edgeCache.getOrCompute(
			{
				bucket: ERROR_SPIKE_BASELINE_CACHE_BUCKET,
				key: `${tenant.orgId}:${hourBucket}`,
				ttlSeconds: 3600,
			},
			Effect.gen(function* () {
				const baselineCompiled = CH.compile(CH.anomalyErrorSpikeBaselineQuery({}), {
					orgId: tenant.orgId,
					startTime: toTinybirdDateTime(nowMs - BASELINE_WINDOW_MS),
					endTime: toTinybirdDateTime(Math.floor(nowMs / HOUR_MS) * HOUR_MS),
				})
				const rows = yield* warehouse
					.compiledQuery(tenant, baselineCompiled, {
						profile: "list",
						context: "anomalyErrorSpikeBaseline",
					})
					.pipe(Effect.mapError(makePersistenceError))
				return rows.map(
					(r): ErrorSpikeBaselineEntry => ({
						fingerprintHash: String(r.fingerprintHash ?? ""),
						deploymentEnv: String(r.deploymentEnv ?? ""),
						totalCount: Number(r.totalCount ?? 0),
					}),
				)
			}),
		)

		const baselines = new Map<string, ErrorSpikeBaselineEntry>()
		for (const row of baselineRows) {
			baselines.set(`${row.fingerprintHash}\u0000${row.deploymentEnv}`, row)
		}
		return { observations, baselines }
	})

	// -----------------------------------------------------------------
	// Tick: per-org processing
	// -----------------------------------------------------------------

	const claimOrg = (orgId: OrgId, nowMs: number) =>
		dbExecute((db) =>
			db
				.update(anomalyDetectorSettings)
				.set({ lastTickAt: new Date(nowMs) })
				.where(
					and(
						eq(anomalyDetectorSettings.orgId, orgId),
						or(
							isNull(anomalyDetectorSettings.lastTickAt),
							lt(anomalyDetectorSettings.lastTickAt, new Date(nowMs - ORG_LOCK_TTL_MS)),
						),
					),
				)
				// The returned row is the claim: empty means another tick holds the lock.
				.returning({ orgId: anomalyDetectorSettings.orgId }),
		)

	const newIncidentId = () => decodeIncidentIdSync(randomUUID())

	interface OrgTickStats {
		seriesEvaluated: number
		incidentsOpened: number
		incidentsAttached: number
		incidentsReopened: number
		incidentsContinued: number
		incidentsResolved: number
	}

	const processOrg = Effect.fn("AnomalyDetectionService.processOrg")(function* (
		orgId: OrgId,
		nowMs: number,
		runRetention: boolean,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, runRetention })
		const stats: OrgTickStats = {
			seriesEvaluated: 0,
			incidentsOpened: 0,
			incidentsAttached: 0,
			incidentsReopened: 0,
			incidentsContinued: 0,
			incidentsResolved: 0,
		}

		const settings = yield* ensureSettingsRow(orgId, nowMs)
		if (!settings.enabled) return stats

		const claim = yield* claimOrg(orgId, nowMs)
		if (claim.length === 0) return stats

		const muted = new Set(parseMutedSignals(settings.mutedSignalsJson))
		const sensitivity = SENSITIVITY[settings.sensitivity] ?? SENSITIVITY.normal
		const tenant = systemTenant(orgId)
		const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
		const elapsedMinutes = Math.floor((nowMs - currentHourStartMs) / 60_000)
		const config = { sensitivity, elapsedMinutes }

		const [goldenSeries, logSeries, spikes] = yield* Effect.all(
			[
				fetchGoldenSeries(tenant, nowMs, currentHourStartMs),
				fetchLogSeries(tenant, nowMs, currentHourStartMs),
				fetchErrorSpikes(tenant, nowMs),
			],
			{ concurrency: 3 },
		)

		// firstSeenAt per fingerprint so young issues stay with first_seen handling.
		// Chunked: D1 caps bound parameters at ~100 per statement, so a single
		// inArray over a busy org's fingerprints fails the whole tick for it
		// (same constraint as ErrorsService's D1_INARRAY_CHUNK_SIZE).
		const fingerprints = [...new Set(spikes.observations.map((o) => o.fingerprintHash))]
		const fingerprintChunks: string[][] = []
		for (let i = 0; i < fingerprints.length; i += D1_INARRAY_CHUNK_SIZE) {
			fingerprintChunks.push(fingerprints.slice(i, i + D1_INARRAY_CHUNK_SIZE))
		}
		const issueRowChunks = yield* Effect.forEach(fingerprintChunks, (chunk) =>
			dbExecute((db) =>
				db
					.select({
						fingerprintHash: errorIssues.fingerprintHash,
						issueId: errorIssues.id,
						firstSeenAt: errorIssues.firstSeenAt,
					})
					.from(errorIssues)
					.where(and(eq(errorIssues.orgId, orgId), inArray(errorIssues.fingerprintHash, chunk))),
			),
		)
		const issueRows = issueRowChunks.flat()
		const issueFirstSeenAt = new Map(issueRows.map((r) => [r.fingerprintHash, r.firstSeenAt.getTime()]))
		const issueIdByFingerprint = new Map(issueRows.map((r) => [r.fingerprintHash, r.issueId]))

		const evaluations: AnomalyEvaluation[] = []
		for (const series of goldenSeries) {
			evaluations.push(...evaluateGoldenSignals(series, config))
		}
		for (const series of logSeries) {
			evaluations.push(evaluateLogVolume(series, config))
		}
		const spikeConfig = { sensitivity, issueFirstSeenAt, nowMs }
		for (const observation of spikes.observations) {
			const baseline = spikes.baselines.get(
				`${observation.fingerprintHash}\u0000${observation.deploymentEnv}`,
			)
			evaluations.push(evaluateErrorSpike(observation, baseline, spikeConfig))
		}

		const active = evaluations.filter((e) => !muted.has(e.signalType))
		stats.seriesEvaluated = active.length

		// Load all detector states + open incidents for the org in two reads.
		const stateRows = yield* dbExecute((db) =>
			db.select().from(anomalyDetectorStates).where(eq(anomalyDetectorStates.orgId, orgId)),
		)
		const stateByKey = new Map<string, AnomalyDetectorStateRow>(stateRows.map((r) => [r.detectorKey, r]))

		// Open incidents, kept current in memory through the (sequential) loop
		// so same-tick attaches and severity recomputes see each other.
		interface IncidentRuntime {
			row: AnomalyIncidentRow
			entries: IncidentFingerprintEntry[]
		}
		const openIncidentRows = yield* dbExecute((db) =>
			db
				.select()
				.from(anomalyIncidents)
				.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.status, "open"))),
		)
		const incidentById = new Map<string, IncidentRuntime>(
			openIncidentRows.map((r) => [r.id, { row: r, entries: parseRowFingerprints(r) }]),
		)
		const incidentOnset = (row: AnomalyIncidentRow) =>
			Math.max(row.firstTriggeredAt.getTime(), dateToMs(row.lastReopenedAt) ?? 0)
		// Attach target per service+env: the most recently onset open spike incident.
		const openSpikeByServiceEnv = new Map<string, IncidentRuntime>()
		for (const runtime of incidentById.values()) {
			if (runtime.row.signalType !== "error_spike") continue
			const key = attachKeyFor(runtime.row.serviceName, runtime.row.deploymentEnv)
			const existing = openSpikeByServiceEnv.get(key)
			if (existing === undefined || incidentOnset(runtime.row) > incidentOnset(existing.row)) {
				openSpikeByServiceEnv.set(key, runtime)
			}
		}

		interface PendingDecision {
			readonly evaluation: AnomalyEvaluation
			readonly state: AnomalyDetectorStateRow | undefined
			readonly transition: "open" | "continue" | "resolve" | "noop"
			readonly consecutiveBreaches: number
			readonly consecutiveHealthy: number
		}

		const decisions: PendingDecision[] = active.map((evaluation) => {
			const state = stateByKey.get(evaluation.detectorKey)
			const snapshot: DetectorStateSnapshot = {
				consecutiveBreaches: state?.consecutiveBreaches ?? 0,
				consecutiveHealthy: state?.consecutiveHealthy ?? 0,
				openIncidentId: state?.openIncidentId ?? null,
				lastResolvedAt: dateToMs(state?.lastResolvedAt ?? null),
			}
			const decision = decideTransition(
				snapshot,
				evaluation,
				stateMachineConfigFor(evaluation.signalType),
				nowMs,
			)
			return { evaluation, state, ...decision }
		})

		// Opens run first (strongest deviation first) so the lead fingerprint
		// creates the incident and co-onset fingerprints attach to it within
		// the same tick. Page-storm guard: new/reopened incidents draw from a
		// per-tick budget; attaches are free. Capped-out series keep their
		// breach counters and open on a later tick if still anomalous.
		const openDecisions = decisions
			.filter((d) => d.transition === "open")
			.sort((a, b) => {
				if (a.evaluation.severity !== b.evaluation.severity) {
					return a.evaluation.severity === "critical" ? -1 : 1
				}
				const ratioA = a.evaluation.threshold > 0 ? a.evaluation.value / a.evaluation.threshold : 0
				const ratioB = b.evaluation.threshold > 0 ? b.evaluation.value / b.evaluation.threshold : 0
				return ratioB - ratioA
			})
		const orderedDecisions = [...openDecisions, ...decisions.filter((d) => d.transition !== "open")]
		let openBudget = MAX_OPENS_PER_TICK

		yield* Effect.forEach(
			orderedDecisions,
			Effect.fnUntraced(function* (decision) {
				const { evaluation } = decision
				const transition = decision.transition

				let openIncidentId = decision.state?.openIncidentId ?? null
				// Kept in ms-number space for the reopen-window arithmetic below;
				// converted back to Date at the detector-state write.
				let lastResolvedAt = dateToMs(decision.state?.lastResolvedAt ?? null)
				let lastIncidentId = decision.state?.lastIncidentId ?? null

				if (transition === "open") {
					const errorIssueId =
						evaluation.fingerprintHash !== null
							? (issueIdByFingerprint.get(evaluation.fingerprintHash) ?? null)
							: null
					let handled = false

					// 1) Attach: a co-onset error spike on a service that already has
					// an open spike incident is the same underlying event — fold it in
					// instead of opening (and triaging) a duplicate.
					if (evaluation.signalType === "error_spike" && evaluation.fingerprintHash !== null) {
						const attachKey = attachKeyFor(evaluation.serviceName, evaluation.deploymentEnv)
						const target = openSpikeByServiceEnv.get(attachKey)
						if (
							target !== undefined &&
							canAttach(
								{
									firstTriggeredAt: target.row.firstTriggeredAt.getTime(),
									lastReopenedAt: dateToMs(target.row.lastReopenedAt),
								},
								nowMs,
							)
						) {
							target.entries = upsertFingerprintEntry(target.entries, {
								fingerprintHash: evaluation.fingerprintHash,
								errorIssueId,
								detectorKey: evaluation.detectorKey,
								openedValue: evaluation.value,
								lastValue: evaluation.value,
								severity: evaluation.severity,
								attachedAt: nowMs,
								resolvedAt: null,
							})
							const severity = headlineSeverity(target.entries, target.row.severity)
							const fingerprintsJson = target.entries
							const updated = yield* dbExecute((db) =>
								db
									.update(anomalyIncidents)
									.set({
										fingerprintsJson,
										severity,
										lastTriggeredAt: new Date(nowMs),
										updatedAt: new Date(nowMs),
									})
									.where(
										and(
											eq(anomalyIncidents.orgId, orgId),
											eq(anomalyIncidents.id, target.row.id),
											// A manual resolve may race the tick; never attach to
											// a resolved incident.
											eq(anomalyIncidents.status, "open"),
										),
									)
									.returning({ id: anomalyIncidents.id }),
							)
							if (updated.length === 0) {
								incidentById.delete(target.row.id)
								openSpikeByServiceEnv.delete(attachKey)
							} else {
								target.row = {
									...target.row,
									fingerprintsJson,
									severity,
									lastTriggeredAt: new Date(nowMs),
								}
								openIncidentId = target.row.id
								lastIncidentId = target.row.id
								stats.incidentsAttached += 1
								handled = true
							}
						}
					}

					// 2) Reopen: a re-breach shortly after an auto-resolve is the same
					// event flapping — reopen the prior incident (keeping its triage
					// result) instead of inserting a duplicate row.
					if (
						!handled &&
						openBudget > 0 &&
						lastIncidentId !== null &&
						lastResolvedAt !== null &&
						nowMs - lastResolvedAt <= REOPEN_WINDOW_MS
					) {
						const reopenTargetId = lastIncidentId
						const priorRows = yield* dbExecute((db) =>
							db
								.select()
								.from(anomalyIncidents)
								.where(
									and(
										eq(anomalyIncidents.orgId, orgId),
										eq(anomalyIncidents.id, reopenTargetId),
									),
								)
								.limit(1),
						)
						const prior = priorRows[0]
						if (prior !== undefined && shouldReopen(prior, lastResolvedAt, nowMs)) {
							let entries = parseRowFingerprints(prior)
							if (evaluation.fingerprintHash !== null) {
								const existing = entries.find(
									(e) => e.fingerprintHash === evaluation.fingerprintHash,
								)
								entries = upsertFingerprintEntry(entries, {
									fingerprintHash: evaluation.fingerprintHash,
									errorIssueId: existing?.errorIssueId ?? errorIssueId,
									detectorKey: evaluation.detectorKey,
									openedValue: existing?.openedValue ?? evaluation.value,
									lastValue: evaluation.value,
									severity: evaluation.severity,
									attachedAt: existing?.attachedAt ?? nowMs,
									resolvedAt: null,
								})
							}
							const severity = headlineSeverity(entries, evaluation.severity)
							const fingerprintsJson = entries
							// The reopening series becomes the incident's primary — a
							// consolidated incident may be reopened by any of its
							// fingerprints, and `detectorKey` must point at a live one.
							const reopenSet = {
								status: "open" as const,
								resolveReason: null,
								resolvedAt: null,
								reopenCount: prior.reopenCount + 1,
								lastReopenedAt: new Date(nowMs),
								severity,
								lastObservedValue: evaluation.value,
								lastSampleCount: evaluation.sampleCount,
								lastTriggeredAt: new Date(nowMs),
								detectorKey: evaluation.detectorKey,
								fingerprintHash: evaluation.fingerprintHash,
								fingerprintsJson,
								updatedAt: new Date(nowMs),
							}
							const updated = yield* dbExecute((db) =>
								db
									.update(anomalyIncidents)
									.set(reopenSet)
									.where(
										and(
											eq(anomalyIncidents.orgId, orgId),
											eq(anomalyIncidents.id, prior.id),
											eq(anomalyIncidents.status, "resolved"),
										),
									)
									.returning({ id: anomalyIncidents.id }),
							)
							if (updated.length !== 0) {
								const runtime: IncidentRuntime = { row: { ...prior, ...reopenSet }, entries }
								incidentById.set(prior.id, runtime)
								if (prior.signalType === "error_spike") {
									openSpikeByServiceEnv.set(
										attachKeyFor(prior.serviceName, prior.deploymentEnv),
										runtime,
									)
								}
								openIncidentId = prior.id
								lastIncidentId = prior.id
								openBudget -= 1
								stats.incidentsReopened += 1
								handled = true
							}
						}
					}

					// 3) New incident.
					if (!handled && openBudget > 0) {
						const incidentId = newIncidentId()
						const entries: IncidentFingerprintEntry[] =
							evaluation.fingerprintHash !== null
								? [
										{
											fingerprintHash: evaluation.fingerprintHash,
											errorIssueId,
											detectorKey: evaluation.detectorKey,
											openedValue: evaluation.value,
											lastValue: evaluation.value,
											severity: evaluation.severity,
											attachedAt: nowMs,
											resolvedAt: null,
										},
									]
								: []
						const insertValues = {
							id: incidentId,
							orgId,
							detectorKey: evaluation.detectorKey,
							signalType: evaluation.signalType,
							serviceName: evaluation.serviceName,
							deploymentEnv: evaluation.deploymentEnv,
							fingerprintHash: evaluation.fingerprintHash,
							errorIssueId,
							status: "open" as const,
							severity: evaluation.severity,
							openedValue: evaluation.value,
							baselineMedian: evaluation.baselineMedian,
							baselineSigma: evaluation.baselineSigma,
							thresholdValue: evaluation.threshold,
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							firstTriggeredAt: new Date(nowMs),
							lastTriggeredAt: new Date(nowMs),
							triageStatus: "none" as const,
							dedupeKey: `${orgId}:${evaluation.detectorKey}`,
							fingerprintsJson: entries,
							reopenCount: 0,
							lastReopenedAt: null,
							createdAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						}
						yield* dbExecute((db) => db.insert(anomalyIncidents).values(insertValues))
						const runtime: IncidentRuntime = {
							row: { ...insertValues, resolvedAt: null, resolveReason: null },
							entries,
						}
						incidentById.set(incidentId, runtime)
						if (evaluation.signalType === "error_spike") {
							openSpikeByServiceEnv.set(
								attachKeyFor(evaluation.serviceName, evaluation.deploymentEnv),
								runtime,
							)
						}
						openIncidentId = incidentId
						lastIncidentId = incidentId
						openBudget -= 1
						stats.incidentsOpened += 1

						// AI auto-triage (org opt-in). Never fails — a triage problem can't
						// take down the detector tick. Attaches and reopens never enqueue:
						// the event was (or is being) triaged under its incident already.
						const triage = yield* maybeEnqueueTriage({
							orgId,
							incidentKind: "anomaly",
							incidentId,
							issueId: errorIssueId ?? undefined,
							context: {
								kind: "anomaly",
								signalType: evaluation.signalType,
								serviceName: evaluation.serviceName,
								deploymentEnv: evaluation.deploymentEnv,
								fingerprintHash: evaluation.fingerprintHash,
								severity: evaluation.severity,
								observedValue: evaluation.value,
								baselineMedian: evaluation.baselineMedian,
								baselineSigma: evaluation.baselineSigma,
								thresholdValue: evaluation.threshold,
								sampleCount: evaluation.sampleCount,
								detectedAt: new Date(nowMs).toISOString(),
							},
							workflowBinding: aiTriageWorkflowBinding,
						}).pipe(Effect.provideService(Database, database))
						if (triage.enqueued) {
							yield* dbExecute((db) =>
								db
									.update(anomalyIncidents)
									.set({ triageStatus: "pending", updatedAt: new Date(nowMs) })
									.where(
										and(
											eq(anomalyIncidents.orgId, orgId),
											eq(anomalyIncidents.id, incidentId),
										),
									),
							)
						}
					}
				} else if (transition === "continue" && openIncidentId !== null) {
					const incidentId = openIncidentId
					const runtime = incidentById.get(incidentId)
					if (runtime !== undefined && evaluation.fingerprintHash !== null) {
						const existing = runtime.entries.find(
							(e) => e.fingerprintHash === evaluation.fingerprintHash,
						)
						runtime.entries = upsertFingerprintEntry(runtime.entries, {
							fingerprintHash: evaluation.fingerprintHash,
							errorIssueId:
								existing?.errorIssueId ??
								issueIdByFingerprint.get(evaluation.fingerprintHash) ??
								null,
							detectorKey: evaluation.detectorKey,
							openedValue: existing?.openedValue ?? evaluation.value,
							lastValue: evaluation.value,
							severity: evaluation.severity,
							attachedAt: existing?.attachedAt ?? nowMs,
							resolvedAt: null,
						})
					}
					const severity =
						runtime !== undefined && runtime.entries.length > 0
							? headlineSeverity(runtime.entries, evaluation.severity)
							: evaluation.severity
					const fingerprintsJson = runtime !== undefined ? runtime.entries : undefined
					// Only the primary series moves the headline value; an attached
					// fingerprint still bumps lastTriggeredAt (and severity) so the
					// no-data sweep can't resolve a still-firing shared incident.
					const isPrimary =
						runtime === undefined || runtime.row.detectorKey === evaluation.detectorKey
					const continueSet = isPrimary
						? {
								lastObservedValue: evaluation.value,
								lastSampleCount: evaluation.sampleCount,
								severity,
								lastTriggeredAt: new Date(nowMs),
								updatedAt: new Date(nowMs),
								...(fingerprintsJson !== undefined ? { fingerprintsJson } : {}),
							}
						: {
								severity,
								lastTriggeredAt: new Date(nowMs),
								updatedAt: new Date(nowMs),
								...(fingerprintsJson !== undefined ? { fingerprintsJson } : {}),
							}
					const updated = yield* dbExecute((db) =>
						db
							.update(anomalyIncidents)
							.set(continueSet)
							.where(
								and(
									eq(anomalyIncidents.orgId, orgId),
									eq(anomalyIncidents.id, incidentId),
									// Guard against a manual resolve landing between the
									// state read and this update — never "continue" a
									// resolved incident.
									eq(anomalyIncidents.status, "open"),
								),
							)
							.returning({ id: anomalyIncidents.id }),
					)
					if (updated.length === 0) {
						// Externally resolved (manual resolve raced the tick): drop the
						// pointer and start the cooldown locally so the state upsert
						// below doesn't re-point at the resolved incident.
						openIncidentId = null
						lastResolvedAt = nowMs
						lastIncidentId = incidentId
						incidentById.delete(incidentId)
					} else {
						if (runtime !== undefined) {
							runtime.row = { ...runtime.row, ...continueSet }
						}
						lastIncidentId = incidentId
						stats.incidentsContinued += 1
					}
				} else if (transition === "resolve" && openIncidentId !== null) {
					const incidentId = openIncidentId
					const runtime = incidentById.get(incidentId)
					if (runtime !== undefined && evaluation.fingerprintHash !== null) {
						runtime.entries = markFingerprintResolved(
							runtime.entries,
							evaluation.fingerprintHash,
							nowMs,
						)
					}
					// Refcount: a consolidated incident only resolves once no other
					// series still points at it.
					const otherStates = yield* dbExecute((db) =>
						db
							.select({
								detectorKey: anomalyDetectorStates.detectorKey,
								fingerprintHash: anomalyDetectorStates.fingerprintHash,
							})
							.from(anomalyDetectorStates)
							.where(
								and(
									eq(anomalyDetectorStates.orgId, orgId),
									eq(anomalyDetectorStates.openIncidentId, incidentId),
									ne(anomalyDetectorStates.detectorKey, evaluation.detectorKey),
								),
							)
							.limit(1),
					)
					if (otherStates.length === 0) {
						yield* dbExecute((db) =>
							db
								.update(anomalyIncidents)
								.set({
									status: "resolved",
									resolveReason: "returned_to_baseline",
									resolvedAt: new Date(nowMs),
									updatedAt: new Date(nowMs),
									...(runtime !== undefined && runtime.entries.length > 0
										? { fingerprintsJson: runtime.entries }
										: {}),
								})
								.where(
									and(
										eq(anomalyIncidents.orgId, orgId),
										eq(anomalyIncidents.id, incidentId),
									),
								),
						)
						incidentById.delete(incidentId)
						if (runtime !== undefined && runtime.row.signalType === "error_spike") {
							const attachKey = attachKeyFor(runtime.row.serviceName, runtime.row.deploymentEnv)
							if (openSpikeByServiceEnv.get(attachKey) === runtime) {
								openSpikeByServiceEnv.delete(attachKey)
							}
						}
						stats.incidentsResolved += 1
					} else {
						// Other fingerprints are still firing: the incident stays open.
						// If the departing series was the primary, promote a remaining
						// one — `detectorKey` must always point at a live series for the
						// continue branch and manual resolve to find it.
						const next = otherStates[0]!
						const isPrimary =
							runtime === undefined || runtime.row.detectorKey === evaluation.detectorKey
						const detachSet = {
							updatedAt: new Date(nowMs),
							...(runtime !== undefined && runtime.entries.length > 0
								? {
										fingerprintsJson: runtime.entries,
										severity: headlineSeverity(runtime.entries, runtime.row.severity),
									}
								: {}),
							...(isPrimary
								? { detectorKey: next.detectorKey, fingerprintHash: next.fingerprintHash }
								: {}),
						}
						yield* dbExecute((db) =>
							db
								.update(anomalyIncidents)
								.set(detachSet)
								.where(
									and(
										eq(anomalyIncidents.orgId, orgId),
										eq(anomalyIncidents.id, incidentId),
									),
								),
						)
						if (runtime !== undefined) {
							runtime.row = { ...runtime.row, ...detachSet }
						}
					}
					openIncidentId = null
					lastResolvedAt = nowMs
					lastIncidentId = incidentId
				}

				yield* dbExecute((db) =>
					db
						.insert(anomalyDetectorStates)
						.values({
							orgId,
							detectorKey: evaluation.detectorKey,
							signalType: evaluation.signalType,
							serviceName: evaluation.serviceName,
							deploymentEnv: evaluation.deploymentEnv,
							fingerprintHash: evaluation.fingerprintHash,
							consecutiveBreaches: decision.consecutiveBreaches,
							consecutiveHealthy: decision.consecutiveHealthy,
							lastStatus: evaluation.status,
							lastValue: evaluation.value,
							baselineMedian: evaluation.baselineMedian,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: new Date(nowMs),
							openIncidentId,
							lastResolvedAt: msToDate(lastResolvedAt),
							lastIncidentId,
							updatedAt: new Date(nowMs),
						})
						.onConflictDoUpdate({
							target: [anomalyDetectorStates.orgId, anomalyDetectorStates.detectorKey],
							set: {
								consecutiveBreaches: decision.consecutiveBreaches,
								consecutiveHealthy: decision.consecutiveHealthy,
								lastStatus: evaluation.status,
								lastValue: evaluation.value,
								baselineMedian: evaluation.baselineMedian,
								lastSampleCount: evaluation.sampleCount,
								lastEvaluatedAt: new Date(nowMs),
								openIncidentId,
								lastResolvedAt: msToDate(lastResolvedAt),
								lastIncidentId,
								updatedAt: new Date(nowMs),
							},
						}),
				)
			}),
			{ discard: true },
		)

		// No-data sweep: open incidents whose series stopped reporting entirely
		// resolve after an hour of silence (mirrors ErrorsService auto-resolve).
		const staleIncidents = yield* dbExecute((db) =>
			db
				.select()
				.from(anomalyIncidents)
				.where(
					and(
						eq(anomalyIncidents.orgId, orgId),
						eq(anomalyIncidents.status, "open"),
						lt(anomalyIncidents.lastTriggeredAt, new Date(nowMs - NO_DATA_RESOLVE_MS)),
					),
				),
		)
		yield* Effect.forEach(
			staleIncidents,
			Effect.fnUntraced(function* (incident) {
				yield* dbExecute((db) =>
					db
						.update(anomalyIncidents)
						.set({
							status: "resolved",
							resolveReason: "no_data",
							resolvedAt: new Date(nowMs),
							updatedAt: new Date(nowMs),
						})
						.where(and(eq(anomalyIncidents.orgId, orgId), eq(anomalyIncidents.id, incident.id))),
				)
				// Matched on openIncidentId so every series feeding a consolidated
				// incident is cleared, not just the primary.
				yield* dbExecute((db) =>
					db
						.update(anomalyDetectorStates)
						.set({
							openIncidentId: null,
							lastResolvedAt: new Date(nowMs),
							lastIncidentId: incident.id,
							consecutiveBreaches: 0,
							consecutiveHealthy: 0,
							updatedAt: new Date(nowMs),
						})
						.where(
							and(
								eq(anomalyDetectorStates.orgId, orgId),
								eq(anomalyDetectorStates.openIncidentId, incident.id),
							),
						),
				)
				stats.incidentsResolved += 1
			}),
			{ discard: true },
		)

		if (runRetention) {
			yield* dbExecute((db) =>
				db
					.delete(anomalyDetectorStates)
					.where(
						and(
							eq(anomalyDetectorStates.orgId, orgId),
							lt(anomalyDetectorStates.lastEvaluatedAt, new Date(nowMs - STATE_RETENTION_MS)),
						),
					),
			)
		}

		return stats
	})

	const runTick: AnomalyDetectionServiceShape["runTick"] = Effect.fn("AnomalyDetectionService.runTick")(
		function* () {
			const nowMs = yield* Clock.currentTimeMillis
			const runRetention = Math.floor(nowMs / TICK_CADENCE_MS) % RETENTION_PHASE_EVERY_N_TICKS === 0

			const ingestOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
			)
			const settingsOrgs = yield* dbExecute((db) =>
				db.selectDistinct({ orgId: anomalyDetectorSettings.orgId }).from(anomalyDetectorSettings),
			)
			const knownOrgs = new Set<OrgId>(
				[...ingestOrgs, ...settingsOrgs].map((r) => decodeOrgIdSync(r.orgId)),
			)

			// Orgs with an OPEN incident must be processed even when idle so the
			// no-data sweep (NO_DATA_RESOLVE_MS) can resolve incidents whose series
			// went silent.
			const openIncidentRows = yield* dbExecute((db) =>
				db
					.selectDistinct({ orgId: anomalyIncidents.orgId })
					.from(anomalyIncidents)
					.where(eq(anomalyIncidents.status, "open")),
			)
			const mustProcess = new Set<OrgId>(openIncidentRows.map((r) => decodeOrgIdSync(r.orgId)))
			const candidates = new Set<OrgId>([...knownOrgs, ...mustProcess])

			const activeOrgs = yield* resolveActiveOrgs([...candidates], nowMs)
			const orgsToProcess = [...candidates].filter(
				(org) => activeOrgs.has(org) || mustProcess.has(org),
			)

			const orgFailures = yield* Ref.make(0)
			const emptyStats = {
				seriesEvaluated: 0,
				incidentsOpened: 0,
				incidentsAttached: 0,
				incidentsReopened: 0,
				incidentsContinued: 0,
				incidentsResolved: 0,
			}
			const results = yield* Effect.forEach(
				orgsToProcess,
				(org) =>
					processOrg(org, nowMs, runRetention).pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								yield* Effect.logError("Anomaly tick failed for org").pipe(
									Effect.annotateLogs({ orgId: org, error: Cause.pretty(cause) }),
								)
								yield* Ref.update(orgFailures, (n) => n + 1)
								return emptyStats
							}),
						),
					),
				{ concurrency: 4 },
			)

			const totals = results.reduce(
				(acc, r) => ({
					seriesEvaluated: acc.seriesEvaluated + r.seriesEvaluated,
					incidentsOpened: acc.incidentsOpened + r.incidentsOpened,
					incidentsAttached: acc.incidentsAttached + r.incidentsAttached,
					incidentsReopened: acc.incidentsReopened + r.incidentsReopened,
					incidentsContinued: acc.incidentsContinued + r.incidentsContinued,
					incidentsResolved: acc.incidentsResolved + r.incidentsResolved,
				}),
				emptyStats,
			)

			const failureCount = yield* Ref.get(orgFailures)
			yield* Effect.annotateCurrentSpan({
				orgsKnown: knownOrgs.size,
				orgsProcessed: orgsToProcess.length,
				orgFailures: failureCount,
				...totals,
			})

			return { orgsProcessed: orgsToProcess.length, orgFailures: failureCount, ...totals }
		},
	)

	return AnomalyDetectionService.of({
		runTick,
		listIncidents,
		getIncident,
		resolveIncidentManually,
		setIncidentIssue,
		getIncidentTimeseries,
		getSettings,
		updateSettings,
	})
})

export class AnomalyDetectionService extends Context.Service<
	AnomalyDetectionService,
	AnomalyDetectionServiceShape
>()("@maple/api/services/AnomalyDetectionService") {
	static readonly layer = Layer.effect(this, make)
}
