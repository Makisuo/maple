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
 *
 * ## Why two stores
 *
 * The id lives in **both** localStorage and a cookie, the same hybrid posthog-js
 * uses for its `localStorage+cookie` persistence:
 *
 * - localStorage is the durable copy. Safari's ITP caps the lifetime of any
 *   cookie set from `document.cookie` at 7 days, so a cookie alone would silently
 *   turn returning visitors into new ones every week.
 * - The cookie is the *cross-subdomain carrier*. localStorage is origin-scoped,
 *   so a marketing site on `example.com` and an app on `app.example.com` can
 *   never see each other's id; a cookie scoped to the registered domain can.
 *   That is what links an anonymous pre-signup visit to the account it becomes.
 *
 * Reads prefer the cookie and mirror the winner back, so an existing
 * localStorage-only visitor converges onto the shared id instead of being reset.
 *
 * ## What is deliberately *not* shared
 *
 * The **session** id stays origin-scoped (sessionStorage, `session.ts`). Unlike
 * PostHog, our `session_replays` table is a ReplacingMergeTree keyed
 * `(OrgId, SessionId)` whose fields resolve by `argMax(field, Version)` over the
 * whole row — two origins posting different ServiceName/EntryPath under one
 * session id would overwrite each other rather than merge. Sessions stay
 * per-surface; `VisitorId` is the join key between them.
 */

import {
	configureCookieScope,
	cookieDomain,
	readRawCookie,
	resetCookieScopeForTests,
	setRawCookie,
} from "./cookie"

const STORAGE_KEY = "maple.visitor"
/**
 * Cookie names cannot contain `.` per RFC 6265's token grammar, so this is not
 * simply `maple.visitor`.
 */
const COOKIE_NAME = "maple_visitor"

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

/**
 * Configure the cookie scope. Kept exported from here because `configurePrivacy`
 * and the SDK tests have always called it by this name; the implementation and
 * the domain probe now live in `cookie.ts`, shared with the visit claim.
 */
export const configureVisitorCookie = configureCookieScope

// --- Record read/write -----------------------------------------------------

function parseRecord(raw: string | undefined): VisitorRecord | undefined {
	if (!raw) return undefined
	try {
		const parsed = JSON.parse(raw) as Partial<VisitorRecord>
		if (typeof parsed.id !== "string" || typeof parsed.mintedAt !== "number") return undefined
		if (Date.now() - parsed.mintedAt > MAX_AGE_MS) return undefined
		return parsed as VisitorRecord
	} catch {
		return undefined
	}
}

function readFromStorage(): VisitorRecord | undefined {
	try {
		return parseRecord(window.localStorage.getItem(STORAGE_KEY) ?? undefined)
	} catch {
		return undefined
	}
}

function readFromCookie(): VisitorRecord | undefined {
	return parseRecord(readRawCookie(COOKIE_NAME))
}

function writeToStorage(record: VisitorRecord): boolean {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
		return true
	} catch {
		// Safari private mode / storage blocked.
		return false
	}
}

/**
 * Mirror the record into the cookie. The max-age is the id's *remaining* life,
 * not a fresh 400 days, so re-writing it on every page load can't turn the
 * expiry into a sliding window that never fires.
 */
function writeToCookie(record: VisitorRecord): boolean {
	const remainingMs = MAX_AGE_MS - (Date.now() - record.mintedAt)
	if (remainingMs <= 0) return false
	return setRawCookie(COOKIE_NAME, JSON.stringify(record), cookieDomain(), remainingMs / 1000)
}

function write(record: VisitorRecord): void {
	const inStorage = writeToStorage(record)
	const inCookie = writeToCookie(record)
	// The in-memory id still keeps every row from this page load consistent,
	// which beats sending '' — but with neither store it is not a real visitor
	// id, and `isVisitorIdPersisted()` says so.
	persisted = inStorage || inCookie
}

/**
 * The current visitor id, minting one on first use. `undefined` when visitor
 * tracking is off or outside a browser.
 */
export function getVisitorId(): string | undefined {
	if (!enabled || typeof window === "undefined") return undefined
	if (cached) return cached.id

	const fromCookie = readFromCookie()
	const fromStorage = readFromStorage()
	// The cookie wins: it is the copy shared across subdomains, so a visitor who
	// already has one on the marketing site keeps that identity in the app rather
	// than the app's older origin-local id.
	const existing = fromCookie ?? fromStorage
	if (existing) {
		cached = existing
		persisted = true
		// Converge the two stores on the winner. Best-effort — one of them already
		// holds the id, so a failure here doesn't make it any less persistent.
		if (!fromCookie) writeToCookie(existing)
		if (!fromStorage || fromStorage.id !== existing.id) writeToStorage(existing)
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
 * Whether the id actually survives this page load. `false` means both stores
 * were blocked and the id is in-memory only, so uniques would be over-counted;
 * the metadata row carries this as `maple.visitor.persisted` so the analytics
 * layer can flag it rather than quietly inflate.
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
	// Expire on both the shared domain and host-only: the cookie may have been
	// written before `configureVisitorCookie` narrowed the scope, and a delete
	// that misses the actual cookie is not a delete.
	const domain = cookieDomain()
	setRawCookie(COOKIE_NAME, "", domain, 0)
	if (domain) setRawCookie(COOKIE_NAME, "", "", 0)
}

/** Test seam — drops the memoized id without touching storage. */
export function resetVisitorCacheForTests(): void {
	cached = undefined
	persisted = false
	mintedThisLoad = false
	enabled = true
	resetCookieScopeForTests()
}
