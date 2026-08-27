import { getActiveOrgId } from "./auth-headers"

// The org-global service.namespace pin lives here rather than in an Atom.kvs
// because query inputs are built synchronously outside atom contexts — in route
// loaders (warmAtoms inputs must match component inputs byte for byte), in the
// atom key encoder, and in the infinite hooks' direct page fetches.
const STORAGE_PREFIX = "maple.global-namespace."

let cached: { readonly orgId: string; readonly value: string | null } | null = null

const subscribers = new Set<() => void>()

const read = (orgId: string): string | null => {
	try {
		const raw = localStorage.getItem(`${STORAGE_PREFIX}${orgId}`)
		return raw !== null && raw.length > 0 ? raw : null
	} catch {
		// SSR / storage denied — behave as "All namespaces".
		return null
	}
}

/** The active org's pinned service.namespace, or null for "All namespaces". */
export const getGlobalNamespace = (): string | null => {
	const orgId = getActiveOrgId()
	if (orgId === null) return null
	if (cached?.orgId !== orgId) cached = { orgId, value: read(orgId) }
	return cached.value
}

export const setGlobalNamespace = (value: string | null) => {
	const orgId = getActiveOrgId()
	if (orgId === null) return
	try {
		if (value === null) localStorage.removeItem(`${STORAGE_PREFIX}${orgId}`)
		else localStorage.setItem(`${STORAGE_PREFIX}${orgId}`, value)
	} catch {
		// Storage denied — the in-memory pin still applies for this session.
	}
	cached = { orgId, value }
	for (const notify of subscribers) notify()
}

/** Subscribe to pin changes. Returns an unsubscribe fn (useSyncExternalStore-shaped). */
export const subscribeGlobalNamespace = (notify: () => void): (() => void) => {
	subscribers.add(notify)
	return () => subscribers.delete(notify)
}
