export type MapleAuthHeaders = Readonly<Record<string, string>>

type MapleAuthHeadersProvider = () => Promise<MapleAuthHeaders> | MapleAuthHeaders

let authHeaders: MapleAuthHeaders = {}
let authHeadersProvider: MapleAuthHeadersProvider | undefined

// Bearer-token cache
//
// Every outbound API request awaits this module (see http-client.ts), and the
// Clerk provider below resolves to `getToken()` — a cross-origin round-trip to
// Clerk whenever the 60s session JWT is near expiry. Uncached, that landed on
// the critical path of every request in the app: production traces showed p50
// 580ms / p90 3.2s elapsing between the browser issuing a request and the API
// Worker's server span starting, against a ~200ms handler.
//
// So: cache the resolved headers until the token is nearly spent, and refresh
// ahead of that so no request ever blocks on the identity provider. Only
// JWT-shaped bearer tokens are cached — an opaque token has no expiry we can
// trust, and the providers that issue one (self-hosted, reading sessionStorage)
// are synchronous anyway.

/** Inside this much remaining life, a request must wait for a fresh token. */
const TOKEN_MIN_REMAINING_MS = 10_000
/** Inside this much, serve the cached token but refresh in the background. */
const TOKEN_REFRESH_AHEAD_MS = 30_000

interface CachedAuth {
	readonly headers: MapleAuthHeaders
	readonly expMs: number
}

let cachedAuth: CachedAuth | undefined
let inFlightRefresh: Promise<MapleAuthHeaders> | undefined
/**
 * Bumped whenever the identity changes (provider swap, sign-out, org switch).
 * A refresh started under an older generation must not populate the cache — its
 * token belongs to an identity we've since left.
 */
let authGeneration = 0

const decodeBase64Url = (segment: string): string => {
	const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
	return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="))
}

/** Expiry of a bearer JWT in epoch ms, or undefined if it isn't one. */
const readBearerExpMs = (headers: MapleAuthHeaders): number | undefined => {
	const authorization = headers.authorization
	if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return undefined
	const segments = authorization.slice("Bearer ".length).split(".")
	if (segments.length !== 3 || segments[1] === undefined) return undefined
	try {
		const claims: unknown = JSON.parse(decodeBase64Url(segments[1]))
		if (typeof claims !== "object" || claims === null) return undefined
		const exp = (claims as { exp?: unknown }).exp
		return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined
	} catch {
		// Not a JWT we can read — fall through to resolving on every call.
		return undefined
	}
}

const refreshAuthHeaders = (): Promise<MapleAuthHeaders> => {
	if (inFlightRefresh) return inFlightRefresh
	const provider = authHeadersProvider
	if (!provider) return Promise.resolve({})
	const generation = authGeneration
	inFlightRefresh = Promise.resolve(provider())
		.then((headers) => {
			if (generation === authGeneration) {
				const expMs = readBearerExpMs(headers)
				cachedAuth = expMs === undefined ? undefined : { headers, expMs }
			}
			return headers
		})
		.finally(() => {
			inFlightRefresh = undefined
		})
	return inFlightRefresh
}

/** Drop the cached bearer token so the next request re-resolves it. */
export const invalidateMapleAuthToken = () => {
	authGeneration += 1
	cachedAuth = undefined
}

/** Whether a bearer token is currently being served from cache. */
export const hasCachedMapleAuthToken = (): boolean => cachedAuth !== undefined

// The active org isn't carried in the auth headers — it's implicit in the
// Clerk/self-hosted bearer token, so the API derives it server-side. Client-side
// caches that must not bleed across orgs (e.g. SpanMetrics availability) can't
// see it from the headers, so the React auth layer publishes it here and those
// caches key on it. Reset to null on sign-out / org-less states.
let activeOrgId: string | null = null

const activeOrgSubscribers = new Set<() => void>()

export const getActiveOrgId = (): string | null => activeOrgId

export const setActiveOrgId = (orgId: string | null | undefined) => {
	const next = orgId && orgId.length > 0 ? orgId : null
	if (next === activeOrgId) return
	activeOrgId = next
	// The bearer token encodes the active org, so a cached one that outlived an
	// org switch would query the previous org's data. Drop it here rather than
	// relying on Clerk to have re-issued before the next request goes out.
	invalidateMapleAuthToken()
	// Notify reactive consumers (e.g. useActiveOrgId → the per-org ElectricSQL
	// collection lifecycle) so an org switch recreates org-scoped state.
	for (const notify of activeOrgSubscribers) notify()
}

/** Subscribe to active-org changes. Returns an unsubscribe fn (useSyncExternalStore-shaped). */
export const subscribeActiveOrgId = (notify: () => void): (() => void) => {
	activeOrgSubscribers.add(notify)
	return () => activeOrgSubscribers.delete(notify)
}

export const getMapleAuthHeaders = async (): Promise<MapleAuthHeaders> => {
	const cached = cachedAuth
	const remainingMs = cached === undefined ? -1 : cached.expMs - Date.now()
	let providedHeaders: MapleAuthHeaders
	if (cached !== undefined && remainingMs > TOKEN_MIN_REMAINING_MS) {
		providedHeaders = cached.headers
		if (remainingMs <= TOKEN_REFRESH_AHEAD_MS) {
			// Refresh ahead of the deadline. Deliberately not awaited: this request
			// already has a valid token, and blocking it on Clerk is the cost this
			// cache exists to remove. A failed refresh just leaves the cache alone
			// for the next caller to retry.
			void refreshAuthHeaders().catch(() => undefined)
		}
	} else {
		providedHeaders = authHeadersProvider ? await refreshAuthHeaders() : {}
	}
	return {
		...providedHeaders,
		...authHeaders,
	}
}

export const setMapleAuthHeaders = (headers: Record<string, string>) => {
	authHeaders = { ...headers }
}

export const clearMapleAuthHeaders = () => {
	authHeaders = {}
	invalidateMapleAuthToken()
}

export const setMapleAuthHeadersProvider = (provider?: MapleAuthHeadersProvider) => {
	authHeadersProvider = provider
	invalidateMapleAuthToken()
}
