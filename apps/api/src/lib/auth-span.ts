import { Effect } from "effect"

/**
 * Annotate the current (HTTP server) span with how the request authenticated.
 *
 * Called from the authorization middlewares, which run within the root HTTP
 * span scope — so these attributes land on the same span that carries
 * `http.route`, making "which endpoint, by which auth method" queryable.
 *
 * Emits the `maple.*` vendor namespace (see the maple-telemetry-conventions):
 * - `maple.auth.method` — `"api_key"` | `"session"`, the auth discriminator
 * - `maple.api_key.id` — the key's opaque DB id (api_key only; never the token)
 * - `maple.org_id` / `tenant.userId` — for per-customer / per-user breakdowns
 */
export const annotateAuthSpan = (
	method: "api_key" | "session",
	attrs: { orgId: string; userId: string; keyId?: string },
) =>
	Effect.annotateCurrentSpan({
		"maple.auth.method": method,
		"maple.org_id": attrs.orgId,
		"tenant.userId": attrs.userId,
		...(attrs.keyId ? { "maple.api_key.id": attrs.keyId } : {}),
	})
