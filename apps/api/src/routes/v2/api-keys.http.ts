import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { ApiKeyCreatedResponse, ApiKeyResponse } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import {
	MapleApiV2,
	isoTimestamp,
	isoTimestampOrNull,
	paginateArray,
	V2InsufficientPermissions,
} from "@maple/domain/http/v2"
import type { V2ApiKey, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { requireAdmin } from "@/services/auth/auth"

const adminOnly = (action: string) => () =>
	V2InsufficientPermissions.make(`Only org admins can ${action} API keys`)

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
	...(key.txid !== undefined ? { txid: key.txid } : undefined),
	secret: key.secret,
})

const toV2ApiKeyMutationResponse = (key: ApiKeyResponse): V2ApiKeyMutationResponse => ({
	...toV2ApiKey(key),
	...(key.txid !== undefined ? { txid: key.txid } : undefined),
})

export const HttpV2ApiKeysLive = HttpApiBuilder.group(MapleApiV2, "apiKeys", (handlers) =>
	Effect.gen(function* () {
		const apiKeysService = yield* ApiKeysService
		const auth = yield* AuthService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* apiKeysService.list(tenant.orgId)
					const page = yield* paginateArray(response.keys.map(toV2ApiKey), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const key = yield* apiKeysService.get(tenant.orgId, params.id)
					return toV2ApiKey(key)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// MCP keys are per-developer credentials any member may mint for
					// themselves; the creator's roles are pinned onto the key so it
					// carries no more authority than they have (an unpinned key
					// resolves as `root`). Standard API keys stay admin-only.
					const isMcpKey = payload.kind === "mcp"
					if (!isMcpKey) {
						yield* requireAdmin(tenant.roles, adminOnly("create"))
					}
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const created = yield* apiKeysService.create(tenant.orgId, tenant.userId, {
						name: payload.name,
						description: payload.description,
						expiresInSeconds: payload.expires_in_seconds,
						kind: payload.kind,
						scopes: payload.scopes,
						createdByEmail,
						...(isMcpKey
							? { metadataJson: { source: "maple_mcp", roles: [...tenant.roles] } }
							: undefined),
					})
					yield* recordHttpAudit("api_key.created", {
						resourceId: created.id,
						metadata: { name: created.name, kind: created.kind, scopes: created.scopes },
					})
					return toV2ApiKeyWithSecret(created)
				}),
			)
			.handle("roll", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, adminOnly("roll"))
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					const rolled = yield* apiKeysService.roll(tenant.orgId, tenant.userId, params.id, {
						createdByEmail,
					})
					yield* recordHttpAudit("api_key.rolled", {
						resourceId: rolled.id,
						metadata: { name: rolled.name, scopes: rolled.scopes },
					})
					return toV2ApiKeyWithSecret(rolled)
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Whoever can mint a key must be able to kill it: a member may
					// revoke an MCP key they created themselves. Everything else
					// stays admin-only.
					const existing = yield* apiKeysService.get(tenant.orgId, params.id)
					const isOwnMcpKey = existing.kind === "mcp" && existing.createdBy === tenant.userId
					if (!isOwnMcpKey) {
						yield* requireAdmin(tenant.roles, adminOnly("revoke"))
					}
					const revoked = yield* apiKeysService.revoke(tenant.orgId, params.id)
					yield* recordHttpAudit("api_key.revoked", {
						resourceId: revoked.id,
						metadata: { name: revoked.name },
					})
					return toV2ApiKeyMutationResponse(revoked)
				}),
			)
	}),
)
