import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { IngestKeysResponse } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, permissionError, serviceUnavailable } from "@maple/domain/http/v2"
import type { V2IngestKeys } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { OrgIngestKeysService } from "../../services/OrgIngestKeysService"
import { requireAdmin } from "../../lib/auth"

const adminOnly = (action: string) => () =>
	permissionError("insufficient_permissions", `Only org admins can ${action} ingest keys`)

const toV2IngestKeys = (keys: IngestKeysResponse): V2IngestKeys => ({
	object: "ingest_keys",
	public_key: keys.publicKey,
	private_key: keys.privateKey,
	public_rotated_at: keys.publicRotatedAt,
	private_rotated_at: keys.privateRotatedAt,
})

/** Persistence/encryption failures → retryable v2 `service_unavailable`. */
const mapServiceError = (error: { readonly message: string }) => serviceUnavailable(error.message)

export const HttpV2IngestKeysLive = HttpApiBuilder.group(MapleApiV2, "ingestKeys", (handlers) =>
	Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("view"))
					const keys = yield* ingestKeys
						.getOrCreate(tenant.orgId, tenant.userId)
						.pipe(Effect.mapError(mapServiceError))
					return toV2IngestKeys(keys)
				}),
			)
			.handle("rollPublic", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("roll"))
					const keys = yield* ingestKeys
						.rerollPublic(tenant.orgId, tenant.userId)
						.pipe(Effect.mapError(mapServiceError))
					return toV2IngestKeys(keys)
				}),
			)
			.handle("rollPrivate", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("roll"))
					const keys = yield* ingestKeys
						.rerollPrivate(tenant.orgId, tenant.userId)
						.pipe(Effect.mapError(mapServiceError))
					return toV2IngestKeys(keys)
				}),
			)
	}),
)
