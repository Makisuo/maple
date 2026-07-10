import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi, RailwayForbiddenError } from "@maple/domain/http"
import { Effect } from "effect"
import type { RoleName } from "@maple/domain/http"
import { requireAdmin as requireAdminRole } from "../lib/auth"
import { RailwayIntegrationService } from "../services/RailwayIntegrationService"

const requireAdmin = (roles: ReadonlyArray<RoleName>) =>
	requireAdminRole(
		roles,
		() =>
			new RailwayForbiddenError({
				message: "Only organization admins can manage the Railway integration",
			}),
	)

export const HttpRailwayLive = HttpApiBuilder.group(MapleApi, "railway", (handlers) =>
	Effect.gen(function* () {
		const service = yield* RailwayIntegrationService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.status(tenant.orgId)
				}),
			)
			.handle("connect", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles)
					return yield* service.connect(tenant.orgId, tenant.userId, payload.token)
				}),
			)
			.handle("disconnect", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles)
					return yield* service.disconnect(tenant.orgId)
				}),
			)
			.handle("discovery", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.discover(tenant.orgId)
				}),
			)
			.handle("listTargets", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.listTargets(tenant.orgId)
				}),
			)
			.handle("createTarget", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles)
					return yield* service.createTarget(tenant.orgId, payload)
				}),
			)
			.handle("updateTarget", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles)
					return yield* service.updateTarget(tenant.orgId, params.targetId, payload)
				}),
			)
			.handle("deleteTarget", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles)
					return yield* service.deleteTarget(tenant.orgId, params.targetId)
				}),
			)
	}),
)
