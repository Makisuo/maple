// Tiny hash router with query-string support.
//
// The local SPA is served from the Rust binary at a fixed origin, so we route
// purely in the fragment: `#/<path>?<filters>`. Keeping filter state in the
// hash makes every view reload-safe and shareable — paste a URL with
// `#/sessions?browser=Chrome&errors=1` and it rehydrates exactly.

import { useCallback, useMemo, useSyncExternalStore } from "react"

function getHash(): string {
	return window.location.hash.replace(/^#/, "")
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener("hashchange", onChange)
	return () => window.removeEventListener("hashchange", onChange)
}

export interface Location {
	/** Path portion of the hash, e.g. `/sessions`. Always starts with `/`. */
	readonly path: string
	/** Parsed query portion. */
	readonly query: URLSearchParams
}

function parseLocation(hash: string): Location {
	const [rawPath, rawSearch = ""] = hash.split("?")
	const path = rawPath && rawPath.startsWith("/") ? rawPath : "/traces"
	return { path, query: new URLSearchParams(rawSearch) }
}

function buildHash(path: string, query?: URLSearchParams): string {
	const qs = query?.toString()
	return `#${path}${qs ? `?${qs}` : ""}`
}

/**
 * Navigate to a path. Page-to-page moves push a history entry (default);
 * in-place filter updates pass `replace` so the back button steps between
 * pages, not between every filter tweak.
 */
export function navigate(path: string, query?: URLSearchParams, opts?: { replace?: boolean }): void {
	const hash = buildHash(path, query)
	if (opts?.replace) {
		history.replaceState(null, "", hash)
		// replaceState doesn't emit hashchange — nudge the store to re-read.
		window.dispatchEvent(new Event("hashchange"))
	} else {
		window.location.hash = hash
	}
}

/** Reactive current location, parsed from the hash. */
export function useLocation(): Location {
	const hash = useSyncExternalStore(subscribe, getHash, () => "")
	return useMemo(() => parseLocation(hash), [hash])
}

/**
 * Read/update the query params of the current path. Updating preserves the
 * path; setting a key to `null`/empty removes it.
 */
export function useQueryParams(): readonly [
	URLSearchParams,
	(updates: Record<string, string | null | undefined>) => void,
] {
	const { query } = useLocation()
	const setParams = useCallback((updates: Record<string, string | null | undefined>) => {
		// Read the live hash rather than the render-captured location: handlers
		// that call setParams twice in one tick (e.g. a duration preset setting
		// min and clearing max) would otherwise clobber each other's update.
		const current = parseLocation(getHash())
		const next = new URLSearchParams(current.query)
		for (const [key, value] of Object.entries(updates)) {
			if (value == null || value === "") next.delete(key)
			else next.set(key, value)
		}
		navigate(current.path, next, { replace: true })
	}, [])
	return [query, setParams] as const
}
