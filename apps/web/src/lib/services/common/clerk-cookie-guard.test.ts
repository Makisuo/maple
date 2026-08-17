// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app-pr-246.maple.dev/" }

import { afterEach, describe, expect, it, vi } from "vitest"
import {
	computeClerkCookieSuffix,
	cookieDomainCandidates,
	foreignClientUatCookieNames,
	purgeForeignClerkCookies,
} from "./clerk-cookie-guard"

/** The production key, whose instance suffix is `Gu_OZvPU` (see the test below). */
const PROD_KEY = "pk_live_Y2xlcmsubWFwbGUuZGV2JA"
const EXPIRY = "expires=Thu, 01 Jan 1970 00:00:00 GMT"

/**
 * Shadow `document.cookie` with an own accessor: the getter serves the seeded
 * jar, the setter records the write instead of applying it (jsdom would silently
 * drop a `domain=` that does not match the test URL, which is exactly the
 * behavior under test).
 */
const stubCookieJar = (seeded: string) => {
	const writes: string[] = []
	Object.defineProperty(document, "cookie", {
		configurable: true,
		get: () => seeded,
		set: (value: string) => {
			writes.push(value)
		},
	})
	return writes
}

afterEach(() => {
	// Drop the own property so `document.cookie` falls back to jsdom's.
	delete (document as { cookie?: unknown }).cookie
	vi.restoreAllMocks()
})

describe("computeClerkCookieSuffix", () => {
	it("matches ClerkJS's suffix for the production publishable key", async () => {
		// Observed in the wild: prod (`pk_live_Y2xlcmsubWFwbGUuZGV2JA`, FAPI
		// clerk.maple.dev) writes `__client_uat_Gu_OZvPU` on Domain=maple.dev.
		await expect(computeClerkCookieSuffix("pk_live_Y2xlcmsubWFwbGUuZGV2JA")).resolves.toBe("Gu_OZvPU")
	})
})

describe("foreignClientUatCookieNames", () => {
	it("keeps the own-instance suffixed cookie, drops foreign and legacy ones", () => {
		const names = [
			"__client_uat",
			"__client_uat_Gu_OZvPU",
			"__client_uat_lpBWIqOU",
			"__session",
			"__clerk_db_jwt",
			"clerk_active_context",
		]
		expect(foreignClientUatCookieNames(names, "lpBWIqOU")).toEqual([
			"__client_uat",
			"__client_uat_Gu_OZvPU",
		])
	})

	it("returns nothing when only own-instance cookies exist", () => {
		expect(foreignClientUatCookieNames(["__client_uat_lpBWIqOU", "__session"], "lpBWIqOU")).toEqual([])
	})
})

describe("cookieDomainCandidates", () => {
	it("walks from the host up to the two-label parent", () => {
		expect(cookieDomainCandidates("app-pr-246.maple.dev")).toEqual(["app-pr-246.maple.dev", "maple.dev"])
		expect(cookieDomainCandidates("app.maple.dev")).toEqual(["app.maple.dev", "maple.dev"])
	})

	it("handles single-label hosts", () => {
		expect(cookieDomainCandidates("localhost")).toEqual(["localhost"])
	})
})

describe("purgeForeignClerkCookies", () => {
	it("expires each stale cookie host-only and on every candidate domain", async () => {
		expect(window.location.hostname).toBe("app-pr-246.maple.dev")
		const writes = stubCookieJar(
			"__client_uat_lpBWIqOU=1; __client_uat=2; __session=abc; __clerk_db_jwt=xyz",
		)

		await purgeForeignClerkCookies(PROD_KEY)

		// The dev instance's suffixed cookie plus the shared legacy name — the
		// own-instance (`Gu_OZvPU`) and host-only cookies are left alone. The
		// domain attribute cannot be read back, so each name is expired across
		// every domain it could have been set with.
		expect(writes).toEqual([
			`__client_uat_lpBWIqOU=;path=/;${EXPIRY}`,
			`__client_uat_lpBWIqOU=;path=/;domain=app-pr-246.maple.dev;${EXPIRY}`,
			`__client_uat_lpBWIqOU=;path=/;domain=maple.dev;${EXPIRY}`,
			`__client_uat=;path=/;${EXPIRY}`,
			`__client_uat=;path=/;domain=app-pr-246.maple.dev;${EXPIRY}`,
			`__client_uat=;path=/;domain=maple.dev;${EXPIRY}`,
		])
		expect(writes.some((write) => write.includes("Gu_OZvPU"))).toBe(false)
		expect(writes.some((write) => write.startsWith("__session"))).toBe(false)
	})

	it("writes nothing when only own-instance and host-only cookies are present", async () => {
		const writes = stubCookieJar("__client_uat_Gu_OZvPU=1; __session=abc; __clerk_db_jwt=xyz")

		await purgeForeignClerkCookies(PROD_KEY)

		expect(writes).toEqual([])
	})

	it("resolves with a breadcrumb instead of rejecting when crypto.subtle throws", async () => {
		const writes = stubCookieJar("__client_uat_lpBWIqOU=1")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(() => {
			// What an insecure origin looks like — the failure mode this guard is
			// meant to prevent, so it must be logged, not swallowed or thrown.
			throw new Error("SubtleCrypto is unavailable on an insecure origin")
		})

		await expect(purgeForeignClerkCookies(PROD_KEY)).resolves.toBeUndefined()

		expect(writes).toEqual([])
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain("clerk-cookie-guard")
	})
})
