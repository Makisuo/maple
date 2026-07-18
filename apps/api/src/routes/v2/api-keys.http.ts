import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { ApiKeyCreatedResponse, ApiKeyResponse } from "@maple/domain/http"
import type { ApiKeyNotFoundError, ApiKeyPersistenceError } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	isoTimestamp,
	isoTimestampOrNull,
	paginateArray,
	permissionError,
	resourceNotFound,
} from "@maple/domain/http/v2"
import type { V2ApiKey, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { requireAdmin } from "../../lib/auth"

const adminOnly = (action: string) => () =>
	permissionError("insufficient_permissions", `Only org admins can ${action} API keys`)

type ApiKeyFields = Pick<
	ApiKeyResponse,
	| "id"
	| "name"
	| "description"
	| "keyPrefix"
	| "kind"
	| "scopes"
	| "revoked"
	| "revokedAt"
	| "lastUsedAt"
	| "expiresAt"
	| "createdAt"
	| "createdBy"
	| "createdByEmail"
>

const toV2ApiKey = (key: ApiKeyFields): V2ApiKey => ({
	id: key.id,
	object: "api_key",
	name: key.name,
	description: key.description,
	key_prefix: key.keyPrefix,
	kind: key.kind,
	scopes: key.scopes,
	revoked: key.revoked,
	revoked_at: isoTimestampOrNull(key.revokedAt),
	last_used_at: isoTimestampOrNull(key.lastUsedAt),
	expires_at: isoTimestampOrNull(key.expiresAt),
	created_at: isoTimestamp(key.createdAt),
	created_by: key.createdBy,
	created_by_email: key.createdByEmail,
})

const toV2ApiKeyWithSecret = (key: ApiKeyCreatedResponse): V2ApiKeyWithSecret => ({
	...toV2ApiKey(key),
	...(key.txid !== undefined ? { txid: key.txid } : {}),
	secret: key.secret,
})

const toV2ApiKeyMutationResponse = (key: ApiKeyResponse): V2ApiKeyMutationResponse => ({
	...toV2ApiKey(key),
	...(key.txid !== undefined ? { txid: key.txid } : {}),
})

/** Service tagged errors → v2 envelope errors. */
const mapServiceError =
	(operation: string) =>
	<A, R>(effect: Effect.Effect<A, ApiKeyNotFoundError | ApiKeyPersistenceError, R>) =>
		effect.pipe(
			Effect.catchTags({
				"@maple/http/errors/ApiKeyNotFoundError": () =>
					Effect.fail(resourceNotFound("api_key", "No such API key.")),
				"@maple/http/errors/ApiKeyPersistenceError": () =>
					Effect.fail(dependencyUnavailable(`api_key_${operation}_unavailable`)),
			}),
		)

const mapPersistenceError = (operation: string) => () =>
	dependencyUnavailable(`api_key_${operation}_unavailable`)

export const HttpV2ApiKeysLive = HttpApiBuilder.group(MapleApiV2, "apiKeys", (handlers) =>
	Effect.gen(function* () {
		const apiKeysService = yield* ApiKeysService
		const auth = yield* AuthService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* apiKeysService
						.list(tenant.orgId)
						.pipe(Effect.mapError(mapPersistenceError("list")))
					const page = yield* paginateArray(response.keys.map(toV2ApiKey), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const key = yield* apiKeysService
						.get(tenant.orgId, params.id)
						.pipe(mapServiceError("retrieve"))
					return toV2ApiKey(key)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("create"))
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const created = yield* apiKeysService
						.create(tenant.orgId, tenant.userId, {
							name: payload.name,
							description: payload.description,
							expiresInSeconds: payload.expires_in_seconds,
							kind: payload.kind,
							scopes: payload.scopes,
							createdByEmail,
						})
						.pipe(Effect.mapError(mapPersistenceError("create")))
					return toV2ApiKeyWithSecret(created)
				}),
			)
			.handle("roll", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("roll"))
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const rolled = yield* apiKeysService
						.roll(tenant.orgId, tenant.userId, params.id, { createdByEmail })
						.pipe(mapServiceError("roll"))
					return toV2ApiKeyWithSecret(rolled)
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("revoke"))
					const revoked = yield* apiKeysService
						.revoke(tenant.orgId, params.id)
						.pipe(mapServiceError("revoke"))
					return toV2ApiKeyMutationResponse(revoked)
				}),
			)
	}),
)
