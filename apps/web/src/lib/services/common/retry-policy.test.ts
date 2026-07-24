import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { isRetryableTransportError } from "./retry-policy"

const transportError = (request: HttpClientRequest.HttpClientRequest, cause?: unknown) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.TransportError({ request, cause }),
	})

describe("isRetryableTransportError", () => {
	it("retries transport failures on idempotent requests", () => {
		const error = transportError(HttpClientRequest.get("https://api.maple.dev/v1/services"))
		expect(isRetryableTransportError(error)).toBe(true)
	})

	it("never replays mutations", () => {
		const error = transportError(HttpClientRequest.post("https://api.maple.dev/v1/dashboards"))
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("does not multiply the client timeout", () => {
		const error = transportError(
			HttpClientRequest.get("https://api.maple.dev/v1/services"),
			new DOMException("timed out", "TimeoutError"),
		)
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("does not replay aborted requests", () => {
		const error = transportError(
			HttpClientRequest.get("https://api.maple.dev/v1/services"),
			new DOMException("aborted", "AbortError"),
		)
		expect(isRetryableTransportError(error)).toBe(false)
	})

	it("ignores non-HttpClientError values", () => {
		expect(isRetryableTransportError(new Error("Failed to fetch"))).toBe(false)
	})
})
