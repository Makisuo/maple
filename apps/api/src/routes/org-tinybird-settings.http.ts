import { HttpApiBuilder } from "@effect/platform"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrgTinybirdSettingsService } from "../services/OrgTinybirdSettingsService"

export const HttpOrgTinybirdSettingsLive = HttpApiBuilder.group(
  MapleApi,
  "orgTinybirdSettings",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* OrgTinybirdSettingsService

      return handlers
        .handle("get", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* service.get(tenant.orgId, tenant.roles)
          }),
        )
        .handle("upsert", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* service.upsert(tenant.orgId, tenant.userId, tenant.roles, payload)
          }),
        )
        .handle("resync", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* service.resync(tenant.orgId, tenant.userId, tenant.roles)
          }),
        )
        .handle("delete", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* service.delete(tenant.orgId, tenant.roles)
          }),
        )
    }),
)
