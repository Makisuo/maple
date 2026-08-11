import {
	type ActorId,
	ErrorIncidentDocument,
	ErrorIncidentsListResponse,
	ErrorIssueDetailResponse,
	ErrorIssueDocument,
	type ErrorIssueId,
	ErrorIssueNotFoundError,
	ErrorIssueSampleTrace,
	ErrorIssuesListResponse,
	ErrorIssueTimeseriesPoint,
	ErrorPersistenceError,
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
	UserId as UserIdSchema,
	type WorkflowState,
} from "@maple/domain/http"
import { errorIncidents, type ErrorIncidentRow, errorIssues } from "@maple/db"
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import {
	CH,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	warehouseDateTimeToIso,
} from "@maple/query-engine"
import { Clock, Context, Effect, Layer, Match, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { dateToMs, msToDate } from "@/platform/time"
import type { TenantContext } from "@/services/auth/AuthService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { makeErrorDatabaseExecute, makePersistenceError } from "./error-persistence"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const encodeIssueListCursor = Schema.encodeSync(IssueListCursor)
const encodeIssueSeverityListCursorRaw = Schema.encodeSync(IssueSeverityListCursor)
const encodeIssueSeverityListCursor = (fields: IssueSeverityListCursorFields): string =>
	`sev_${encodeIssueSeverityListCursorRaw(fields)}`
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.firstSeenAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeTraceIdSync = Schema.decodeUnknownSync(TraceIdSchema)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanIdSchema)

const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
/** Fallback fingerprint-scan window for the issue list's env filter when the
 * caller provides no time range (30d ≈ the issue-list retention horizon). */
const ENV_FINGERPRINT_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
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

