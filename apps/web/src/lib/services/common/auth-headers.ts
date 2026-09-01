import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

export type MapleAuthHeaders = Readonly<Record<string, string>>

/**
 * Raised instead of authorizing a request whose identity changed while its
 * headers were resolving. The request was constructed under the org the user
 * just left; the API scopes every call by bearer, so re-signing it with the new
 * identity's token would run it — including mutations — against the wrong
 * tenant. Failing closed lets per-org query state recreate the request itself.
 */
export class MapleAuthIdentityChangedError extends Schema.TaggedError<MapleAuthIdentityChangedError>()(
	"@maple/web/services/MapleAuthIdentityChangedError",
	{ message: Schema.String },
) {}

type MapleAuthHeadersProvider = () => Promise<MapleAuthHeaders> | MapleAuthHeaders

let authHeaders: MapleAuthHeaders = {}
let authHeadersProvider: MapleAuthHeadersProvider | undefined

// Cache JWT-derived headers off the request path and refresh before expiry.
// Opaque tokens stay uncached because their lifetime cannot be inferred.

/** Inside this much remaining life, a request must wait for a fresh token. */
const TOKEN_MIN_REMAINING_MS = 10_000
/** Inside this much, serve the cached token but refresh in the background. */
const TOKEN_REFRESH_AHEAD_MS = 30_000

interface CachedAuth {
	readonly headers: MapleAuthHeaders
	readonly expMs: number
}

let cachedAuth: CachedAuth | undefined
/**
 * Bumped whenever the identity changes (provider swap, sign-out, org switch).
 * A refresh started under an older generation must not populate the cache, be
 * joined by a later caller, or clear a newer refresh's slot — its token belongs
 * to an identity we've since left.
 */
let authGeneration = 0
/**
 * The refresh in flight, tagged with the identity that started it.
 *
 * Tagged rather than bare: a bare promise was shared with every caller that
 * arrived while it was open, including callers that arrived *after* an org
 * switch or sign-out — they awaited it and sent the previous identity's bearer.
 * Its `finally` also cleared the slot unconditionally, so a straggler could
 * evict the successor that replaced it.
 */
let inFlightRefresh: { readonly generation: number; readonly promise: Promise<MapleAuthHeaders> } | undefined

const decodeBase64Url = (segment: string): string => {
	const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
	return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="))
}

/**
 * Expiry of a JWT in epoch ms, or undefined if the token isn't one we can read.
 *
 * Exported because the self-hosted provider renews against the same deadline
 * this cache keys on — two decoders that could disagree about when a token dies
 * is exactly the bug worth not having.
 */
export const readJwtExpMs = (token: string): number | undefined => {
	const segments = token.split(".")
	if (segments.length !== 3 || segments[1] === undefined) return undefined
	try {
		const claims: unknown = JSON.parse(decodeBase64Url(segments[1]))
		if (!Predicate.isObject(claims)) return undefined
		const exp = claims.exp
		return Predicate.isNumber(exp) && Number.isFinite(exp) ? exp * 1000 : undefined
	} catch {
		// Not a JWT we can read — fall through to resolving on every call.
		return undefined
	}
}

/** Expiry of a bearer JWT in epoch ms, or undefined if it isn't one. */
const readBearerExpMs = (headers: MapleAuthHeaders): number | undefined => {
	const authorization = headers.authorization
	if (!Predicate.isString(authorization) || !authorization.startsWith("Bearer ")) return undefined
	return readJwtExpMs(authorization.slice("Bearer ".length))
}

const refreshAuthHeaders = (): Promise<MapleAuthHeaders> => {
	// Only join a refresh belonging to the identity we are currently serving.
	if (inFlightRefresh && inFlightRefresh.generation === authGeneration) return inFlightRefresh.promise
	const provider = authHeadersProvider
	if (!provider) return Promise.resolve({})
	const generation = authGeneration
	const promise = Promise.resolve(provider())
		.then((headers) => {
			if (generation === authGeneration) {
				const expMs = readBearerExpMs(headers)
				cachedAuth = expMs === undefined ? undefined : { headers, expMs }
			}
			return headers
		})
		.finally(() => {
			// Only ever clear our own slot — a straggler must not evict the
			// successor started after the identity changed.
			if (inFlightRefresh?.generation === generation) inFlightRefresh = undefined
		})
	inFlightRefresh = { generation, promise }
	return promise
}

/** Drop the cached bearer token so the next request re-resolves it. */
export const invalidateMapleAuthToken = () => {
	authGeneration += 1
	cachedAuth = undefined
	// Orphan any refresh already open: it resolves into nothing rather than
	// being handed to a caller that belongs to the new identity.
	inFlightRefresh = undefined
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

/** Cached token if it has enough life left, otherwise a fresh resolve. */
const resolveProvidedHeaders = async (): Promise<MapleAuthHeaders> => {
	const cached = cachedAuth
	const remainingMs = cached === undefined ? -1 : cached.expMs - Date.now()
	if (cached !== undefined && remainingMs > TOKEN_MIN_REMAINING_MS) {
		if (remainingMs <= TOKEN_REFRESH_AHEAD_MS) {
			// Refresh ahead of the deadline. Deliberately not awaited: this request
			// already has a valid token, and blocking it on Clerk is the cost this
			// cache exists to remove. A failed refresh just leaves the cache alone
			// for the next caller to retry.
			void refreshAuthHeaders().catch(() => undefined)
		}
		return cached.headers
	}
	return authHeadersProvider ? await refreshAuthHeaders() : {}
}

export const getMapleAuthHeaders = async (): Promise<MapleAuthHeaders> => {
	const generation = authGeneration
	const orgAtStart = activeOrgId
	let providedHeaders = await resolveProvidedHeaders()
	if (generation !== authGeneration) {
		// The identity changed while we were waiting. If this request was formed
		// under a real org, fail closed: its URL and payload belong to the tenant
		// the user just left, and re-signing it with the new identity's bearer
		// would dispatch it against the wrong org.
		if (Predicate.isNotNull(orgAtStart)) {
			throw new MapleAuthIdentityChangedError({
				message: "The active organization changed while this request was being authorized.",
			})
		}
		// Boot path — no previous org, the bump was auth arriving rather than the
		// user leaving a tenant. Resolve once more under the current identity,
		// and fail closed if it moved again mid-retry.
		const retryGeneration = authGeneration
		providedHeaders = await resolveProvidedHeaders()
		if (retryGeneration !== authGeneration) {
			throw new MapleAuthIdentityChangedError({
				message: "The active organization changed while this request was being authorized.",
			})
		}
	}
	return {
		...providedHeaders,
		...authHeaders,
	}
}

export const setMapleAuthHeaders = (headers: Record<string, string>) => {
	authHeaders = { ...headers } satisfies MapleAuthHeaders
}

export const clearMapleAuthHeaders = () => {
	authHeaders = {}
	invalidateMapleAuthToken()
}

export const setMapleAuthHeadersProvider = (provider?: MapleAuthHeadersProvider) => {
	authHeadersProvider = provider
	invalidateMapleAuthToken()
}
