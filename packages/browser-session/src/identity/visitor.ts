import * as Schema from "effect/Schema"

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

const VisitorRecordFromJson = Schema.fromJsonString(
	Schema.Struct({ id: Schema.String, mintedAt: Schema.Number }),
)

let enabled = true
/** Memoized so the hot path never re-reads storage. */
let cached: VisitorRecord | undefined
let persisted = false
let mintedThisLoad = false

/** Scope the cookie to the registered domain so subdomains share the id. */
let crossSubdomainCookie = true
/** Explicit `Domain=` override; `""` forces a host-only cookie. */
let cookieDomainOverride: string | undefined
/** Memoized probe result. `undefined` = not resolved yet. */
let probedCookieDomain: string | undefined

/**
 * Apply the host app's cookie configuration. Called from `configurePrivacy`, so
 * both SDKs get it from the single call they already make.
 *
 * Like the consent gates, this only ever *tightens*: an app that initializes two
 * SDKs, only one of which passes a `privacy` block, must not have the other's
 * absent option widen the cookie back out to every subdomain.
 *
 * "Tighter" for `cookieDomain` means *narrower scope*, which is why this is not
 * first-write-wins: `""` (host-only) is the tightest value there is, and a
 * second SDK asking for it has to win over an earlier `"example.com"`. Between
 * two non-empty domains the shorter one is the broader — `example.com` covers
 * `app.example.com` and not the reverse — so the longer string wins.
 */
export function configureVisitorCookie(options: {
	readonly crossSubdomainCookie?: boolean | undefined
	readonly cookieDomain?: string | undefined
}): void {
	if (options.crossSubdomainCookie === false) crossSubdomainCookie = false
	if (options.cookieDomain !== undefined) {
		cookieDomainOverride = tighterCookieDomain(cookieDomainOverride, options.cookieDomain)
	}
	probedCookieDomain = undefined
}

/** The narrower of two `Domain=` values, treating `undefined` as "unset". */
function tighterCookieDomain(current: string | undefined, next: string): string {
	if (current === undefined) return next
	// Host-only beats any domain-scoped cookie, whichever side asked for it.
	if (current === "" || next === "") return ""
	return next.length > current.length ? next : current
}

function readRawCookie(name: string): string | undefined {
	if (typeof document === "undefined") return undefined
	try {
		for (const part of document.cookie.split(";")) {
			const raw = part.trim()
			if (!raw.startsWith(`${name}=`)) continue
			return decodeURIComponent(raw.slice(name.length + 1))
		}
	} catch {
		// Cookies disabled entirely — indistinguishable from "not set".
	}
	return undefined
}

function setRawCookie(name: string, value: string, domain: string, maxAgeSeconds: number): boolean {
	if (typeof document === "undefined") return false
	const attributes = [
		`${name}=${encodeURIComponent(value)}`,
		"path=/",
		`max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
		"SameSite=Lax",
	]
	if (domain) attributes.push(`domain=.${domain}`)
	// A `Secure` cookie is rejected over http, which is exactly the local-dev case.
	if (typeof location !== "undefined" && location.protocol === "https:") attributes.push("Secure")
	try {
		document.cookie = attributes.join("; ")
		return true
	} catch {
		return false
	}
}

/**
 * The broadest domain this browser will actually accept a cookie for, found by
 * probing rather than by carrying a public-suffix list — the same trick
 * posthog-js uses. Candidates start at the broadest (the last two labels) and
 * narrow a label at a time, with the first that sticks winning — so
 * `app.example.co.uk` tries the rejected `co.uk`, then lands on `example.co.uk`.
 *
 * Returns `""` (host-only cookie) for single-label hosts like `localhost` and
 * for bare IPs, neither of which can carry a `Domain=` attribute.
 */
function probeCookieDomain(): string {
	if (typeof document === "undefined" || typeof location === "undefined") return ""
	const hostname = location.hostname
	if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return ""
	const parts = hostname.split(".")
	if (parts.length < 2) return ""
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = parts.slice(i).join(".")
		const probe = "__maple_probe"
		if (setRawCookie(probe, "1", candidate, 60) && readRawCookie(probe) === "1") {
			setRawCookie(probe, "", candidate, 0)
			return candidate
		}
	}
	return ""
}

function cookieDomain(): string {
	if (cookieDomainOverride !== undefined) return cookieDomainOverride
	if (!crossSubdomainCookie) return ""
	if (probedCookieDomain === undefined) probedCookieDomain = probeCookieDomain()
	return probedCookieDomain
}

function parseRecord(raw: string | undefined): VisitorRecord | undefined {
	if (!raw) return undefined
	try {
		const parsed = Schema.decodeUnknownSync(VisitorRecordFromJson)(raw)
		if (Date.now() - parsed.mintedAt > MAX_AGE_MS) return undefined
		return parsed
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
	crossSubdomainCookie = true
	cookieDomainOverride = undefined
	probedCookieDomain = undefined
}
