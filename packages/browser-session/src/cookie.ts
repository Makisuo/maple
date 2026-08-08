/**
 * First-party cookie plumbing, and the one decision every cookie this SDK writes
 * has to agree on: which `Domain=` they are scoped to.
 *
 * Extracted from `visitor.ts` when a second consumer appeared. `visit.ts` needs
 * the *same* domain the visitor id uses — a visit claim written host-only while
 * the visitor id spans subdomains would silently stop deduplicating exactly
 * where it matters most, on the marketing-site → app hop. Sharing the probe is
 * what keeps the two from drifting.
 */

/** Scope cookies to the registered domain so subdomains share them. */
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
export function configureCookieScope(options: {
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

export function readRawCookie(name: string): string | undefined {
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

export function setRawCookie(name: string, value: string, domain: string, maxAgeSeconds: number): boolean {
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

export function cookieDomain(): string {
	if (cookieDomainOverride !== undefined) return cookieDomainOverride
	if (!crossSubdomainCookie) return ""
	if (probedCookieDomain === undefined) probedCookieDomain = probeCookieDomain()
	return probedCookieDomain
}

/** Test seam — drops the memoized domain and any configured scope. */
export function resetCookieScopeForTests(): void {
	crossSubdomainCookie = true
	cookieDomainOverride = undefined
	probedCookieDomain = undefined
}
