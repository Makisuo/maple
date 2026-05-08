import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrganizationService } from "../services/OrganizationService"

export const HttpOrganizationsLive = HttpApiBuilder.group(MapleApi, "organizations", (handlers) =>
	Effect.gen(function* () {
		const organizationService = yield* OrganizationService

		return handlers.handle("delete", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				return yield* organizationService.delete(tenant.orgId, tenant.roles)
			}),
		)
	}),
)
