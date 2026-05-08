import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, IngestKeyForbiddenError, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OrgIngestKeysService } from "../services/OrgIngestKeysService"
import { requireAdmin } from "../lib/auth"

const forbidden = (message: string) => () => new IngestKeyForbiddenError({ message })

export const HttpIngestKeysLive = HttpApiBuilder.group(MapleApi, "ingestKeys", (handlers) =>
	Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService

		return handlers
			.handle("get", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can view ingest keys"),
					)
					return yield* ingestKeys.getOrCreate(tenant.orgId, tenant.userId)
				}),
			)
			.handle("rerollPublic", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can rotate the public ingest key"),
					)
					return yield* ingestKeys.rerollPublic(tenant.orgId, tenant.userId)
				}),
			)
			.handle("rerollPrivate", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can rotate the private ingest key"),
					)
					return yield* ingestKeys.rerollPrivate(tenant.orgId, tenant.userId)
				}),
			)
	}),
)
