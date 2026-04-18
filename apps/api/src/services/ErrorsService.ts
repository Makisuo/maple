import { randomUUID } from "node:crypto"
import {
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
  ErrorPersistenceError,
  ErrorValidationError,
  type OrgId,
  RoleName,
  UserId as UserIdSchema,
} from "@maple/domain/http"
import {
  errorIncidents,
  type ErrorIncidentRow,
  errorIssues,
  type ErrorIssueRow,
  errorIssueStates,
} from "@maple/db"
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { Database, type DatabaseClient } from "./DatabaseLive"
import { TinybirdService } from "./TinybirdService"

const decodeErrorIssueIdSync = Schema.decodeUnknownSync(ErrorIssueDocument.fields.id)
const decodeErrorIncidentIdSync = Schema.decodeUnknownSync(ErrorIncidentDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(
  ErrorIssueDocument.fields.firstSeenAt,
)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

const DEFAULT_LIST_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000
const AUTO_RESOLVE_MINUTES = 30

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
    userId: string,
    issueId: ErrorIssueId,
    patch: {
      readonly status?: ErrorIssueStatus
      readonly assignedTo?: string | null
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
  readonly runTick: () => Effect.Effect<
    { readonly orgsProcessed: number; readonly issuesTouched: number; readonly incidentsOpened: number; readonly incidentsResolved: number },
    ErrorPersistenceError
  >
}

export class ErrorsService extends Context.Service<ErrorsService, ErrorsServiceShape>()(
  "ErrorsService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const tinybird = yield* TinybirdService

      const now = () => Date.now()
      const makeUuid = () => randomUUID()

      const makePersistenceError = (error: unknown) =>
        new ErrorPersistenceError({
          message: error instanceof Error ? error.message : "Error persistence failure",
        })

      const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
        database.execute(fn).pipe(Effect.mapError(makePersistenceError))

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
          id: decodeErrorIssueIdSync(row.id),
          fingerprintHash: row.fingerprintHash,
          serviceName: row.serviceName,
          exceptionType: row.exceptionType,
          exceptionMessage: row.exceptionMessage,
          topFrame: row.topFrame,
          status: row.status as ErrorIssueStatus,
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
          id: decodeErrorIncidentIdSync(row.id),
          issueId: decodeErrorIssueIdSync(row.issueId),
          status: row.status as "open" | "resolved",
          reason: row.reason as ErrorIncidentReason,
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

      const issuesWithOpenIncidents = (orgId: OrgId, issueIds: ReadonlyArray<string>) =>
        issueIds.length === 0
          ? Effect.succeed(new Set<string>())
          : dbExecute((db) =>
              db
                .select({ issueId: errorIncidents.issueId })
                .from(errorIncidents)
                .where(
                  and(
                    eq(errorIncidents.orgId, orgId),
                    eq(errorIncidents.status, "open"),
                    inArray(errorIncidents.issueId, issueIds as string[]),
                  ),
                ),
            ).pipe(Effect.map((rows) => new Set(rows.map((r) => r.issueId))))

      const listIssues: ErrorsServiceShape["listIssues"] = (orgId, opts) =>
        Effect.gen(function* () {
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

          return new ErrorIssuesListResponse({
            issues: rows.map((r) => rowToIssue(r, openSet.has(r.id))),
          })
        })

      const getIssue: ErrorsServiceShape["getIssue"] = (orgId, issueId, opts) =>
        Effect.gen(function* () {
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
                traceId: String(row.traceId ?? ""),
                spanId: String(row.spanId ?? ""),
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

      const normalizeOptionalText = (value: string | null | undefined) => {
        if (value === undefined) return undefined
        if (value === null) return null
        const trimmed = value.trim()
        return trimmed.length === 0 ? null : trimmed
      }

      const updateIssue: ErrorsServiceShape["updateIssue"] = (
        orgId,
        userId,
        issueId,
        patch,
      ) =>
        Effect.gen(function* () {
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

      const listIssueIncidents: ErrorsServiceShape["listIssueIncidents"] = (
        orgId,
        issueId,
      ) =>
        Effect.gen(function* () {
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
          return new ErrorIncidentsListResponse({
            incidents: rows.map(rowToIncident),
          })
        })

      const listOpenIncidents: ErrorsServiceShape["listOpenIncidents"] = (orgId) =>
        Effect.gen(function* () {
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
          return new ErrorIncidentsListResponse({
            incidents: rows.map(rowToIncident),
          })
        })

      // -----------------------------------------------------------------
      // Scheduled tick: scan error_events for new fingerprints, upsert
      // issues, open/resolve incidents, auto-resolve silent ones.
      // -----------------------------------------------------------------

      const processOrg = (orgId: OrgId, windowStartMs: number, windowEndMs: number) =>
        Effect.gen(function* () {
          const tenant = systemTenant(orgId)
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

          const rows = resp.data as ReadonlyArray<{
            fingerprintHash: string
            serviceName: string
            exceptionType: string
            exceptionMessage: string
            topFrame: string
            count: number
            affectedServicesCount: number
            firstSeen: string
            lastSeen: string
          }>

          let issuesTouched = 0
          let incidentsOpened = 0

          for (const row of rows) {
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

            let issueId: string
            let wasResolved = false
            let wasNew = false

            if (existing[0]) {
              const prior = existing[0]
              issueId = prior.id
              wasResolved = prior.status === "resolved"
              if (prior.status === "ignored" && (prior.ignoredUntil == null || prior.ignoredUntil > windowEndMs)) {
                continue
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
              issueId = makeUuid()
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

            issuesTouched += 1

            // Incident lifecycle
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
            const hasOpenIncident = stateRow[0]?.openIncidentId != null

            if (!hasOpenIncident) {
              const reason: ErrorIncidentReason = wasNew
                ? "first_seen"
                : wasResolved
                  ? "regression"
                  : "first_seen"
              const incidentId = makeUuid()
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
              incidentsOpened += 1

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
            } else {
              // Update existing open incident with latest activity
              yield* dbExecute((db) =>
                db
                  .update(errorIncidents)
                  .set({
                    lastTriggeredAt: lastSeenMs,
                    occurrenceCount: sql`${errorIncidents.occurrenceCount} + ${row.count}`,
                    updatedAt: windowEndMs,
                  })
                  .where(eq(errorIncidents.id, stateRow[0]!.openIncidentId!)),
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
            }
          }

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
          let incidentsResolved = 0
          for (const incident of staleIncidents) {
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
            incidentsResolved += 1
          }

          return { issuesTouched, incidentsOpened, incidentsResolved }
        })

      const runTick: ErrorsServiceShape["runTick"] = () =>
        Effect.gen(function* () {
          const endMs = now()
          // Default tick window = last 2 minutes. Re-processing of the same
          // fingerprint is idempotent (upsert semantics).
          const startMs = endMs - 2 * 60_000

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

          let issuesTouched = 0
          let incidentsOpened = 0
          let incidentsResolved = 0

          for (const org of knownOrgs) {
            const result = yield* processOrg(org as OrgId, startMs, endMs).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logError("Error tick failed for org").pipe(
                    Effect.annotateLogs({
                      orgId: org,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  )
                  return { issuesTouched: 0, incidentsOpened: 0, incidentsResolved: 0 }
                }),
              ),
            )
            issuesTouched += result.issuesTouched
            incidentsOpened += result.incidentsOpened
            incidentsResolved += result.incidentsResolved
          }

          return {
            orgsProcessed: knownOrgs.size,
            issuesTouched,
            incidentsOpened,
            incidentsResolved,
          }
        })

      return {
        listIssues,
        getIssue,
        updateIssue,
        listIssueIncidents,
        listOpenIncidents,
        runTick,
      } satisfies ErrorsServiceShape
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
