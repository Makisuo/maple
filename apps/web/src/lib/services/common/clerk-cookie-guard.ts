/**
 * Guard against cross-environment Clerk cookie collisions.
 *
 * Every deployed Maple environment lives on a subdomain of the same
 * registrable domain (`app.maple.dev`, `staging.maple.dev`,
 * `app-pr-<n>.maple.dev`, …), but they do NOT share one Clerk instance:
 * production runs the production Clerk instance (FAPI at `clerk.maple.dev`)
 * while PR previews and staging run the development instance. ClerkJS writes
 * its `__client_uat` cookies (both the shared legacy name and the
 * per-instance `__client_uat_<suffix>` variant) on the eTLD+1 —
 * `Domain=maple.dev` — so each instance sees, and fights over, the other
 * instance's session-state hint. When the hint disagrees with the local
 * session, ClerkJS starts a handshake against its Frontend API, which the
 * "wrong" instance answers with transient 403s / redirect loops. Clerk
 * documents this limitation: independent environments must not share the
 * production application's domain, even on separate subdomains.
 *
 * Until preview/staging move to their own registrable domain, this guard
 * runs before ClerkJS initializes and deletes any parent-domain
 * `__client_uat*` cookie that does not belong to the current deployment's
 * Clerk instance (plus the un-suffixed legacy cookie, which the instances
 * overwrite with conflicting values — ClerkJS re-syncs it for the active
 * instance on its next write). Host-only cookies (`__session`,
 * `__clerk_db_jwt`) never leak across environments and are left alone.
 */

const CLIENT_UAT_PREFIX = "__client_uat"

/**
 * Clerk's per-instance cookie suffix: base64url(sha1(publishableKey)),
 * first 8 chars — mirrors `getCookieSuffix` in @clerk/shared.
 */
export async function computeClerkCookieSuffix(
	publishableKey: string,
	subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
	const digest = await subtle.digest("SHA-1", new TextEncoder().encode(publishableKey))
	const bytes = Array.from(new Uint8Array(digest))
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.substring(0, 8)
}

/**
 * Given all visible cookie names, return the `__client_uat*` cookies that do
 * not belong to the instance identified by `ownSuffix`: every foreign
 * `__client_uat_<other>` plus the shared legacy `__client_uat`.
 */
export function foreignClientUatCookieNames(cookieNames: readonly string[], ownSuffix: string): string[] {
	return cookieNames.filter((name) => {
		if (name === CLIENT_UAT_PREFIX) return true
		if (!name.startsWith(`${CLIENT_UAT_PREFIX}_`)) return false
		return name.slice(CLIENT_UAT_PREFIX.length + 1) !== ownSuffix
	})
}

/**
 * Candidate `Domain=` attributes a parent-domain cookie could have been set
 * with: the host itself and every parent with at least two labels
 * (`app-pr-1.maple.dev` → [`app-pr-1.maple.dev`, `maple.dev`]). Deleting a
 * cookie requires matching its domain attribute, and we cannot read it, so
 * we expire the name across all candidates.
 */
export function cookieDomainCandidates(hostname: string): string[] {
	const labels = hostname.split(".")
	const candidates: string[] = []
	for (let i = 0; i < labels.length - 1; i++) {
		candidates.push(labels.slice(i).join("."))
	}
	return candidates.length > 0 ? candidates : [hostname]
}

function parseCookieNames(cookieHeader: string): string[] {
	return cookieHeader
		.split(";")
		.map((part) => part.split("=")[0]?.trim() ?? "")
		.filter((name) => name.length > 0)
}

/**
 * Delete foreign-instance `__client_uat*` cookies before ClerkJS boots.
 * Never throws — auth must not be blocked by the cleanup.
 */
export async function purgeForeignClerkCookies(publishableKey: string): Promise<void> {
	try {
		if (typeof document === "undefined") return
		const ownSuffix = await computeClerkCookieSuffix(publishableKey)
		const stale = foreignClientUatCookieNames(parseCookieNames(document.cookie), ownSuffix)
		if (stale.length === 0) return
		const expiry = "expires=Thu, 01 Jan 1970 00:00:00 GMT"
		for (const name of stale) {
			// Host-only variant plus every possible Domain= attribute.
			document.cookie = `${name}=;path=/;${expiry}`
			for (const domain of cookieDomainCandidates(window.location.hostname)) {
				document.cookie = `${name}=;path=/;domain=${domain};${expiry}`
			}
		}
	} catch (error) {
		// Best-effort: a failed purge just means the pre-existing (broken)
		// behavior — never block app boot on it. But a permanently-failing purge
		// (e.g. `crypto.subtle` missing on an insecure origin) reproduces exactly
		// the 403/redirect loop this guard exists to prevent, so leave a
		// breadcrumb instead of failing silently.
		console.warn("[clerk-cookie-guard] failed to purge foreign __client_uat cookies", error)
	}
}
