import type { HttpServerRequest } from "effect/unstable/http"
import { assert, describe, it } from "@effect/vitest"
import { isTrustedCallbackOrigin, resolveRequestOrigin } from "./integrations.http"

/**
 * `resolveRequestOrigin` is a pure header/url function, so it is tested with a
 * minimal structural fake — it only reads `headers` and `url`.
 */
const fakeRequest = (
	headers: Record<string, string | undefined>,
	url = "/v2/integrations/slack/install",
): HttpServerRequest.HttpServerRequest => ({ headers, url }) as HttpServerRequest.HttpServerRequest

/**
 * The resolver is UNTRUSTED by design: `x-forwarded-host` is client-supplied on
 * any path that does not strip it, so these cases pin what the resolver *reads*,
 * not what the OAuth flow is allowed to use. `isTrustedCallbackOrigin` (below)
 * is the security boundary — every one of these origins still has to clear it.
 */
describe("resolveRequestOrigin (untrusted — reflects client-controlled headers)", () => {
	it("reflects x-forwarded-host and x-forwarded-proto when both are present", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({
				"x-forwarded-host": "api.maple.dev",
				"x-forwarded-proto": "https",
				host: "internal:8787",
			}),
		)
		assert.strictEqual(origin, "https://api.maple.dev")
	})

	it("prefers the forwarded host over the direct host header — including a spoofed one", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "public.example.com", host: "10.0.0.5:8080" }),
		)
		// Reflected, not accepted: `isTrustedCallbackOrigin` rejects this origin.
		assert.strictEqual(origin, "https://public.example.com")
	})

	it("respects a forwarded proto of http even for a non-localhost host", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "api.maple.dev", "x-forwarded-proto": "http" }),
		)
		assert.strictEqual(origin, "http://api.maple.dev")
	})

	it("falls back to the host header and defaults to https for non-local hosts", () => {
		const origin = resolveRequestOrigin(fakeRequest({ host: "api.maple.dev" }))
		assert.strictEqual(origin, "https://api.maple.dev")
	})

	it("defaults to http for localhost and 127.* hosts, preserving the port", () => {
		assert.strictEqual(
			resolveRequestOrigin(fakeRequest({ host: "localhost:3472" })),
			"http://localhost:3472",
		)
		assert.strictEqual(
			resolveRequestOrigin(fakeRequest({ host: "127.0.0.1:3472" })),
			"http://127.0.0.1:3472",
		)
		assert.strictEqual(resolveRequestOrigin(fakeRequest({ host: "localhost" })), "http://localhost")
	})

	it("preserves an explicit port on a non-local host", () => {
		const origin = resolveRequestOrigin(fakeRequest({ host: "api.staging.maple.dev:8443" }))
		assert.strictEqual(origin, "https://api.staging.maple.dev:8443")
	})

	it("falls back to parsing an absolute request url when no host headers exist", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({}, "https://api.example.com:8443/v2/integrations/slack"),
		)
		assert.strictEqual(origin, "https://api.example.com:8443")
	})

	it("returns an empty origin when no host is known and the url is relative", () => {
		const origin = resolveRequestOrigin(fakeRequest({}, "/v2/integrations/slack/install"))
		assert.strictEqual(origin, "")
	})
})

/**
 * The security boundary for the Slack OAuth callback origin. The resolved origin
 * is embedded in the authorize URL, persisted as `oauth_auth_states.redirectUri`
 * and replayed as `redirect_uri` in the token exchange, so an attacker-chosen
 * host would mint an authorize URL pointing at their own callback. Only hosts in
 * the same family as the trusted `MAPLE_APP_BASE_URL` are accepted; everything
 * else fails closed (the install handler answers 503).
 */
describe("isTrustedCallbackOrigin", () => {
	it("accepts sibling hosts under the same registrable domain, per stage", () => {
		for (const [origin, appBaseUrl] of [
			["https://api.maple.dev", "https://app.maple.dev"],
			["https://api-staging.maple.dev", "https://staging.maple.dev"],
			["https://api-pr-12.maple.dev", "https://app-pr-12.maple.dev"],
		] as const) {
			assert.isTrue(isTrustedCallbackOrigin(origin, appBaseUrl), `${origin} vs ${appBaseUrl}`)
		}
	})

	it("accepts the local-dev family: *.localhost siblings and loopback ports", () => {
		for (const [origin, appBaseUrl] of [
			["https://api.localhost", "https://web.localhost"],
			// Worktree dev hosts nest another label under *.localhost.
			["https://wt.api.localhost", "https://wt.web.localhost"],
			// `bun dev:app` serves web and api on different loopback ports.
			["http://127.0.0.1:3472", "http://127.0.0.1:3471"],
		] as const) {
			assert.isTrue(isTrustedCallbackOrigin(origin, appBaseUrl), `${origin} vs ${appBaseUrl}`)
		}
	})

	it("rejects a spoofed forwarded host and every other foreign origin", () => {
		for (const [origin, appBaseUrl] of [
			// The spoof case: exactly what `resolveRequestOrigin` hands back for a
			// request carrying `x-forwarded-host: public.example.com`.
			["https://public.example.com", "https://app.maple.dev"],
			["https://evil.dev", "https://app.maple.dev"],
			// A suffix-only lookalike must not match the trusted parent domain.
			["https://api.maple.dev.evil.com", "https://app.maple.dev"],
			// No host at all (relative url, no host headers).
			["", "https://app.maple.dev"],
			// Local dev and deployed hosts are separate families in both directions.
			["https://evil.localhost", "https://app.maple.dev"],
			["https://api.maple.dev", "http://127.0.0.1:3471"],
		] as const) {
			assert.isFalse(isTrustedCallbackOrigin(origin, appBaseUrl), `${origin} vs ${appBaseUrl}`)
		}
	})
})
