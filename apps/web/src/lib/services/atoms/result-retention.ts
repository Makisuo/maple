/**
 * Last-successful-result store, keyed by logical query identity.
 *
 * Atom idle TTLs keep a result alive only for as long as its *key* exists. A
 * relative time preset produces a new key every grid interval, so navigating
 * away and back eventually lands on a key that has never been fetched — the
 * atom starts `Initial`, and the page paints a skeleton over data that was
 * correct moments ago.
 *
 * This store sits underneath that. It is keyed by `identityFromKey` (the query
 * minus its time window), so the result from the previous window is still
 * findable, and `Atom.withFallback` serves it as `waiting: true` while the new
 * window loads.
 *
 * Two bounds keep it honest, because it deliberately outlives the atoms it
 * mirrors:
 *
 *  - `MAX_ENTRIES` — a hard cap with LRU eviction. Without it, a long session
 *    that visits many filter combinations retains every one of them forever.
 *  - `MAX_RETAINED_AGE_MS` — reads past this return nothing. Showing data from
 *    thirty seconds ago while it refreshes is helpful; showing data from an
 *    hour ago is a lie with a spinner on it.
 */

export const MAX_ENTRIES = 400

export const MAX_RETAINED_AGE_MS = 30 * 60 * 1000

/**
 * Namespace for one atom family, so identities never collide across queries.
 *
 * Required, not optional. A logical identity is the query input with its time
 * window stripped, and plenty of distinct queries take nothing *but* a window —
 * `getServicesFacets` and `getServiceOverview` both reduce to `{}`. Without a
 * per-family namespace they share an identity, and one query's rows get served
 * to the other as a fallback, which surfaces as a shape error in whatever
 * component reads it first.
 *
 * A counter is enough: the store is in-memory, so identities only have to be
 * stable within a session, and module init order is deterministic within one.
 */
let familySequence = 0

export function nextRetentionNamespace(): string {
	familySequence += 1
	return `f${familySequence}`
}

interface RetainedEntry {
	readonly value: unknown
	/** Epoch ms the value was produced — surfaced as the served result's timestamp. */
	readonly timestamp: number
}

/**
 * Insertion order doubles as recency: a `Map` preserves it, so re-inserting on
 * read moves an entry to the back and the oldest is always `keys().next()`.
 */
const entries = new Map<string, RetainedEntry>()

/**
 * Record a successful result for later reuse under a different time window.
 *
 * `timestamp` should be the moment the value was *produced* (a `Result`'s own
 * timestamp), not the moment it was recorded. Callers re-record on every read,
 * so stamping with `Date.now()` here would keep resetting an entry's age and
 * nothing would ever expire.
 */
export function retainResult(identity: string, value: unknown, timestamp: number = Date.now()): void {
	entries.delete(identity)
	entries.set(identity, { value, timestamp })

	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next()
		if (oldest.done) break
		entries.delete(oldest.value)
	}
}

/**
 * The most recent result for this identity, or `undefined` if there is none or
 * it has aged out. A hit is refreshed to the back of the LRU — what the user
 * keeps navigating back to is what is worth keeping.
 */
export function retainedResult(identity: string, now: number = Date.now()): RetainedEntry | undefined {
	const entry = entries.get(identity)
	if (!entry) return undefined

	if (now - entry.timestamp > MAX_RETAINED_AGE_MS) {
		entries.delete(identity)
		return undefined
	}

	entries.delete(identity)
	entries.set(identity, entry)
	return entry
}

/** Test seam. */
export function clearRetainedResults(): void {
	entries.clear()
}

/** Test seam. */
export function retainedResultCount(): number {
	return entries.size
}
