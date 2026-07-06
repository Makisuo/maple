export type MapleAuthHeaders = Readonly<Record<string, string>>

type MapleAuthHeadersProvider = () => Promise<MapleAuthHeaders> | MapleAuthHeaders

let authHeaders: MapleAuthHeaders = {}
let authHeadersProvider: MapleAuthHeadersProvider | undefined

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
	const providedHeaders = authHeadersProvider ? await authHeadersProvider() : {}
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
}

export const setMapleAuthHeadersProvider = (provider?: MapleAuthHeadersProvider) => {
	authHeadersProvider = provider
}
