import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, isoTimestamp } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { ApiKeysService } from "@/services/org/ApiKeysService"

/**
 * The widget credential's ceilings, all of them the server's.
 *
 * Choosing them here rather than accepting them from the caller is the whole
 * reason this is a dedicated operation instead of `POST /v2/api_keys` with a
 * `kind`: a client that is compromised — or simply wrong — cannot widen any of
 * them.
 *
 * The TTL is long enough that a phone used weekly never sees a widget go quiet,
 * and short enough that a credential lifted off a lost device stops working
 * without anyone having to notice. The app re-mints a week ahead of it, on a
 * foreground it was making anyway.
 */
const WIDGET_CREDENTIAL_TTL_SECONDS = 60 * 60 * 24 * 30
/**
 * The fence. `requiredScopeForRequest` derives an API key's required scope from
 * the first path segment, so this reaches `/v2/widget_summary` and nothing
 * else. Composed from the endpoints that summary is built out of, the same
 * credential would need `error_issues:read` + `services:read` + `traces:read` —
 * an organization read key, sitting on a phone.
 *
 * Note what is *not* here: `widget_credentials:write`. A credential cannot
 * renew itself, so renewal is always something a signed-in human's session did.
 */
const WIDGET_CREDENTIAL_SCOPES = ["widget_summary:read"] as const
const WIDGET_CREDENTIAL_NAME = "Home Screen widgets"

export const HttpV2WidgetCredentialsLive = HttpApiBuilder.group(MapleApiV2, "widgetCredentials", (handlers) =>
	Effect.gen(function* () {
		const apiKeys = yield* ApiKeysService

		return handlers
			.handle("mint", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const credential = yield* apiKeys.replaceDeviceKey(tenant.orgId, tenant.userId, {
						deviceId: params.installation_id,
						name: WIDGET_CREDENTIAL_NAME,
						scopes: WIDGET_CREDENTIAL_SCOPES,
						expiresInSeconds: WIDGET_CREDENTIAL_TTL_SECONDS,
						// The signed-in user's own roles. A credential must never
						// outrank the human who asked for it, and the alternative —
						// letting it resolve with the API-key default — is `root`.
						roles: tenant.roles,
					})
					return {
						object: "widget_credential" as const,
						secret: credential.secret,
						organization_id: tenant.orgId,
						scopes: credential.scopes ?? WIDGET_CREDENTIAL_SCOPES,
						// `replaceDeviceKey` always sets an expiry; the fallback is
						// only here because the shared response type allows none.
						expires_at: isoTimestamp(credential.expiresAt ?? credential.createdAt),
						created_at: isoTimestamp(credential.createdAt),
					}
				}),
			)
			.handle("revoke", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Idempotent, and deliberately not a 404 when there is nothing
					// to revoke: this is the sign-out path, and an error the app
					// cannot act on while signing out anyway is worse than silence.
					yield* apiKeys.revokeDeviceKeys(tenant.orgId, params.installation_id)
					return { object: "widget_credential" as const, deleted: true as const }
				}),
			)
	}),
)
