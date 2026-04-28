import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrgOpenRouterSettingsService } from "../services/OrgOpenRouterSettingsService"

export const HttpOrgOpenRouterSettingsLive = HttpApiBuilder.group(
	MapleApi,
	"orgOpenrouterSettings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* OrgOpenRouterSettingsService

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
				.handle("delete", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.delete(tenant.orgId, tenant.roles)
					}),
				)
		}),
)
