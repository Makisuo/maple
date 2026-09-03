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
 * Ceiling on how long a browser may hold a shape chunk, and why there is one.
 *
 * Electric marks a *completed* log chunk immutable and cacheable for days — sound
 * on its own terms, because a chunk is addressed by `handle` + `offset` and a
 * given handle's bytes never change. But a handle only lives as long as the
 * shape storage that minted it, and ours is task-local storage on a singleton
 * ECS task that is replaced whole on every deploy (see `apps/electric`). So the
 * two lifetimes disagree by orders of magnitude: the browser keeps chunks for a
 * week under a handle Electric forgets on the next deploy.
 *
 * What that costs is not a stale read — the client notices — it is a permanent
 * one. On a 409 the client writes the dead handle into `localStorage`
 * (`electric_expired_shapes`, LRU-capped, no TTL) and sends it as
 * `expired_handle` on every later request for that shape. A disk-cached chunk
 * still tagged with that handle then trips its stale-cache detector on every
 * page load, and the cache-buster retry that recovers clears neither side, so it
 * recurs for as long as both entries survive.
 *
 * A minute keeps the burst-coalescing that the cache header is actually for
 * (an initial sync fetches its chunks back-to-back) while bounding the window to
 * far less than a deploy.
 */
const MAX_BROWSER_CACHE_SECONDS = 60

/**
 * Rewrites every freshness directive down to the cap, leaving smaller values
 * alone. `stale-while-revalidate` is in the list and not an afterthought:
 * Electric pairs a long `max-age` with a *month* of it, and a browser that
 * honours it serves the stale chunk for that whole month — capping `max-age`
 * alone would have moved the bug rather than fixed it.
 */
const CAPPED_AGE_DIRECTIVES = /\b(s-maxage|max-age|stale-while-revalidate|stale-if-error)=(\d+)/gi

const capMaxAge = (cacheControl: string): string =>
	cacheControl.replace(CAPPED_AGE_DIRECTIVES, (directive, name: string, seconds: string) =>
		Number(seconds) > MAX_BROWSER_CACHE_SECONDS ? `${name}=${MAX_BROWSER_CACHE_SECONDS}` : directive,
	)

/**
 * Drops `immutable`, which tells a browser to skip revalidation entirely for the
 * whole freshness lifetime — the one directive a capped `max-age` cannot undo.
 */
const dropImmutable = (cacheControl: string): string =>
	cacheControl
		.split(",")
		.map((directive) => directive.trim())
		.filter((directive) => directive.toLowerCase() !== "immutable")
		.join(", ")

/**
 * Shapes the headers we return to the browser from an upstream Electric response.
 * Pure and exported so tests can assert the cache-isolation guarantees.
 *
 * Electric marks the initial snapshot / historical log chunks `cache-control:
 * public` so a CDN can fan them out. But our client-facing URL is not a tenant
 * boundary: the org comes from the bearer, and the `org=` the web app sends is
 * unverified — a cache-key hint, not a credential. Anyone can send another org's
 * id, so a shared cache trusting that URL would hand one org's rows to another
 * (the same cross-tenant leak the server-pinned `org_id` WHERE exists to prevent,
 * one layer up). So, per Electric's auth guide, we:
 *   - add `Vary: Authorization` so any compliant cache keys on the bearer (→ org);
 *   - downgrade `public` → `private` so no shared CDN/proxy holds an org's rows at
 *     all (live `no-store` responses are left untouched);
 *   - cap `max-age` and drop `immutable` — see `MAX_BROWSER_CACHE_SECONDS`.
 * We also drop content-encoding/content-length, which misdescribe the re-wrapped
 * body. Effect lowercases header keys, so we match on lowercase names.
 */
export const syncResponseHeaders = (upstream: Readonly<Record<string, string>>): Record<string, string> => {
	const headers: Record<string, string> = { ...upstream } satisfies Record<string, string>
	for (const key of STRIPPED_UPSTREAM_HEADERS) delete headers[key]

	headers.vary = appendVary(headers.vary, "Authorization")

	const cacheControl = headers["cache-control"]
	if (cacheControl) {
		headers["cache-control"] = dropImmutable(capMaxAge(cacheControl.replace(/\bpublic\b/g, "private")))
	}

	return headers
}
