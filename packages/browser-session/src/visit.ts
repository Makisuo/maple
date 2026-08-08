/**
 * The billable unit: one *visit*, not one session record.
 *
 * ## Why this is not just the session
 *
 * `SessionId` lives in sessionStorage, which is scoped to one tab **and** one
 * origin. That is deliberate and load-bearing — `session_replays` is a
 * ReplacingMergeTree keyed `(OrgId, SessionId)` whose fields resolve by
 * `argMax(field, Version)` over the whole row, so two tabs or two origins
 * writing under one id would overwrite each other rather than merge (see
 * `visitor.ts`). It is also a terrible thing to charge for: a customer with four
 * tabs open was billed four times, and a visitor crossing from `example.com` to
 * `app.example.com` was billed twice, for one person doing one thing.
 *
 * So the storage identity stays per-tab and the *billing* identity is claimed
 * here, from the same cookie + localStorage pair the visitor id already uses —
 * the one store in this SDK that spans tabs and subdomains.
 *
 * ## Why the claim is a timestamp and not a flag
 *
 * The window has to match the session idle window exactly, or the two disagree
 * about how many things happened: a 30-minute idle rotation genuinely starts a
 * new visit and must re-bill, while a second tab opened one minute in must not.
 * Storing "when did the last claim happen" answers both from one value, and
 * needs no cleanup — a stale marker simply fails the window check.
 *
 * ## What this deliberately does not fix
 *
 * A browser with both stores blocked can't hold a claim, so every page load
 * re-claims and re-bills. That is not fixable from here; the metadata row
 * carries `maple.visitor.persisted: "false"` so the size of that tail is
 * measurable rather than assumed.
 */

import { cookieDomain, readRawCookie, setRawCookie } from "./cookie"
import { IDLE_TIMEOUT_MS } from "./session"

const STORAGE_KEY = "maple.visit"
/** Cookie names cannot contain `.` per RFC 6265's token grammar. */
const COOKIE_NAME = "maple_visit"

/**
 * In-memory fallback, and the reason a single page load never double-claims even
 * with both stores blocked.
 */
let ephemeral: number | undefined

function parseClaim(raw: string | undefined): number | undefined {
	if (!raw) return undefined
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) ? parsed : undefined
}

function readClaim(): number | undefined {
	// Cookie first, for the same reason the visitor id prefers it: it is the copy
	// shared across subdomains, so the app sees the claim the marketing site made.
	const fromCookie = parseClaim(readRawCookie(COOKIE_NAME))
	if (fromCookie !== undefined) return fromCookie
	try {
		const fromStorage = parseClaim(window.localStorage.getItem(STORAGE_KEY) ?? undefined)
		if (fromStorage !== undefined) return fromStorage
	} catch {
		// Storage blocked — fall through to the in-memory copy.
	}
	return ephemeral
}

function writeClaim(now: number): void {
	ephemeral = now
	const value = String(now)
	try {
		window.localStorage.setItem(STORAGE_KEY, value)
	} catch {
		// Private mode / quota — the cookie and the in-memory copy still stand.
	}
	// Max-age is the window itself: an expired claim is indistinguishable from no
	// claim, so letting the browser drop it saves us the staleness check.
	setRawCookie(COOKIE_NAME, value, cookieDomain(), IDLE_TIMEOUT_MS / 1000)
}

/**
 * Claim this visit for billing, returning whether the claim was ours to make.
 *
 * `true` at most once per `IDLE_TIMEOUT_MS` across every tab and subdomain the
 * cookie reaches. Every caller that gets `false` is a session that is real,
 * stored, and queryable — just not separately charged.
 */
export function claimVisit(now = Date.now()): boolean {
	if (typeof window === "undefined") return false
	const last = readClaim()
	if (last !== undefined && now - last < IDLE_TIMEOUT_MS && now >= last) return false
	writeClaim(now)
	return true
}

/** Test seam — drops the in-memory claim without touching storage. */
export function resetVisitClaimForTests(): void {
	ephemeral = undefined
}
