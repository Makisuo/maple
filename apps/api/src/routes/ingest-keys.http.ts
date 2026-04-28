import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrgIngestKeysService } from "../services/OrgIngestKeysService"

export const HttpIngestKeysLive = HttpApiBuilder.group(MapleApi, "ingestKeys", (handlers) =>
	Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService

		return handlers
			.handle("get", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* ingestKeys.getOrCreate(tenant.orgId, tenant.userId)
				}),
			)
			.handle("rerollPublic", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* ingestKeys.rerollPublic(tenant.orgId, tenant.userId)
				}),
			)
			.handle("rerollPrivate", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* ingestKeys.rerollPrivate(tenant.orgId, tenant.userId)
				}),
			)
	}),
)
