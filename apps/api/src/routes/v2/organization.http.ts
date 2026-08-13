import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { isoTimestampOrNull, MapleApiV2 } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { OrganizationService } from "@/services/org/OrganizationService"

export const HttpV2OrganizationLive = HttpApiBuilder.group(MapleApiV2, "organization", (handlers) =>
	Effect.gen(function* () {
		const service = yield* OrganizationService

		return handlers.handle("retrieve", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const org = yield* service.retrieve(tenant.orgId)
				return {
					id: org.id,
					object: "organization" as const,
					name: org.name,
					slug: org.slug,
					created_at: isoTimestampOrNull(org.createdAtMs),
				}
			}),
		)
	}),
)
