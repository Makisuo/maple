import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

// Generic `{pipe, params}` → `{data}` warehouse query endpoint. This is the
// remote counterpart to the local binary's `/local/query`: the unified `maple`
// CLI's remote executor POSTs the pipe name + params here, and the server
// compiles + executes with the authenticated tenant's org id.
//
// All the work — `compilePipeQuery({...params, org_id: tenant.orgId})`,
// `executeSql`, error mapping, and casting into `WarehouseQueryResponse` — lives
// in `WarehouseQueryService.query`. The org id is injected from the tenant (it
// overwrites any client-supplied `org_id`), so the client never controls scope.
export const HttpWarehouseLive = HttpApiBuilder.group(MapleApi, "warehouse", (handlers) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService

		return handlers.handle("query", ({ payload }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				return yield* warehouse.query(tenant, payload, {
					profile: "list",
					context: "warehouseApi",
				})
			}),
		)
	}),
)
