import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiKeyForbiddenError, CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { ApiKeysService } from "../services/ApiKeysService"
import { AuthService } from "../services/AuthService"
import { requireAdmin } from "../lib/auth"

const forbidden = (message: string) => () => new ApiKeyForbiddenError({ message })

export const HttpApiKeysLive = HttpApiBuilder.group(MapleApi, "apiKeys", (handlers) =>
	Effect.gen(function* () {
		const apiKeysService = yield* ApiKeysService
		const auth = yield* AuthService

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* apiKeysService.list(tenant.orgId)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden("Only org admins can create API keys"))
					const createdByEmail = yield* auth.getUserEmail(tenant.userId)
					return yield* apiKeysService.create(tenant.orgId, tenant.userId, {
						name: payload.name,
						description: payload.description,
						expiresInSeconds: payload.expiresInSeconds,
						kind: payload.kind,
						createdByEmail,
					})
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, forbidden("Only org admins can revoke API keys"))
					return yield* apiKeysService.revoke(tenant.orgId, params.keyId)
				}),
			)
	}),
)
