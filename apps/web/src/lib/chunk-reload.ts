const RELOAD_GUARD_KEY = "maple:chunk-reload-attempt"
const RELOAD_GUARD_WINDOW_MS = 60_000

// The `.component` alternatives (Chrome and Safari wording) are TanStack Router
// rendering a route whose module came from a build that has since been
// replaced: the route table in the stale tab no longer lines up with the chunks
// the CDN serves, so a match resolves to an undefined route definition. Seen
// only on superseded `deployment.commit_sha`s, and a reload fixes it the same
// way a failed chunk import does.
const CHUNK_ERROR_PATTERN =
	/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Cannot read properties of undefined \(reading 'component'\)|undefined is not an object \(evaluating '[^']*\.component'\)/i

export function isChunkLoadError(error: unknown): boolean {
	if (error instanceof Error) return CHUNK_ERROR_PATTERN.test(error.message)
	if (typeof error === "string") return CHUNK_ERROR_PATTERN.test(error)
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message: unknown }).message
		if (typeof message === "string") return CHUNK_ERROR_PATTERN.test(message)
	}
	return false
}

export function shouldAttemptChunkReload(): boolean {
	try {
		const last = sessionStorage.getItem(RELOAD_GUARD_KEY)
		if (last && Date.now() - Number(last) < RELOAD_GUARD_WINDOW_MS) return false
		sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
		return true
	} catch {
		return true
	}
}

export function clearChunkReloadGuard(): void {
	try {
		sessionStorage.removeItem(RELOAD_GUARD_KEY)
	} catch {}
}
