import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"

export const HttpOrgClickHouseSettingsLive = HttpApiBuilder.group(
	MapleApi,
	"orgClickHouseSettings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* OrgClickHouseSettingsService

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
				.handle("schemaDiff", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.schemaDiff(tenant.orgId, tenant.roles)
					}),
				)
				.handle("applySchema", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.applySchema(tenant.orgId, tenant.userId, tenant.roles)
					}),
				)
				.handle("collectorConfig", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.collectorConfig(tenant.orgId, tenant.roles)
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
