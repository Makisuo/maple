import type { HttpServerRequest } from "effect/unstable/http"
import { assert, describe, it } from "@effect/vitest"
import { resolveRequestOrigin } from "./integrations.http"

/**
 * `resolveRequestOrigin` is a pure header/url function, so it is tested with a
 * minimal structural fake — it only reads `headers` and `url`.
 */
const fakeRequest = (
	headers: Record<string, string | undefined>,
	url = "/v2/integrations/slack/install",
): HttpServerRequest.HttpServerRequest =>
	({ headers, url }) as unknown as HttpServerRequest.HttpServerRequest

describe("resolveRequestOrigin", () => {
	it("uses x-forwarded-host and x-forwarded-proto when both are present", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "api.maple.dev", "x-forwarded-proto": "https", host: "internal:8787" }),
		)
		assert.strictEqual(origin, "https://api.maple.dev")
	})

	it("prefers the forwarded host over the direct host header", () => {
		const origin = resolveRequestOrigin(
			fakeRequest({ "x-forwarded-host": "public.example.com", host: "10.0.0.5:8080" }),
		)
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
		assert.strictEqual(resolveRequestOrigin(fakeRequest({ host: "localhost:3472" })), "http://localhost:3472")
		assert.strictEqual(resolveRequestOrigin(fakeRequest({ host: "127.0.0.1:3472" })), "http://127.0.0.1:3472")
		assert.strictEqual(resolveRequestOrigin(fakeRequest({ host: "localhost" })), "http://localhost")
	})

	it("preserves an explicit port on a non-local host", () => {
		const origin = resolveRequestOrigin(fakeRequest({ host: "api.staging.maple.dev:8443" }))
		assert.strictEqual(origin, "https://api.staging.maple.dev:8443")
	})

	it("falls back to parsing an absolute request url when no host headers exist", () => {
		const origin = resolveRequestOrigin(fakeRequest({}, "https://api.example.com:8443/v2/integrations/slack"))
		assert.strictEqual(origin, "https://api.example.com:8443")
	})

	it("returns an empty origin when no host is known and the url is relative", () => {
		const origin = resolveRequestOrigin(fakeRequest({}, "/v2/integrations/slack/install"))
		assert.strictEqual(origin, "")
	})
})
