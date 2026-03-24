import {
  DashboardDeleteResponse,
  DashboardId,
  DashboardNotFoundError,
  DashboardPersistenceError,
  DashboardValidationError,
  DashboardDocument,
  DashboardsListResponse,
  IsoDateTimeString,
  OrgId,
  PortableDashboardDocument,
  UserId,
} from "@maple/domain/http"
import { dashboards } from "@maple/db"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "./DatabaseLive"

const decodeDashboardIdSync = Schema.decodeUnknownSync(DashboardId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

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

export class DashboardPersistenceService extends ServiceMap.Service<DashboardPersistenceService>()(
  "DashboardPersistenceService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database

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

      const upsert = Effect.fn("DashboardPersistenceService.upsert")(function* (
        orgId: OrgId,
        userId: UserId,
        dashboard: DashboardDocument,
      ) {
        const payloadJson = yield* stringifyPayload(dashboard)
        const createdAt = yield* parseTimestamp("createdAt", dashboard.createdAt)
        const updatedAt = yield* parseTimestamp("updatedAt", dashboard.updatedAt)

        yield* database.execute((db) =>
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
        ).pipe(Effect.mapError(toPersistenceError))

        return dashboard
      })

      const create = Effect.fn("DashboardPersistenceService.create")(function* (
        orgId: OrgId,
        userId: UserId,
        dashboard: PortableDashboardDocument,
      ) {
        const createdDashboard = createDashboardDocument(dashboard)
        return yield* upsert(orgId, userId, createdDashboard)
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

        return new DashboardDeleteResponse({
          id: decodeDashboardIdSync(deleted.value.id),
        })
      })

      return {
        create,
        list,
        upsert,
        delete: remove,
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
}
