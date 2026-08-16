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
			const stale = bearerExpiringIn(600)
			const fresh = bearerExpiringIn(600).replace("signature", "signature-after-switch")
			let call = 0
			setMapleAuthHeadersProvider(async () => {
				call += 1
				if (call === 1) {
					await gate
					return { authorization: stale }
				}
				return { authorization: fresh }
			})

			const pending = getMapleAuthHeaders()
			setActiveOrgId("org_switched_mid_flight")
			release?.()

			// The in-flight token belonged to the previous org — it must reach
			// neither the caller nor the cache for the new one.
			await expect(pending).resolves.toEqual({ authorization: fresh })
			await expect(getMapleAuthHeaders()).resolves.toEqual({ authorization: fresh })
		})

		it("never hands a caller the token of an identity it did not start under", async () => {
			let release: (() => void) | undefined
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const first = bearerExpiringIn(600)
			const second = bearerExpiringIn(600).replace("signature", "signature-second-org")
			let call = 0
			setMapleAuthHeadersProvider(async () => {
				call += 1
				if (call === 1) {
					await gate
					return { authorization: first }
				}
				return { authorization: second }
			})

			// Opens the refresh that belongs to the first org.
			const beforeSwitch = getMapleAuthHeaders()
			setActiveOrgId("org_second")
			// Arrives after the switch: it used to join the open promise and send the
			// first org's bearer, which the API resolves against the wrong tenant.
			const afterSwitch = getMapleAuthHeaders()
			release?.()

			await expect(afterSwitch).resolves.toEqual({ authorization: second })
			// The caller that started before the switch also re-resolves rather than
			// returning a token for an org the user has left.
			await expect(beforeSwitch).resolves.toEqual({ authorization: second })
		})

		it("lets a straggling refresh settle without evicting its successor", async () => {
			let releaseFirst: (() => void) | undefined
			const gate = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			const second = bearerExpiringIn(600)
			let call = 0
			setMapleAuthHeadersProvider(async () => {
				call += 1
				if (call === 1) {
					await gate
					return { authorization: bearerExpiringIn(600) }
				}
				return { authorization: second }
			})

			const orphaned = getMapleAuthHeaders()
			setActiveOrgId("org_second")
			const successor = getMapleAuthHeaders()
			releaseFirst?.()
			await Promise.all([orphaned, successor])

			// The straggler's `finally` must not clear the successor's slot, and the
			// cache must hold the current identity's token.
			expect(hasCachedMapleAuthToken()).toBe(true)
			await expect(getMapleAuthHeaders()).resolves.toEqual({ authorization: second })
			expect(call).toBe(2)
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
