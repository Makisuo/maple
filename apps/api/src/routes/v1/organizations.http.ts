import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { OrganizationService } from "@/services/org/OrganizationService"

export const HttpOrganizationsLive = HttpApiBuilder.group(MapleApi, "organizations", (handlers) =>
	Effect.gen(function* () {
		const organizationService = yield* OrganizationService

		return handlers.handle("delete", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const deleted = yield* organizationService.delete(tenant.orgId, tenant.roles)
				// Recorded after the fact so a refused delete cannot leave an entry
				// claiming the org is gone. The row outlives the org: nothing
				// cascades `audit_log_entries`, which is the point of a trail.
				yield* recordHttpAudit("organization.deleted")
				return deleted
			}),
		)
	}),
)
