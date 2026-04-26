import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  CurrentTenant,
  DashboardValidationError,
  MapleApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { DashboardPersistenceService } from "../services/DashboardPersistenceService"

export const HttpDashboardsLive = HttpApiBuilder.group(
  MapleApi,
  "dashboards",
  (handlers) =>
    Effect.gen(function* () {
      const persistence = yield* DashboardPersistenceService

      return handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.create(
              tenant.orgId,
              tenant.userId,
              payload.dashboard,
            )
          }),
        )
        .handle("list", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.list(tenant.orgId)
          }),
        )
        .handle("upsert", ({ params, payload }) =>
          Effect.gen(function* () {
            if (params.dashboardId !== payload.dashboard.id) {
              return yield* Effect.fail(
                new DashboardValidationError({
                  message: "Dashboard ID mismatch",
                  details: [
                    "Path dashboardId must match payload.dashboard.id",
                  ],
                }),
              )
            }

            const tenant = yield* CurrentTenant.Context
            return yield* persistence.upsert(
              tenant.orgId,
              tenant.userId,
              payload.dashboard,
            )
          }),
        )
        .handle("delete", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.delete(tenant.orgId, params.dashboardId)
          }),
        )
        .handle("listVersions", ({ params, query }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.listVersions(
              tenant.orgId,
              params.dashboardId,
              { limit: query.limit, before: query.before },
            )
          }),
        )
        .handle("getVersion", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.getVersion(
              tenant.orgId,
              params.dashboardId,
              params.versionId,
            )
          }),
        )
        .handle("restoreVersion", ({ params }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* persistence.restoreVersion(
              tenant.orgId,
              tenant.userId,
              params.dashboardId,
              params.versionId,
            )
          }),
        )
    }),
)