export interface ErrorIssueReadModelsPublicShape {
	readonly listIssues: (
		orgId: OrgId,
		opts: {
			readonly workflowState?: WorkflowState
			readonly severity?: IssueSeverity | "unset"
			readonly kind?: IssueKind
			readonly service?: string
			/** Only issues whose fingerprint the warehouse observed in this
			 * deployment environment (within startTime/endTime, defaulting to the
			 * trailing 30d). Costs one warehouse round-trip; excludes alert-kind
			 * issues (synthetic fingerprints carry no environment). */
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
	/** Fleet-level open (actionable-state) error-issue counts grouped by service. */
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
	readonly listIssueIncidents: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError | ErrorIssueNotFoundError>
	readonly listOpenIncidents: (
		orgId: OrgId,
	) => Effect.Effect<ErrorIncidentsListResponse, ErrorPersistenceError>
}

export type ErrorIssueReadModelsServiceShape = ErrorIssueReadModelsPublicShape

const make: Effect.Effect<
	ErrorIssueReadModelsServiceShape,
	never,
	Database | WarehouseQueryService | ErrorIssueWorkflowService
> = Effect.gen(function* () {
	const database = yield* Database
	const warehouse = yield* WarehouseQueryService
	const workflow = yield* ErrorIssueWorkflowService
	const dbExecute = makeErrorDatabaseExecute(database)

	const systemTenant = (orgId: OrgId): TenantContext => ({
		orgId,
		userId: decodeUserIdSync("system-errors"),
		roles: [decodeRoleNameSync("root")],
		authMode: "self_hosted",
	})

	const rowToIncident = (row: ErrorIncidentRow) =>
		new ErrorIncidentDocument({
			id: row.id,
			issueId: row.issueId,
			status: row.status,
			reason: row.reason,
			firstTriggeredAt: decodeIsoDateTimeStringSync(row.firstTriggeredAt.toISOString()),
			lastTriggeredAt: decodeIsoDateTimeStringSync(row.lastTriggeredAt.toISOString()),
			resolvedAt:
				row.resolvedAt == null ? null : decodeIsoDateTimeStringSync(row.resolvedAt.toISOString()),
			occurrenceCount: row.occurrenceCount,
		})

	const listIssues: ErrorIssueReadModelsServiceShape["listIssues"] = Effect.fn("ErrorsService.listIssues")(
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

			// `""` is a real filter (raw spans without a deployment env), so check
			// for undefined rather than truthiness.
			if (opts.deploymentEnv !== undefined) {
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
					.compiledQuery(systemTenant(orgId), compiled, {
						context: "errorIssueEnvFingerprints",
					})
					.pipe(Effect.mapError(makePersistenceError))
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
				if (Number.isFinite(endMs)) conditions.push(lt(errorIssues.firstSeenAt, msToDate(endMs)))
			}
			if (opts.startTime) {
				const startMs = parseWarehouseDateTime(opts.startTime)
				if (Number.isFinite(startMs)) conditions.push(gt(errorIssues.lastSeenAt, msToDate(startMs)))
			}
			if (opts.cursor) {
				const cursorSeenAt = msToDate(opts.cursor.lastSeenAt)
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
			const issues = yield* workflow.hydrateIssueRows(orgId, rows)

			yield* Effect.annotateCurrentSpan({ issueCount: issues.length, hasMore })
			const lastRow = rows.at(-1)
			const nextCursor =
				hasMore && lastRow
					? sort === "severity"
						? encodeIssueSeverityListCursor({
								severityRank: severitySortRank(lastRow.severity),
								lastSeenAt: dateToMs(lastRow.lastSeenAt),
								id: decodeErrorIssueIdSync(lastRow.id),
							})
						: encodeIssueListCursor({
								lastSeenAt: dateToMs(lastRow.lastSeenAt),
								id: decodeErrorIssueIdSync(lastRow.id),
							})
					: undefined
			return new ErrorIssuesListResponse(nextCursor === undefined ? { issues } : { issues, nextCursor })
		},
	)

	const countOpenIssuesByService: ErrorIssueReadModelsServiceShape["countOpenIssuesByService"] = Effect.fn(
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

	const getIssue: ErrorIssueReadModelsServiceShape["getIssue"] = Effect.fn("ErrorsService.getIssue")(
		function* (orgId, issueId, opts) {
			yield* Effect.annotateCurrentSpan({ orgId, issueId })
			const issueRow = yield* workflow.requireIssue(orgId, issueId)
			const endMs = opts.endTime ? parseWarehouseDateTime(opts.endTime) : yield* Clock.currentTimeMillis
			const startMs = opts.startTime
				? parseWarehouseDateTime(opts.startTime)
				: endMs - DEFAULT_DETAIL_WINDOW_MS
			const bucketSeconds = opts.bucketSeconds ?? 3600
			const sampleLimit = opts.sampleLimit ?? 25
			const tenant = systemTenant(orgId)
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
						.compiledQuery(tenant, timeseriesCompiled, {
							context: "errorIssueTimeseries",
						})
						.pipe(Effect.mapError(makePersistenceError))
				: Effect.succeed([])

			const samplesCompiled = CH.compile(CH.errorIssueSampleTracesQuery({ limit: sampleLimit }), {
				orgId,
				fingerprintHash: issueRow.fingerprintHash,
				startTime: formatWarehouseDateTime(startMs),
				endTime: formatWarehouseDateTime(endMs),
			})
			const samplesEffect = isErrorKind
				? warehouse
						.compiledQuery(tenant, samplesCompiled, {
							context: "errorIssueSampleTraces",
						})
						.pipe(Effect.mapError(makePersistenceError))
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
			const issue = (yield* workflow.hydrateIssueRows(orgId, [issueRow]))[0]!
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
				issue,
				timeseries,
				sampleTraces,
				incidents: incidentRows.map(rowToIncident),
			})
		},
	)

	const listIssueIncidents: ErrorIssueReadModelsServiceShape["listIssueIncidents"] = Effect.fn(
		"ErrorsService.listIssueIncidents",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId })
		yield* workflow.requireIssue(orgId, issueId)
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

	const listOpenIncidents: ErrorIssueReadModelsServiceShape["listOpenIncidents"] = Effect.fn(
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

	return ErrorIssueReadModelsService.of({
		listIssues,
		countOpenIssuesByService,
		getIssue,
		listIssueIncidents,
		listOpenIncidents,
	})
})

export class ErrorIssueReadModelsService extends Context.Service<
	ErrorIssueReadModelsService,
	ErrorIssueReadModelsServiceShape
>()("@maple/api/services/errors/ErrorIssueReadModelsService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
