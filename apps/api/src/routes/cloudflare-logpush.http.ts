import { HttpApiBuilder } from "@effect/platform";
import { CurrentTenant, MapleApi } from "@maple/domain/http";
import { Effect } from "effect";
import { CloudflareLogpushService } from "../services/CloudflareLogpushService";

export const HttpCloudflareLogpushLive = HttpApiBuilder.group(
  MapleApi,
  "cloudflareLogpush",
  (handlers) =>
    Effect.gen(function* () {
      const service = yield* CloudflareLogpushService;

      return handlers
        .handle("list", () =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            const connectors = yield* service.list(tenant.orgId);
            return { connectors };
          }),
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            return yield* service.create(tenant.orgId, tenant.userId, payload);
          }),
        )
        .handle("update", ({ path, payload }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            return yield* service.update(
              tenant.orgId,
              path.connectorId,
              tenant.userId,
              payload,
            );
          }),
        )
        .handle("delete", ({ path }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            return yield* service.delete(tenant.orgId, path.connectorId);
          }),
        )
        .handle("getSetup", ({ path }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            return yield* service.getSetup(tenant.orgId, path.connectorId);
          }),
        )
        .handle("rotateSecret", ({ path }) =>
          Effect.gen(function* () {
            const tenant = yield* CurrentTenant.Context;
            return yield* service.rotateSecret(
              tenant.orgId,
              path.connectorId,
              tenant.userId,
            );
          }),
        );
    }),
);
