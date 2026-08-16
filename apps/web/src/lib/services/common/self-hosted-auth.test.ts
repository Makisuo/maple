// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMapleAuthHeaders, setMapleAuthHeadersProvider } from "./auth-headers"
import {
	clearSelfHostedSessionToken,
	getSelfHostedSessionToken,
	installSelfHostedAuthHeadersProvider,
	resolveSelfHostedRouterAuth,
	setSelfHostedSessionToken,
} from "./self-hosted-auth"

// A self-hosted session token, signature elided: the client only ever reads the
// payload's `exp`, and the signature it cannot check is the server's job.
const tokenExpiringInMs = (remainingMs: number, marker = "t"): string => {
	const claims = {
		sub: "root",
		org_id: "default",
		authMode: "self_hosted",
		marker,
		exp: Math.floor((Date.now() + remainingMs) / 1000),
	}
	return `header.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.signature`
}

describe("self-hosted-auth", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		window.sessionStorage.clear()
	})

	it("returns unauthenticated state when no token exists", async () => {
		const state = await resolveSelfHostedRouterAuth("http://localhost:3472")

		expect(state).toEqual({
			isAuthenticated: false,
			orgId: null,
		})
	})

	it("clears token and returns unauthenticated state for invalid token", async () => {
		setSelfHostedSessionToken("invalid-token")
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "Invalid session" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		)

		const state = await resolveSelfHostedRouterAuth("http://localhost:3472")

		expect(state).toEqual({
			isAuthenticated: false,
			orgId: null,
		})
		expect(getSelfHostedSessionToken()).toBeNull()
	})

	it("returns authenticated state for valid token", async () => {
		setSelfHostedSessionToken("valid-token")
		vi.spyOn(window, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					orgId: "default",
					userId: "root",
					roles: ["root"],
					authMode: "self_hosted",
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		)

		const state = await resolveSelfHostedRouterAuth("http://localhost:3472")

		expect(state).toEqual({
			isAuthenticated: true,
			orgId: "default",
		})
		expect(getSelfHostedSessionToken()).toBe("valid-token")
	})

	it("clears token from storage when requested", () => {
		setSelfHostedSessionToken("to-clear")
		clearSelfHostedSessionToken()

		expect(getSelfHostedSessionToken()).toBeNull()
	})
})

describe("self-hosted session renewal", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		window.sessionStorage.clear()
		installSelfHostedAuthHeadersProvider()
	})

	// The provider is reinstalled per test; drop it afterwards so the module-level
	// auth-headers cache does not carry a token into an unrelated suite. In
	// `afterEach` rather than at the end of each test so a failing assertion
	// cannot leak the provider into the next one.
	afterEach(() => setMapleAuthHeadersProvider(undefined))

	const refreshResponse = (token: string) =>
		new Response(JSON.stringify({ token, orgId: "default", userId: "root" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})

	it("serves a healthy token without contacting the server", async () => {
		const token = tokenExpiringInMs(60 * 60 * 1000, "healthy")
		setSelfHostedSessionToken(token)
		const fetchSpy = vi.spyOn(window, "fetch")

		expect(await getMapleAuthHeaders()).toEqual({ authorization: `Bearer ${token}` })
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("renews a token inside the renewal window and stores the replacement", async () => {
		const expiring = tokenExpiringInMs(60 * 1000, "renew-old")
		const renewed = tokenExpiringInMs(12 * 60 * 60 * 1000, "renew-new")
		setSelfHostedSessionToken(expiring)
		const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue(refreshResponse(renewed))

		expect(await getMapleAuthHeaders()).toEqual({ authorization: `Bearer ${renewed}` })
		expect(getSelfHostedSessionToken()).toBe(renewed)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/auth/session/refresh")
	})

	// A burst of requests all finding the same near-expiry token must produce one
	// renewal, not one per request.
	it("collapses concurrent renewals of the same token into a single request", async () => {
		setSelfHostedSessionToken(tokenExpiringInMs(60 * 1000, "concurrent-old"))
		const renewed = tokenExpiringInMs(12 * 60 * 60 * 1000, "concurrent-new")
		const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue(refreshResponse(renewed))

		const results = await Promise.all([
			getMapleAuthHeaders(),
			getMapleAuthHeaders(),
			getMapleAuthHeaders(),
		])

		for (const headers of results) {
			expect(headers).toEqual({ authorization: `Bearer ${renewed}` })
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	// The absolute session cap was reached, or the root password was rotated. The
	// session is over, so the token goes and the router gate sends them to sign-in.
	it("ends the session when renewal is rejected", async () => {
		setSelfHostedSessionToken(tokenExpiringInMs(60 * 1000, "rejected"))
		vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 401 }))

		expect(await getMapleAuthHeaders()).toEqual({})
		expect(getSelfHostedSessionToken()).toBeNull()
	})

	// An offline blip must not sign anyone out: the current token is still valid
	// for a few more minutes, so keep using it and retry on a later request.
	it("keeps the current token when renewal fails transiently", async () => {
		const expiring = tokenExpiringInMs(60 * 1000, "offline")
		setSelfHostedSessionToken(expiring)
		vi.spyOn(window, "fetch").mockRejectedValue(new Error("offline"))

		expect(await getMapleAuthHeaders()).toEqual({ authorization: `Bearer ${expiring}` })
		expect(getSelfHostedSessionToken()).toBe(expiring)
	})

	it("keeps the current token when renewal returns a server error", async () => {
		const expiring = tokenExpiringInMs(60 * 1000, "server-error")
		setSelfHostedSessionToken(expiring)
		vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 503 }))

		expect(await getMapleAuthHeaders()).toEqual({ authorization: `Bearer ${expiring}` })
		expect(getSelfHostedSessionToken()).toBe(expiring)
	})

	// Rollout: tokens minted before self-hosted sessions expired carry no `exp`.
	// There is no deadline to renew ahead of, so they are used as-is until the
	// server ages them out.
	it("uses a legacy token with no exp as-is rather than renewing it", async () => {
		setSelfHostedSessionToken("legacy-opaque-token")
		const fetchSpy = vi.spyOn(window, "fetch")

		expect(await getMapleAuthHeaders()).toEqual({ authorization: "Bearer legacy-opaque-token" })
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
