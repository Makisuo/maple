import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, ListAiSessionsResponse, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page (behind the `agent_tracing` org rollout flag).
 * The flag hides the surface, not the data — scoping is `CurrentTenant`, like
 * every other warehouse read.
 */
export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService

			return handlers.handle("list", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					const compiled = CH.compile(
						Integrations.aiSessionListQuery({
							limit: payload.limit,
							vendorIds: payload.vendorIds,
							serviceNames: payload.serviceNames,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
						{ rowSchema: Integrations.aiSessionListRowSchema },
					)
					// The row schema already coerces the UInt64 aggregates and decodes
					// exactly the response's fields, so rows pass through unmapped
					// (unlike listReplays, which re-brands and re-coerces per field).
					const rows = yield* warehouse.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "listAiSessions",
					})
					return new ListAiSessionsResponse({ data: rows })
				}),
			)
		}),
)
