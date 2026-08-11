import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { isRetryableResponse, isRetryableTransportError, withMapleRetryPolicy } from "./retry-policy"

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

describe("isRetryableResponse", () => {
	const response = (request: HttpClientRequest.HttpClientRequest, status: number) =>
		HttpClientResponse.fromWeb(request, new Response(null, { status }))

	it.each([500, 502, 503])("retries transient %s responses for reads", (status) => {
		expect(
			isRetryableResponse(response(HttpClientRequest.get("https://api.maple.dev/v1/services"), status)),
		).toBe(true)
	})

	it.each([400, 401, 408, 429, 504])("does not hide actionable %s responses", (status) => {
		expect(
			isRetryableResponse(response(HttpClientRequest.get("https://api.maple.dev/v1/services"), status)),
		).toBe(false)
	})

	it("never replays a mutation response", () => {
		expect(
			isRetryableResponse(response(HttpClientRequest.post("https://api.maple.dev/v1/dashboards"), 503)),
		).toBe(false)
	})

	it("replays a raw transient response before API error decoding", async () => {
		let attempts = 0
		const client = withMapleRetryPolicy(
			HttpClient.make((request) =>
				Effect.sync(() => {
					attempts += 1
					return response(request, attempts === 1 ? 503 : 200)
				}),
			),
		)

		const result = await Effect.runPromise(client.get("https://api.maple.dev/v1/services"))
		expect(result.status).toBe(200)
		expect(attempts).toBe(2)
	})

	it("returns a mutation failure response without replaying it", async () => {
		let attempts = 0
		const client = withMapleRetryPolicy(
			HttpClient.make((request) =>
				Effect.sync(() => {
					attempts += 1
					return response(request, 503)
				}),
			),
		)

		const result = await Effect.runPromise(client.post("https://api.maple.dev/v1/dashboards"))
		expect(result.status).toBe(503)
		expect(attempts).toBe(1)
	})
})
