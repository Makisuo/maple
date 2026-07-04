import { electricSyncBaseUrl } from "@/lib/services/common/electric-sync-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"

/**
 * URL of the standalone `apps/electric-sync` ElectricSQL shape proxy. Every
 * collection points its ShapeStream here with `?shape=<name>`; the proxy
 * authenticates, injects the org scope, and forwards to Electric. Never point a
 * ShapeStream at Electric directly — it has no auth.
 */
export const shapeProxyUrl = `${electricSyncBaseUrl}/api/sync/shape`

/**
 * `fetchClient` for every ShapeStream. Mirrors `mapleFetch` in http-client.ts
 * (which isn't exported): injects the Clerk / self-hosted bearer on requests to
 * the API so the proxy can resolve the tenant, exactly like the rest of the app.
 *
 * We deliberately do NOT impose our own timeout: Electric `live` requests
 * long-poll (~20s) and the ShapeStream manages its own AbortController and
 * backoff, so we pass `init.signal` straight through.
 */
export const mapleShapeFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)
	const authHeaders = await getMapleAuthHeaders()
	for (const [name, value] of Object.entries(authHeaders)) {
		if (!headers.has(name)) headers.set(name, value)
	}
	return globalThis.fetch(input, { ...init, headers })
}
