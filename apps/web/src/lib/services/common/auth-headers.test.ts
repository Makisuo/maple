import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	clearMapleAuthHeaders,
	getMapleAuthHeaders,
	hasCachedMapleAuthToken,
	invalidateMapleAuthToken,
	setActiveOrgId,
	setMapleAuthHeaders,
	setMapleAuthHeadersProvider,
} from "./auth-headers"

/** A bearer JWT whose `exp` is `secondsFromNow` in the future. */
const bearerExpiringIn = (secondsFromNow: number): string => {
	const claims = { exp: Math.floor(Date.now() / 1000) + secondsFromNow }
	const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
	return `Bearer header.${payload}.signature`
}

describe("auth-headers", () => {
	beforeEach(() => {
		setMapleAuthHeadersProvider(undefined)
		clearMapleAuthHeaders()
		setActiveOrgId(null)
		invalidateMapleAuthToken()
	})

	it("injects dynamic async auth headers", async () => {
		setMapleAuthHeadersProvider(async () => ({
			authorization: "Bearer clerk-session-token",
		}))

		await expect(getMapleAuthHeaders()).resolves.toEqual({
			authorization: "Bearer clerk-session-token",
		})
	})

	it("keeps static header override compatibility", async () => {
		setMapleAuthHeaders({
			"x-maple-org-id": "org_local",
			"x-maple-user-id": "user_local",
		})

		await expect(getMapleAuthHeaders()).resolves.toEqual({
			"x-maple-org-id": "org_local",
			"x-maple-user-id": "user_local",
		})
	})

	it("clears static headers when requested", async () => {
		setMapleAuthHeaders({
			authorization: "Bearer stale-token",
		})

		clearMapleAuthHeaders()

		await expect(getMapleAuthHeaders()).resolves.toEqual({})
	})

	describe("bearer token cache", () => {
		it("resolves a long-lived JWT once and serves the rest from cache", async () => {
			const authorization = bearerExpiringIn(600)
			const provider = vi.fn(async () => ({ authorization }))
			setMapleAuthHeadersProvider(provider)

			await expect(getMapleAuthHeaders()).resolves.toEqual({ authorization })
			await expect(getMapleAuthHeaders()).resolves.toEqual({ authorization })
			await expect(getMapleAuthHeaders()).resolves.toEqual({ authorization })

			expect(provider).toHaveBeenCalledTimes(1)
			expect(hasCachedMapleAuthToken()).toBe(true)
		})

		it("collapses a concurrent burst into one provider call", async () => {
			const provider = vi.fn(async () => ({ authorization: bearerExpiringIn(600) }))
			setMapleAuthHeadersProvider(provider)

			await Promise.all([getMapleAuthHeaders(), getMapleAuthHeaders(), getMapleAuthHeaders()])

			expect(provider).toHaveBeenCalledTimes(1)
		})

		it("re-resolves a token inside the expiry skew window", async () => {
			// 5s of life left is under TOKEN_MIN_REMAINING_MS, so it must not be served.
			const provider = vi.fn(async () => ({ authorization: bearerExpiringIn(5) }))
			setMapleAuthHeadersProvider(provider)

			await getMapleAuthHeaders()
			await getMapleAuthHeaders()

			expect(provider).toHaveBeenCalledTimes(2)
		})

		it("never caches an opaque (non-JWT) token", async () => {
			const provider = vi.fn(async () => ({ authorization: "Bearer opaque-self-hosted-token" }))
			setMapleAuthHeadersProvider(provider)

			await getMapleAuthHeaders()
			await getMapleAuthHeaders()

			expect(provider).toHaveBeenCalledTimes(2)
			expect(hasCachedMapleAuthToken()).toBe(false)
		})

		it("drops the cached token on org switch, so no request carries the old org", async () => {
			const provider = vi.fn(async () => ({ authorization: bearerExpiringIn(600) }))
			setMapleAuthHeadersProvider(provider)
			await getMapleAuthHeaders()
			expect(provider).toHaveBeenCalledTimes(1)

			setActiveOrgId("org_second")

			expect(hasCachedMapleAuthToken()).toBe(false)
			await getMapleAuthHeaders()
			expect(provider).toHaveBeenCalledTimes(2)
		})

		it("discards a refresh that resolves after the identity changed", async () => {
			let release: (() => void) | undefined
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			setMapleAuthHeadersProvider(async () => {
				await gate
				return { authorization: bearerExpiringIn(600) }
			})

			const pending = getMapleAuthHeaders()
			setActiveOrgId("org_switched_mid_flight")
			release?.()
			await pending

			// The in-flight token belonged to the previous org — it must not populate
			// the cache for the new one.
			expect(hasCachedMapleAuthToken()).toBe(false)
		})

		it("drops the cached token on sign-out", async () => {
			setMapleAuthHeadersProvider(async () => ({ authorization: bearerExpiringIn(600) }))
			await getMapleAuthHeaders()
			expect(hasCachedMapleAuthToken()).toBe(true)

			setMapleAuthHeadersProvider(undefined)
			clearMapleAuthHeaders()

			expect(hasCachedMapleAuthToken()).toBe(false)
			await expect(getMapleAuthHeaders()).resolves.toEqual({})
		})
	})
})
