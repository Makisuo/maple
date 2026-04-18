import { randomUUID } from "node:crypto"
import {
  type AlertDestinationId,
  type AlertSeverity,
  ErrorIncidentDocument,
  ErrorIncidentsListResponse,
  type ErrorIncidentReason,
  ErrorIssueDetailResponse,
  ErrorIssueDocument,
  type ErrorIssueId,
  ErrorIssueNotFoundError,
  ErrorIssueSampleTrace,
  ErrorIssuesListResponse,
  type ErrorIssueStatus,
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
} from "@maple/domain/http"
import {
  errorIncidents,
  type ErrorIncidentRow,
  errorIssues,
  type ErrorIssueRow,
  errorIssueStates,
  errorNotificationPolicies,
  type ErrorNotificationPolicyRow,
} from "@maple/db"
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { Database, DatabaseError, type DatabaseClient } from "./DatabaseLive"
import { Env } from "./Env"
import { NotificationDispatcher } from "./NotificationDispatcher"
import { TinybirdService } from "./TinybirdService"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(
  ErrorIssueDocument.fields.firstSeenAt,
)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeTraceIdSync = Schema.decodeUnknownSync(TraceIdSchema)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanIdSchema)

const DEFAULT_LIST_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
const AUTO_RESOLVE_MINUTES = 30
const TICK_WINDOW_MS = 2 * 60_000
const RESOLVED_RETENTION_DAYS = 14
const ARCHIVED_RETENTION_DAYS = 90
const RETENTION_PHASE_EVERY_N_TICKS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface ErrorsServiceShape {
  readonly listIssues: (
    orgId: OrgId,
    opts: {
      readonly status?: ErrorIssueStatus
      readonly service?: string
      readonly deploymentEnv?: string
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
  ) => Effect.Effect<
    ErrorIssueDetailResponse,
    ErrorPersistenceError | ErrorIssueNotFoundError
  >
  readonly updateIssue: (
    orgId: OrgId,
    userId: UserId,
    issueId: ErrorIssueId,
    patch: {
      readonly status?: ErrorIssueStatus
      readonly assignedTo?: UserId | null
      readonly notes?: string | null
      readonly ignoredUntil?: string | null
    },
  ) => Effect.Effect<
    ErrorIssueDocument,
    ErrorPersistenceError | ErrorIssueNotFoundError | ErrorValidationError
  >
  readonly listIssueIncidents: (
    orgId: OrgId,
    issueId: ErrorIssueId,
  ) => Effect.Effect<
    ErrorIncidentsListResponse,
    ErrorPersistenceError | ErrorIssueNotFoundError
  >
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
  ) => Effect.Effect<
    ErrorNotificationPolicyDocument,
    ErrorPersistenceError | ErrorValidationError
  >
  readonly runTick: () => Effect.Effect<
    {
      readonly orgsProcessed: number
      readonly issuesTouched: number
      readonly incidentsOpened: number
      readonly incidentsResolved: number
      readonly issuesReopened: number
      readonly issuesArchived: number
      readonly issuesDeleted: number
      readonly retentionRan: boolean
    },
    ErrorPersistenceError
  >
}

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceShape>()(
  "ErrorsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const tinybird = yield* TinybirdService
      const env = yield* Env
      const dispatcher = yield* NotificationDispatcher

      const now = () => Date.now()
      const newErrorIssueId = () => decodeErrorIssueIdSync(randomUUID())
      const newErrorIncidentId = () => decodeErrorIncidentIdSync(randomUUID())

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

      const makePersistenceError = (error: unknown) => {
        if (error instanceof DatabaseError) {
          return new ErrorPersistenceError({
            message: error.message,
            cause: describeCause(error.cause),
          })
        }
        if (error instanceof Error) {
          return new ErrorPersistenceError({
            message: error.message,
            cause: describeCause(error.cause),
          })
        }
        return new ErrorPersistenceError({
          message: "Error persistence failure",
          cause: describeCause(error),
        })
      }

      const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
        database.execute(fn).pipe(
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

      const systemTenant = (orgId: OrgId): TenantContext => ({
        orgId,
        userId: decodeUserIdSync("system-errors"),
        roles: [decodeRoleNameSync("root")],
        authMode: "self_hosted",
      })

      const rowToIssue = (row: ErrorIssueRow, hasOpenIncident: boolean) =>
        new ErrorIssueDocument({
          id: row.id,
          fingerprintHash: row.fingerprintHash,
          serviceName: row.serviceName,
          exceptionType: row.exceptionType,
          exceptionMessage: row.exceptionMessage,
          topFrame: row.topFrame,
          status: row.status,
          assignedTo: row.assignedTo ?? null,
          notes: row.notes ?? null,
          firstSeenAt: decodeIsoDateTimeStringSync(new Date(row.firstSeenAt).toISOString()),
          lastSeenAt: decodeIsoDateTimeStringSync(new Date(row.lastSeenAt).toISOString()),
          occurrenceCount: row.occurrenceCount,
          resolvedAt:
            row.resolvedAt == null
              ? null
              : decodeIsoDateTimeStringSync(new Date(row.resolvedAt).toISOString()),
          resolvedBy: row.resolvedBy ?? null,
          ignoredUntil:
            row.ignoredUntil == null
              ? null
              : decodeIsoDateTimeStringSync(new Date(row.ignoredUntil).toISOString()),
          hasOpenIncident,
        })

      const rowToIncident = (row: ErrorIncidentRow) =>
        new ErrorIncidentDocument({
          id: row.id,
          issueId: row.issueId,
          status: row.status,
          reason: row.reason,
          firstTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.firstTriggeredAt).toISOString()),
          lastTriggeredAt: decodeIsoDateTimeStringSync(new Date(row.lastTriggeredAt).toISOString()),
          resolvedAt:
            row.resolvedAt == null
              ? null
              : decodeIsoDateTimeStringSync(new Date(row.resolvedAt).toISOString()),
          occurrenceCount: row.occurrenceCount,
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

      const issuesWithOpenIncidents = (
        orgId: OrgId,
        issueIds: ReadonlyArray<ErrorIssueId>,
      ) =>
        issueIds.length === 0
          ? Effect.succeed(new Set<ErrorIssueId>())
          : dbExecute((db) =>
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
            ).pipe(Effect.map((rows) => new Set(rows.map((r) => r.issueId))))

      const listIssues: ErrorsServiceShape["listIssues"] = Effect.fn(
        "ErrorsService.listIssues",
      )(function* (orgId, opts) {
          yield* Effect.annotateCurrentSpan({
            orgId,
            status: opts.status ?? "all",
            limit: opts.limit ?? 100,
          })
          const conditions = [eq(errorIssues.orgId, orgId)]
          if (opts.status) conditions.push(eq(errorIssues.status, opts.status))
          if (opts.service) conditions.push(eq(errorIssues.serviceName, opts.service))
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

          const openSet = yield* issuesWithOpenIncidents(
            orgId,
            rows.map((r) => r.id),
          )

          const issuesResult = rows.map((r) => rowToIssue(r, openSet.has(r.id)))
          yield* Effect.annotateCurrentSpan("issueCount", issuesResult.length)
          return new ErrorIssuesListResponse({ issues: issuesResult })
        })

      const getIssue: ErrorsServiceShape["getIssue"] = Effect.fn(
        "ErrorsService.getIssue",
      )(function* (orgId, issueId, opts) {
          yield* Effect.annotateCurrentSpan({ orgId, issueId })
          const issueRow = yield* requireIssue(orgId, issueId)
          const endMs = opts.endTime ? Date.parse(opts.endTime) : now()
          const startMs = opts.startTime
            ? Date.parse(opts.startTime)
            : endMs - DEFAULT_DETAIL_WINDOW_MS
          const bucketSeconds = opts.bucketSeconds ?? 3600
          const sampleLimit = opts.sampleLimit ?? 25

          const tenant = systemTenant(orgId)

          const timeseriesEffect = tinybird
            .query(tenant, {
              pipe: "error_issue_timeseries",
              params: {
                fingerprint_hash: issueRow.fingerprintHash,
                start_time: toTinybirdDateTime(startMs),
                end_time: toTinybirdDateTime(endMs),
                bucket_seconds: bucketSeconds,
              },
            })
            .pipe(Effect.mapError((e) => makePersistenceError(e)))

          const samplesEffect = tinybird
            .query(tenant, {
              pipe: "error_issue_sample_traces",
              params: {
                fingerprint_hash: issueRow.fingerprintHash,
                start_time: toTinybirdDateTime(startMs),
                end_time: toTinybirdDateTime(endMs),
                limit: sampleLimit,
              },
            })
            .pipe(Effect.mapError((e) => makePersistenceError(e)))

          const incidentsEffect = dbExecute((db) =>
            db
              .select()
              .from(errorIncidents)
              .where(
                and(
                  eq(errorIncidents.orgId, orgId),
                  eq(errorIncidents.issueId, issueId),
                ),
              )
              .orderBy(desc(errorIncidents.lastTriggeredAt))
              .limit(50),
          )

          const [timeseriesResp, samplesResp, incidentRows] = yield* Effect.all(
            [timeseriesEffect, samplesEffect, incidentsEffect],
            { concurrency: 3 },
          )

          const openSet = yield* issuesWithOpenIncidents(orgId, [issueRow.id])

          const timeseries = (timeseriesResp.data as ReadonlyArray<Record<string, unknown>>).map(
            (row) =>
              new ErrorIssueTimeseriesPoint({
                bucket: decodeIsoDateTimeStringSync(new Date(String(row.bucket)).toISOString()),
                count: Number(row.count ?? 0),
              }),
          )

          const sampleTraces = (samplesResp.data as ReadonlyArray<Record<string, unknown>>).map(
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
            issue: rowToIssue(issueRow, openSet.has(issueRow.id)),
            timeseries,
            sampleTraces,
            incidents: incidentRows.map(rowToIncident),
          })
        })

      const normalizeOptionalText = <T extends string>(
        value: T | null | undefined,
      ): T | null | undefined => {
        if (value === undefined) return undefined
        if (value === null) return null
        const trimmed = value.trim()
        return trimmed.length === 0 ? null : (trimmed as T)
      }

      const updateIssue: ErrorsServiceShape["updateIssue"] = Effect.fn(
        "ErrorsService.updateIssue",
      )(function* (orgId, userId, issueId, patch) {
          yield* Effect.annotateCurrentSpan({
            orgId,
            issueId,
            action: patch.status ?? "patch",
            patches: Object.keys(patch).join(","),
          })
          const current = yield* requireIssue(orgId, issueId)
          const timestamp = now()
          const nextStatus = patch.status ?? (current.status as ErrorIssueStatus)
          const isResolving =
            patch.status === "resolved" && current.status !== "resolved"
          const isReopening =
            patch.status != null &&
            patch.status !== "resolved" &&
            current.status === "resolved"

          const update: Partial<ErrorIssueRow> = {
            status: nextStatus,
            updatedAt: timestamp,
          }
          if (patch.assignedTo !== undefined) {
            update.assignedTo = normalizeOptionalText(patch.assignedTo)
          }
          if (patch.notes !== undefined) {
            update.notes = normalizeOptionalText(patch.notes)
          }
          if (patch.ignoredUntil !== undefined) {
            if (patch.ignoredUntil === null) {
              update.ignoredUntil = null
            } else {
              const ms = Date.parse(patch.ignoredUntil)
              if (!Number.isFinite(ms))
                return yield* Effect.fail(
                  new ErrorValidationError({
                    message: "Invalid ignoredUntil timestamp",
                    details: [String(patch.ignoredUntil)],
                  }),
                )
              update.ignoredUntil = ms
            }
          }
          if (isResolving) {
            update.resolvedAt = timestamp
            update.resolvedBy = userId
          } else if (isReopening) {
            update.resolvedAt = null
            update.resolvedBy = null
          }

          yield* dbExecute((db) =>
            db
              .update(errorIssues)
              .set(update)
              .where(and(eq(errorIssues.orgId, orgId), eq(errorIssues.id, issueId))),
          )

          if (isResolving) {
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
                    eq(errorIncidents.issueId, issueId),
                    eq(errorIncidents.status, "open"),
                  ),
                ),
            )
            yield* dbExecute((db) =>
              db
                .update(errorIssueStates)
                .set({ openIncidentId: null, updatedAt: timestamp })
                .where(
                  and(
                    eq(errorIssueStates.orgId, orgId),
                    eq(errorIssueStates.issueId, issueId),
                  ),
                ),
            )
          }

          const updatedRow = yield* requireIssue(orgId, issueId)
          const openSet = yield* issuesWithOpenIncidents(orgId, [updatedRow.id])
          return rowToIssue(updatedRow, openSet.has(updatedRow.id))
        })

      const listIssueIncidents: ErrorsServiceShape["listIssueIncidents"] = Effect.fn(
        "ErrorsService.listIssueIncidents",
      )(function* (orgId, issueId) {
          yield* Effect.annotateCurrentSpan({ orgId, issueId })
          yield* requireIssue(orgId, issueId)
          const rows = yield* dbExecute((db) =>
            db
              .select()
              .from(errorIncidents)
              .where(
                and(eq(errorIncidents.orgId, orgId), eq(errorIncidents.issueId, issueId)),
              )
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
              .where(
                and(
                  eq(errorIncidents.orgId, orgId),
                  eq(errorIncidents.status, "open"),
                ),
              )
              .orderBy(desc(errorIncidents.lastTriggeredAt))
              .limit(500),
          )
          yield* Effect.annotateCurrentSpan("incidentCount", rows.length)
          return new ErrorIncidentsListResponse({
            incidents: rows.map(rowToIncident),
          })
        })

      // -----------------------------------------------------------------
      // Notification policy (per-org) controlling incident delivery.
      // -----------------------------------------------------------------

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
          minOccurrenceCount: row.minOccurrenceCount,
          severity: row.severity as AlertSeverity,
          updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
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

      const upsertNotificationPolicy: ErrorsServiceShape["upsertNotificationPolicy"] =
        Effect.fn("ErrorsService.upsertNotificationPolicy")(function* (
          orgId,
          userId,
          request,
        ) {
          yield* Effect.annotateCurrentSpan({ orgId })
          const existing = yield* loadPolicyRow(orgId)
          const base = existing ?? defaultPolicy(orgId, now())
          const timestamp = now()

          const nextDestinations =
            request.destinationIds !== undefined
              ? JSON.stringify(request.destinationIds)
              : base.destinationIdsJson

          const merged: ErrorNotificationPolicyRow = {
            orgId,
            enabled: request.enabled !== undefined ? (request.enabled ? 1 : 0) : base.enabled,
            destinationIdsJson: nextDestinations,
            notifyOnFirstSeen:
              request.notifyOnFirstSeen !== undefined
                ? request.notifyOnFirstSeen
                  ? 1
                  : 0
                : base.notifyOnFirstSeen,
            notifyOnRegression:
              request.notifyOnRegression !== undefined
                ? request.notifyOnRegression
                  ? 1
                  : 0
                : base.notifyOnRegression,
            notifyOnResolve:
              request.notifyOnResolve !== undefined
                ? request.notifyOnResolve
                  ? 1
                  : 0
                : base.notifyOnResolve,
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
                  minOccurrenceCount: merged.minOccurrenceCount,
                  severity: merged.severity,
                  updatedAt: merged.updatedAt,
                  updatedBy: merged.updatedBy,
                },
              }),
          )

          return rowToPolicy(merged)
        },
      )

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

      // -----------------------------------------------------------------
      // Scheduled tick: scan error_events for new fingerprints, upsert
      // issues, open/resolve incidents, auto-resolve silent ones.
      // -----------------------------------------------------------------

      const processOrg = Effect.fn("ErrorsService.processOrg")(function* (
        orgId: OrgId,
        windowStartMs: number,
        windowEndMs: number,
        runRetention: boolean,
      ) {
          yield* Effect.annotateCurrentSpan({ orgId, runRetention })
          const tenant = systemTenant(orgId)
          const policy =
            (yield* loadPolicyRow(orgId)) ?? defaultPolicy(orgId, windowEndMs)

          // Re-open ignored issues whose silence window has expired, so that
          // any new events observed in this tick are treated as regressions
          // rather than skipped by the early-continue below.
          const reopened = yield* dbExecute((db) =>
            db
              .update(errorIssues)
              .set({
                status: "open",
                ignoredUntil: null,
                updatedAt: windowEndMs,
              })
              .where(
                and(
                  eq(errorIssues.orgId, orgId),
                  eq(errorIssues.status, "ignored"),
                  isNotNull(errorIssues.ignoredUntil),
                  lt(errorIssues.ignoredUntil, windowEndMs),
                ),
              )
              .returning({ id: errorIssues.id }),
          )
          const issuesReopened = reopened.length

          const resp = yield* tinybird
            .query(tenant, {
              pipe: "error_issues",
              params: {
                start_time: toTinybirdDateTime(windowStartMs),
                end_time: toTinybirdDateTime(windowEndMs),
                limit: 500,
              },
            })
            .pipe(Effect.mapError(makePersistenceError))

          const rows = (resp.data as ReadonlyArray<Record<string, unknown>>).map(
            (raw) => ({
              fingerprintHash: String(raw.fingerprintHash ?? ""),
              serviceName: String(raw.serviceName ?? ""),
              exceptionType: String(raw.exceptionType ?? ""),
              exceptionMessage: String(raw.exceptionMessage ?? ""),
              topFrame: String(raw.topFrame ?? ""),
              count: Number(raw.count ?? 0),
              affectedServicesCount: Number(raw.affectedServicesCount ?? 0),
              firstSeen: String(raw.firstSeen ?? ""),
              lastSeen: String(raw.lastSeen ?? ""),
            }),
          )

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
              let wasResolved = false
              let wasNew = false

              if (prior) {
                issueId = prior.id
                wasResolved = prior.status === "resolved"
                if (
                  prior.status === "ignored" &&
                  (prior.ignoredUntil == null || prior.ignoredUntil > windowEndMs)
                ) {
                  return { touched: 0, opened: 0 }
                }

                const nextStatus = wasResolved ? "open" : prior.status
                yield* dbExecute((db) =>
                  db
                    .update(errorIssues)
                    .set({
                      status: nextStatus,
                      lastSeenAt: lastSeenMs,
                      occurrenceCount: sql`${errorIssues.occurrenceCount} + ${row.count}`,
                      ...(wasResolved ? { resolvedAt: null, resolvedBy: null } : {}),
                      updatedAt: windowEndMs,
                    })
                    .where(eq(errorIssues.id, prior.id)),
                )
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
                    status: "open",
                    assignedTo: null,
                    notes: null,
                    firstSeenAt: firstSeenMs,
                    lastSeenAt: lastSeenMs,
                    occurrenceCount: row.count,
                    resolvedAt: null,
                    resolvedBy: null,
                    ignoredUntil: null,
                    createdAt: windowEndMs,
                    updatedAt: windowEndMs,
                  }),
                )
              }

              const stateRow = yield* dbExecute((db) =>
                db
                  .select()
                  .from(errorIssueStates)
                  .where(
                    and(
                      eq(errorIssueStates.orgId, orgId),
                      eq(errorIssueStates.issueId, issueId),
                    ),
                  )
                  .limit(1),
              )
              const openIncidentIdRaw = stateRow[0]?.openIncidentId ?? null

              if (openIncidentIdRaw == null) {
                const reason: ErrorIncidentReason = wasNew
                  ? "first_seen"
                  : wasResolved
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

          // Auto-resolve stale incidents: open incidents whose last activity is
          // older than the silence window.
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
                      and(
                        eq(errorIssues.orgId, orgId),
                        eq(errorIssues.id, incident.issueId),
                      ),
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
            // Archive resolved issues that have sat resolved beyond the
            // retention window. They stay in the table (for history) but
            // fall out of the default list views.
            const resolvedCutoff = windowEndMs - RESOLVED_RETENTION_DAYS * DAY_MS
            const archivedRows = yield* dbExecute((db) =>
              db
                .update(errorIssues)
                .set({ status: "archived", updatedAt: windowEndMs })
                .where(
                  and(
                    eq(errorIssues.orgId, orgId),
                    eq(errorIssues.status, "resolved"),
                    isNotNull(errorIssues.resolvedAt),
                    lt(errorIssues.resolvedAt, resolvedCutoff),
                  ),
                )
                .returning({ id: errorIssues.id }),
            )
            issuesArchived = archivedRows.length

            // Purge archived issues older than the hard retention window,
            // along with their incidents and state rows.
            const archivedCutoff = windowEndMs - ARCHIVED_RETENTION_DAYS * DAY_MS
            const toDelete = yield* dbExecute((db) =>
              db
                .select({ id: errorIssues.id })
                .from(errorIssues)
                .where(
                  and(
                    eq(errorIssues.orgId, orgId),
                    eq(errorIssues.status, "archived"),
                    lt(errorIssues.updatedAt, archivedCutoff),
                  ),
                )
                .limit(500),
            )
            if (toDelete.length > 0) {
              const ids = toDelete.map((r) => r.id)
              yield* dbExecute((db) =>
                db
                  .delete(errorIncidents)
                  .where(
                    and(
                      eq(errorIncidents.orgId, orgId),
                      inArray(errorIncidents.issueId, ids),
                    ),
                  ),
              )
              yield* dbExecute((db) =>
                db
                  .delete(errorIssueStates)
                  .where(
                    and(
                      eq(errorIssueStates.orgId, orgId),
                      inArray(errorIssueStates.issueId, ids),
                    ),
                  ),
              )
              yield* dbExecute((db) =>
                db
                  .delete(errorIssues)
                  .where(
                    and(
                      eq(errorIssues.orgId, orgId),
                      inArray(errorIssues.id, ids),
                    ),
                  ),
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
          }
        },
      )

      const runTick: ErrorsServiceShape["runTick"] = Effect.fn(
        "ErrorsService.runTick",
      )(function* () {
          const endMs = now()
          // Default tick window = last 2 minutes. Re-processing of the same
          // fingerprint is idempotent (upsert semantics).
          const startMs = endMs - TICK_WINDOW_MS

          // Retention is expensive; only run it every N ticks (≈ hourly at
          // the default 2-minute cadence). Deterministic gate so multiple
          // workers don't stampede.
          const retentionRan =
            Math.floor(endMs / TICK_WINDOW_MS) % RETENTION_PHASE_EVERY_N_TICKS === 0

          // Discover orgs with activity in the window via state table + issues
          // table. First-time orgs come in via a lightweight distinct scan.
          const stateOrgs = yield* dbExecute((db) =>
            db
              .selectDistinct({ orgId: errorIssueStates.orgId })
              .from(errorIssueStates),
          )
          const issueOrgs = yield* dbExecute((db) =>
            db
              .selectDistinct({ orgId: errorIssues.orgId })
              .from(errorIssues)
              .where(isNotNull(errorIssues.orgId)),
          )
          const knownOrgs = new Set<string>([
            ...stateOrgs.map((r) => r.orgId),
            ...issueOrgs.map((r) => r.orgId),
          ])

          const emptyResult = {
            issuesTouched: 0,
            incidentsOpened: 0,
            incidentsResolved: 0,
            issuesReopened: 0,
            issuesArchived: 0,
            issuesDeleted: 0,
          }

          let orgFailures = 0
          const results = yield* Effect.forEach([...knownOrgs], (org) =>
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
          )

          const totals = results.reduce(
            (acc, r) => ({
              issuesTouched: acc.issuesTouched + r.issuesTouched,
              incidentsOpened: acc.incidentsOpened + r.incidentsOpened,
              incidentsResolved: acc.incidentsResolved + r.incidentsResolved,
              issuesReopened: acc.issuesReopened + r.issuesReopened,
              issuesArchived: acc.issuesArchived + r.issuesArchived,
              issuesDeleted: acc.issuesDeleted + r.issuesDeleted,
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
        },
      )

      return {
        listIssues,
        getIssue,
        updateIssue,
        listIssueIncidents,
        listOpenIncidents,
        getNotificationPolicy,
        upsertNotificationPolicy,
        runTick,
      } satisfies ErrorsServiceShape
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
