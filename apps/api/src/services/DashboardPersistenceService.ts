import {
  DashboardDeleteResponse,
  DashboardId,
  DashboardNotFoundError,
  DashboardPersistenceError,
  DashboardValidationError,
  DashboardDocument,
  DashboardsListResponse,
  DashboardVersionDetail,
  DashboardVersionId,
  DashboardVersionNotFoundError,
  DashboardVersionsListResponse,
  DashboardVersionSummary,
  IsoDateTimeString,
  OrgId,
  PortableDashboardDocument,
  UserId,
} from "@maple/domain/http"
import {
  dashboards,
  dashboardVersions,
  type DashboardVersionRow,
} from "@maple/db"
import { and, desc, eq, lt } from "drizzle-orm"
import { Effect, Layer, Option, Schema, Context } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "./DatabaseLive"
import { summarizeDashboardChange } from "./dashboard-changes"

const decodeDashboardIdSync = Schema.decodeUnknownSync(DashboardId)
const decodeDashboardVersionIdSync = Schema.decodeUnknownSync(DashboardVersionId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

const COALESCE_WINDOW_MS = 5_000

const toPersistenceError = (error: unknown) =>
  new DashboardPersistenceError({
    message:
      error instanceof Error ? error.message : "Dashboard persistence failed",
  })

const parseTimestamp = (field: "createdAt" | "updatedAt", value: string) => {
  const timestamp = Date.parse(value)

  if (!Number.isFinite(timestamp)) {
    return Effect.fail(
      new DashboardValidationError({
        message: `Invalid ${field} timestamp`,
        details: [`${field} must be an ISO date-time string`],
      }),
    )
  }

  return Effect.succeed(timestamp)
}

const parsePayload = (payloadJson: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(DashboardDocument))(payloadJson).pipe(
    Effect.mapError(() =>
      new DashboardPersistenceError({
        message: "Stored dashboard payload is invalid JSON",
      }),
    ),
  )

const stringifyPayload = (dashboard: DashboardDocument) =>
  Effect.try({
    try: () => JSON.stringify(dashboard),
    catch: () =>
      new DashboardValidationError({
        message: "Dashboard payload must be JSON serializable",
        details: ["Dashboard contains non-serializable values"],
      }),
  })

const createDashboardDocument = (portableDashboard: PortableDashboardDocument) => {
  const now = new Date().toISOString()

  return new DashboardDocument({
    id: decodeDashboardIdSync(randomUUID()),
    name: portableDashboard.name,
    description: portableDashboard.description,
    tags: portableDashboard.tags,
    timeRange: portableDashboard.timeRange,
    widgets: portableDashboard.widgets,
    createdAt: decodeIsoDateTimeStringSync(now),
    updatedAt: decodeIsoDateTimeStringSync(now),
  })
}

const versionRowToSummary = (row: DashboardVersionRow): DashboardVersionSummary =>
  new DashboardVersionSummary({
    id: decodeDashboardVersionIdSync(row.id),
    dashboardId: decodeDashboardIdSync(row.dashboardId),
    versionNumber: row.versionNumber,
    changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
    changeSummary: row.changeSummary ?? null,
    sourceVersionId: row.sourceVersionId
      ? decodeDashboardVersionIdSync(row.sourceVersionId)
      : null,
    createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
    createdBy: decodeUserIdSync(row.createdBy),
  })

export class DashboardPersistenceService extends Context.Service<DashboardPersistenceService>()(
  "DashboardPersistenceService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database

      const loadCurrent = (orgId: OrgId, dashboardId: DashboardId) =>
        Effect.gen(function* () {
          const rows: ReadonlyArray<{ readonly payloadJson: string }> = yield* database
            .execute((db) =>
              db
                .select({ payloadJson: dashboards.payloadJson })
                .from(dashboards)
                .where(and(eq(dashboards.orgId, orgId), eq(dashboards.id, dashboardId))),
            )
            .pipe(Effect.mapError(toPersistenceError))

          const row = rows[0]
          if (!row) return null
          return yield* parsePayload(row.payloadJson)
        })

      const recordVersion = (
        orgId: OrgId,
        userId: UserId,
        dashboard: DashboardDocument,
        previous: DashboardDocument | null,
        options: {
          readonly forceKind?: DashboardVersionSummary["changeKind"]
          readonly forceSummary?: string
          readonly sourceVersionId?: DashboardVersionId | null
        } = {},
      ) =>
        Effect.gen(function* () {
          const summary = summarizeDashboardChange(previous, dashboard)
          const kind = options.forceKind ?? summary.kind
          const summaryText = options.forceSummary ?? summary.summary
          const snapshotJson = yield* stringifyPayload(dashboard)
          const now = Date.now()

          const latest: ReadonlyArray<DashboardVersionRow> = yield* database
            .execute((db) =>
              db
                .select()
                .from(dashboardVersions)
                .where(
                  and(
                    eq(dashboardVersions.orgId, orgId),
                    eq(dashboardVersions.dashboardId, dashboard.id),
                  ),
                )
                .orderBy(desc(dashboardVersions.versionNumber))
                .limit(1),
            )
            .pipe(Effect.mapError(toPersistenceError))

          const latestRow = latest[0]
          const canCoalesce =
            !options.sourceVersionId &&
            !options.forceKind &&
            latestRow !== undefined &&
            latestRow.createdBy === userId &&
            latestRow.changeKind === kind &&
            now - latestRow.createdAt < COALESCE_WINDOW_MS

          if (canCoalesce && latestRow) {
            yield* database
              .execute((db) =>
                db
                  .update(dashboardVersions)
                  .set({
                    snapshotJson,
                    changeSummary: summaryText,
                    createdAt: now,
                  })
                  .where(
                    and(
                      eq(dashboardVersions.orgId, orgId),
                      eq(dashboardVersions.id, latestRow.id),
                    ),
                  ),
              )
              .pipe(Effect.mapError(toPersistenceError))
            return
          }

          const versionNumber = (latestRow?.versionNumber ?? 0) + 1

          yield* database
            .execute((db) =>
              db.insert(dashboardVersions).values({
                orgId,
                id: randomUUID(),
                dashboardId: dashboard.id,
                versionNumber,
                snapshotJson,
                changeKind: kind,
                changeSummary: summaryText,
                sourceVersionId: options.sourceVersionId ?? null,
                createdAt: now,
                createdBy: userId,
              }),
            )
            .pipe(Effect.mapError(toPersistenceError))
        })

      const list = Effect.fn("DashboardPersistenceService.list")(function* (
        orgId: OrgId,
      ) {
        const rows: ReadonlyArray<{ readonly payloadJson: string }> = yield* database.execute((db) =>
          db
            .select({
              payloadJson: dashboards.payloadJson,
            })
            .from(dashboards)
            .where(eq(dashboards.orgId, orgId))
            .orderBy(desc(dashboards.updatedAt)),
        ).pipe(Effect.mapError(toPersistenceError))

        const dashboardDocuments = yield* Effect.forEach(rows, (row) =>
          parsePayload(row.payloadJson),
        )

        return new DashboardsListResponse({ dashboards: dashboardDocuments })
      })

      const upsertInternal = (
        orgId: OrgId,
        userId: UserId,
        dashboard: DashboardDocument,
        versionOptions: {
          readonly forceKind?: DashboardVersionSummary["changeKind"]
          readonly forceSummary?: string
          readonly sourceVersionId?: DashboardVersionId | null
        } = {},
      ) =>
        Effect.gen(function* () {
          const previous = yield* loadCurrent(orgId, dashboard.id)
          const payloadJson = yield* stringifyPayload(dashboard)
          const createdAt = yield* parseTimestamp("createdAt", dashboard.createdAt)
          const updatedAt = yield* parseTimestamp("updatedAt", dashboard.updatedAt)

          yield* database
            .execute((db) =>
              db
                .insert(dashboards)
                .values({
                  orgId,
                  id: dashboard.id,
                  name: dashboard.name,
                  payloadJson,
                  createdAt,
                  updatedAt,
                  createdBy: userId,
                  updatedBy: userId,
                })
                .onConflictDoUpdate({
                  target: [dashboards.orgId, dashboards.id],
                  set: {
                    name: dashboard.name,
                    payloadJson,
                    updatedAt,
                    updatedBy: userId,
                  },
                }),
            )
            .pipe(Effect.mapError(toPersistenceError))

          // History recording is best-effort: a failure here must not roll
          // back the dashboard write. The dashboard table is the source of
          // truth; versions are an append-only audit trail.
          yield* recordVersion(orgId, userId, dashboard, previous, versionOptions).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "[DashboardPersistenceService] Failed to record dashboard version",
              ).pipe(Effect.annotateLogs({ error: String(error) })),
            ),
            Effect.ignore,
          )

          return dashboard
        })

      const upsert = Effect.fn("DashboardPersistenceService.upsert")(function* (
        orgId: OrgId,
        userId: UserId,
        dashboard: DashboardDocument,
      ) {
        return yield* upsertInternal(orgId, userId, dashboard)
      })

      const create = Effect.fn("DashboardPersistenceService.create")(function* (
        orgId: OrgId,
        userId: UserId,
        dashboard: PortableDashboardDocument,
      ) {
        const createdDashboard = createDashboardDocument(dashboard)
        return yield* upsertInternal(orgId, userId, createdDashboard)
      })

      const remove = Effect.fn("DashboardPersistenceService.delete")(function* (
        orgId: OrgId,
        dashboardId: DashboardId,
      ) {
        const rows = yield* database.execute((db) =>
          db
            .delete(dashboards)
            .where(
              and(
                eq(dashboards.orgId, orgId),
                eq(dashboards.id, dashboardId),
              ),
            )
            .returning({ id: dashboards.id }),
        ).pipe(Effect.mapError(toPersistenceError))

        const deleted = Option.fromNullishOr(rows[0])

        if (Option.isNone(deleted)) {
          return yield* Effect.fail(
            new DashboardNotFoundError({
              dashboardId,
              message: "Dashboard not found",
            }),
          )
        }

        // Drop history rows when the dashboard is deleted — they're tied to
        // a dashboard that no longer exists.
        yield* database
          .execute((db) =>
            db
              .delete(dashboardVersions)
              .where(
                and(
                  eq(dashboardVersions.orgId, orgId),
                  eq(dashboardVersions.dashboardId, dashboardId),
                ),
              ),
          )
          .pipe(Effect.mapError(toPersistenceError))

        return new DashboardDeleteResponse({
          id: decodeDashboardIdSync(deleted.value.id),
        })
      })

      const ensureDashboardExists = (orgId: OrgId, dashboardId: DashboardId) =>
        Effect.gen(function* () {
          const current = yield* loadCurrent(orgId, dashboardId)
          if (current === null) {
            return yield* Effect.fail(
              new DashboardNotFoundError({
                dashboardId,
                message: "Dashboard not found",
              }),
            )
          }
          return current
        })

      const listVersions = Effect.fn("DashboardPersistenceService.listVersions")(
        function* (
          orgId: OrgId,
          dashboardId: DashboardId,
          options: {
            readonly limit?: number
            readonly before?: number
          } = {},
        ) {
          yield* ensureDashboardExists(orgId, dashboardId)

          const limit = Math.min(options.limit ?? 50, 200)
          const conditions = [
            eq(dashboardVersions.orgId, orgId),
            eq(dashboardVersions.dashboardId, dashboardId),
          ]
          if (options.before !== undefined) {
            conditions.push(lt(dashboardVersions.versionNumber, options.before))
          }

          const rows: ReadonlyArray<DashboardVersionRow> = yield* database
            .execute((db) =>
              db
                .select()
                .from(dashboardVersions)
                .where(and(...conditions))
                .orderBy(desc(dashboardVersions.versionNumber))
                .limit(limit + 1),
            )
            .pipe(Effect.mapError(toPersistenceError))

          const hasMore = rows.length > limit
          const sliced = hasMore ? rows.slice(0, limit) : rows

          return new DashboardVersionsListResponse({
            versions: sliced.map(versionRowToSummary),
            hasMore,
          })
        },
      )

      const getVersion = Effect.fn("DashboardPersistenceService.getVersion")(
        function* (
          orgId: OrgId,
          dashboardId: DashboardId,
          versionId: DashboardVersionId,
        ) {
          yield* ensureDashboardExists(orgId, dashboardId)

          const rows: ReadonlyArray<DashboardVersionRow> = yield* database
            .execute((db) =>
              db
                .select()
                .from(dashboardVersions)
                .where(
                  and(
                    eq(dashboardVersions.orgId, orgId),
                    eq(dashboardVersions.id, versionId),
                  ),
                )
                .limit(1),
            )
            .pipe(Effect.mapError(toPersistenceError))

          const row = rows[0]
          if (!row || row.dashboardId !== dashboardId) {
            return yield* Effect.fail(
              new DashboardVersionNotFoundError({
                dashboardId,
                versionId,
                message: "Dashboard version not found",
              }),
            )
          }

          const snapshot = yield* parsePayload(row.snapshotJson)

          return new DashboardVersionDetail({
            id: decodeDashboardVersionIdSync(row.id),
            dashboardId: decodeDashboardIdSync(row.dashboardId),
            versionNumber: row.versionNumber,
            changeKind: row.changeKind as DashboardVersionSummary["changeKind"],
            changeSummary: row.changeSummary ?? null,
            sourceVersionId: row.sourceVersionId
              ? decodeDashboardVersionIdSync(row.sourceVersionId)
              : null,
            createdAt: decodeIsoDateTimeStringSync(
              new Date(row.createdAt).toISOString(),
            ),
            createdBy: decodeUserIdSync(row.createdBy),
            snapshot,
          })
        },
      )

      const restoreVersion = Effect.fn(
        "DashboardPersistenceService.restoreVersion",
      )(function* (
        orgId: OrgId,
        userId: UserId,
        dashboardId: DashboardId,
        versionId: DashboardVersionId,
      ) {
        const detail = yield* getVersion(orgId, dashboardId, versionId)

        const restored = new DashboardDocument({
          ...detail.snapshot,
          updatedAt: decodeIsoDateTimeStringSync(new Date().toISOString()),
        })

        return yield* upsertInternal(orgId, userId, restored, {
          forceKind: "restored",
          forceSummary: `Restored from v${detail.versionNumber}`,
          sourceVersionId: detail.id,
        })
      })

      return {
        create,
        list,
        upsert,
        delete: remove,
        listVersions,
        getVersion,
        restoreVersion,
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer

  static readonly list = (orgId: OrgId) =>
    this.use((service) => service.list(orgId))

  static readonly create = (
    orgId: OrgId,
    userId: UserId,
    dashboard: PortableDashboardDocument,
  ) => this.use((service) => service.create(orgId, userId, dashboard))

  static readonly upsert = (
    orgId: OrgId,
    userId: UserId,
    dashboard: DashboardDocument,
  ) => this.use((service) => service.upsert(orgId, userId, dashboard))

  static readonly delete = (
    orgId: OrgId,
    dashboardId: DashboardId,
  ) => this.use((service) => service.delete(orgId, dashboardId))

  static readonly listVersions = (
    orgId: OrgId,
    dashboardId: DashboardId,
    options?: { readonly limit?: number; readonly before?: number },
  ) => this.use((service) => service.listVersions(orgId, dashboardId, options))

  static readonly getVersion = (
    orgId: OrgId,
    dashboardId: DashboardId,
    versionId: DashboardVersionId,
  ) => this.use((service) => service.getVersion(orgId, dashboardId, versionId))

  static readonly restoreVersion = (
    orgId: OrgId,
    userId: UserId,
    dashboardId: DashboardId,
    versionId: DashboardVersionId,
  ) =>
    this.use((service) =>
      service.restoreVersion(orgId, userId, dashboardId, versionId),
    )
}
