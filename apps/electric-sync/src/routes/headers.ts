// Upstream response headers that must not survive re-wrapping: the platform
// re-encodes and re-chunks the streamed body, so a stale content-encoding /
// content-length would misdescribe it.
const STRIPPED_UPSTREAM_HEADERS = ["content-encoding", "content-length"]

/**
 * Adds `header` to a `Vary` header value without clobbering existing tokens or
 * duplicating (case-insensitive). A pre-existing `Vary: *` already defeats shared
 * caching, so it's left as-is.
 */
const appendVary = (existing: string | undefined, header: string): string => {
	const trimmed = existing?.trim()
	if (!trimmed) return header
	if (trimmed === "*") return trimmed
	const tokens = trimmed
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)
	if (tokens.some((t) => t.toLowerCase() === header.toLowerCase())) return tokens.join(", ")
	return [...tokens, header].join(", ")
}

/**
 * Shapes the headers we return to the browser from an upstream Electric response.
 * Pure and exported so tests can assert the cache-isolation guarantees.
 *
 * Electric marks the initial snapshot / historical log chunks `cache-control:
 * public` so a CDN can fan them out. But our client-facing URL carries NO org — it
 * is `?shape=<name>&offset=…`, byte-identical for every tenant, with the org
 * derived from the bearer. A shared cache keyed on that URL would serve one org's
 * rows to another (the same cross-tenant leak the server-pinned `org_id` WHERE
 * exists to prevent, one layer up). So, per Electric's auth guide, we:
 *   - add `Vary: Authorization` so any compliant cache keys on the bearer (→ org);
 *   - downgrade `public` → `private` so no shared CDN/proxy holds an org's rows at
 *     all (live `no-store` responses are left untouched).
 * We also drop content-encoding/content-length, which misdescribe the re-wrapped
 * body. Effect lowercases header keys, so we match on lowercase names.
 */
export const shapeResponseHeaders = (upstream: Readonly<Record<string, string>>): Record<string, string> => {
	const headers: Record<string, string> = { ...upstream }
	for (const key of STRIPPED_UPSTREAM_HEADERS) delete headers[key]

	headers.vary = appendVary(headers.vary, "Authorization")

	const cacheControl = headers["cache-control"]
	if (cacheControl && /\bpublic\b/.test(cacheControl)) {
		headers["cache-control"] = cacheControl.replace(/\bpublic\b/g, "private")
	}

	return headers
}
