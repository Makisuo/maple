import { describe, expect, it } from "vitest"
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { API_CORS_OPTIONS, API_CORS_RESPONSE_HEADERS, apiCorsPreflightResponse } from "./api-cors"

describe("apiCorsPreflightResponse", () => {
	it("answers preflights with the global API CORS contract", async () => {
		const response = apiCorsPreflightResponse()

		expect(response.status).toBe(204)
		expect(await response.text()).toBe("")
		expect(response.headers.get("access-control-allow-origin")).toBe(
			API_CORS_RESPONSE_HEADERS["access-control-allow-origin"],
		)
		expect(response.headers.get("vary")).toBe(API_CORS_RESPONSE_HEADERS.vary)
		expect(response.headers.get("access-control-allow-methods")).toBe(
			API_CORS_OPTIONS.allowedMethods.join(", "),
		)
		expect(response.headers.get("access-control-allow-headers")).toBe(
			API_CORS_OPTIONS.allowedHeaders.join(","),
		)
		expect(response.headers.get("access-control-expose-headers")).toBe(
			API_CORS_RESPONSE_HEADERS["access-control-expose-headers"],
		)
		expect(response.headers.get("access-control-max-age")).toBe(String(API_CORS_OPTIONS.maxAge))
	})

	it("stays byte-equivalent to Effect's configured CORS middleware", async () => {
		const probe = HttpRouter.use((router) =>
			router.add("GET", "/probe", HttpServerResponse.text("probe")),
		).pipe(Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)))
		const { handler, dispose } = HttpRouter.toWebHandler(probe, { disableLogger: true })
		try {
			const request = new Request("https://api.example/probe", {
				method: "OPTIONS",
				headers: {
					origin: "https://app.maple.dev",
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization,content-type",
				},
			})
			const [fast, effect] = await Promise.all([
				Promise.resolve(apiCorsPreflightResponse()),
				handler(request),
			])

			expect(fast.status).toBe(effect.status)
			expect([...fast.headers]).toEqual([...effect.headers])
			expect(await fast.text()).toBe(await effect.text())
		} finally {
			await dispose()
		}
	})
})
