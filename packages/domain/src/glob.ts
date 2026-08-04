/**
 * Shell-style glob matching, shared so the two sides of a filter can't disagree.
 *
 * PlanetScale branch filters (`pr-*`, `preview-?`) are applied server-side by the
 * scrape discovery service and previewed client-side in the integration card. Those
 * two had independent implementations and drifted: the client escaped `?` as a
 * literal while the server treated it as a one-character wildcard, so a `pr-?`
 * pattern was honored by the scraper but shown as *not* excluded in the UI. One
 * implementation, imported by both.
 *
 * Anchored. `*` matches any run (including empty), `?` matches exactly one
 * character, everything else is literal.
 */

/** Glob → anchored RegExp supporting `*` (any run) and `?` (one char). */
export const globToRegExp = (pattern: string): RegExp => {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	return new RegExp(`^${escaped}$`)
}

/** True when `value` matches `pattern`. An empty pattern matches nothing. */
export const matchesGlob = (pattern: string, value: string): boolean => {
	if (pattern === "") return false
	return globToRegExp(pattern).test(value)
}
