/**
 * A persistent per-browser visitor id.
 *
 * Sessions rotate after 30 minutes idle (see `session.ts`), which makes them
 * useless for "how many people visited" — every long gap mints a new one. The
 * visitor id is the stable identifier that `uniq(VisitorId)` counts, and the
 * only place that knows whether a visitor is new (a self-join against earlier
 * sessions is both a second full scan and wrong past the warehouse's 30-day
 * TTL, which drops the history the join would need).
 *
 * This is a first-party persistent identifier: it requires a cookie/consent
 * notice under ePrivacy, and it is the one thing here that `persistVisitorId:
 * false` and Global Privacy Control turn off.
 */

const STORAGE_KEY = "maple.visitor"

/**
 * Match the ~13-month ceiling browsers and privacy regimes settled on for
 * first-party identifiers. Cheap to enforce from the start; retrofitting an
 * expiry onto ids already in the wild is not.
 */
const MAX_AGE_MS = 400 * 24 * 60 * 60_000

interface VisitorRecord {
	id: string
	/** epoch ms — when the id was minted, for the 400-day expiry. */
	mintedAt: number
}

let enabled = true
/** Memoized so the hot path never re-reads storage. */
let cached: VisitorRecord | undefined
let persisted = false
let mintedThisLoad = false

function read(): VisitorRecord | undefined {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY)
		if (!raw) return undefined
		const parsed = JSON.parse(raw) as Partial<VisitorRecord>
		if (typeof parsed.id !== "string" || typeof parsed.mintedAt !== "number") return undefined
		if (Date.now() - parsed.mintedAt > MAX_AGE_MS) return undefined
		return parsed as VisitorRecord
	} catch {
		return undefined
	}
}

function write(record: VisitorRecord): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
		persisted = true
	} catch {
		// Safari private mode / storage blocked. The in-memory id still keeps
		// every row from this page load consistent, which beats sending '' — but
		// it is not a real visitor id, and `isVisitorIdPersisted()` says so.
		persisted = false
	}
}

/**
 * The current visitor id, minting one on first use. `undefined` when visitor
 * tracking is off or outside a browser.
 */
export function getVisitorId(): string | undefined {
	if (!enabled || typeof window === "undefined") return undefined
	if (cached) return cached.id
	const existing = read()
	if (existing) {
		cached = existing
		persisted = true
		return existing.id
	}
	const record: VisitorRecord = {
		id: crypto.randomUUID(),
		mintedAt: Date.now(),
	}
	cached = record
	mintedThisLoad = true
	write(record)
	return record.id
}

/**
 * Claim the "this visitor was minted just now" flag for the session being
 * created — drives new vs returning without a self-join. Reading it mints the
 * id if needed, so callers get an answer consistent with `getVisitorId()`.
 *
 * One-shot on purpose. The flag is page-load scoped, but sessions are not: a
 * page load can both start a session and (30 minutes idle later) rotate into a
 * second one, and only the first of those belongs to a new visitor. The
 * claimed value is persisted on the session record, which is also what keeps a
 * reload from re-answering the question — see `session.ts`.
 */
export function claimNewVisitor(): boolean {
	getVisitorId()
	if (!mintedThisLoad) return false
	mintedThisLoad = false
	return true
}

/**
 * Whether the id actually survives this page load. `false` means storage was
 * blocked and the id is in-memory only, so uniques would be over-counted; the
 * metadata row carries this as `maple.visitor.persisted` so the analytics layer
 * can flag it rather than quietly inflate.
 */
export function isVisitorIdPersisted(): boolean {
	return persisted
}

/**
 * Turn persistent visitor tracking on or off. Turning it off also purges any
 * id already stored — an opt-out that leaves the identifier behind is not one.
 */
export function setVisitorTracking(nextEnabled: boolean): void {
	enabled = nextEnabled
	if (nextEnabled) return
	cached = undefined
	persisted = false
	mintedThisLoad = false
	try {
		window.localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Nothing to purge if storage is unavailable.
	}
}

/** Test seam — drops the memoized id without touching storage. */
export function resetVisitorCacheForTests(): void {
	cached = undefined
	persisted = false
	mintedThisLoad = false
	enabled = true
}
