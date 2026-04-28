import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { CloudflareLogpushService } from "../services/CloudflareLogpushService"

export const HttpCloudflareLogpushLive = HttpApiBuilder.group(MapleApi, "cloudflareLogpush", (handlers) =>
	Effect.gen(function* () {
		const service = yield* CloudflareLogpushService

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.list(tenant.orgId)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.create(tenant.orgId, tenant.userId, payload)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.update(tenant.orgId, params.connectorId, tenant.userId, payload)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.delete(tenant.orgId, params.connectorId)
				}),
			)
			.handle("getSetup", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.getSetup(tenant.orgId, params.connectorId)
				}),
			)
			.handle("rotateSecret", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.rotateSecret(tenant.orgId, params.connectorId, tenant.userId)
				}),
			)
	}),
)
