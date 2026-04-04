import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { DigestService } from "../services/DigestService"

export const HttpDigestLive = HttpApiBuilder.group(
  MapleApi,
  "digest",
  (handlers) =>
    Effect.gen(function* () {
      const digest = yield* DigestService

      return handlers
        .handle("getSubscription", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* digest.getSubscription(tenant.orgId, tenant.userId)
          }),
        )
        .handle("upsertSubscription", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* digest.upsertSubscription(
              tenant.orgId,
              tenant.userId,
              {
                email: payload.email,
                enabled: payload.enabled,
                dayOfWeek: payload.dayOfWeek,
                timezone: payload.timezone,
              },
            )
          }),
        )
        .handle("deleteSubscription", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            yield* digest.deleteSubscription(tenant.orgId, tenant.userId)
          }),
        )
        .handle("preview", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context
            return yield* digest.preview(tenant.orgId)
          }),
        )
    }),
)
