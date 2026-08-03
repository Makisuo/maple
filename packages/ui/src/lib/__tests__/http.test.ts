import { describe, expect, it } from "vitest"

import { getHttpInfo, HTTP_METHOD_COLORS, HTTP_METHOD_HEX } from "../http"

describe("HTTP method colors", () => {
	it("keeps the Tailwind class map in sync with the hex source of truth", () => {
		// HTTP_METHOD_COLORS stays literal so Tailwind's JIT scanner sees the
		// class names; this test is what stops the two maps from drifting.
		expect(Object.keys(HTTP_METHOD_COLORS).sort()).toEqual(Object.keys(HTTP_METHOD_HEX).sort())
		for (const [method, hex] of Object.entries(HTTP_METHOD_HEX)) {
			expect(HTTP_METHOD_COLORS[method], method).toBe(`bg-[${hex}]`)
		}
	})
})

describe("getHttpInfo", () => {
	it("detects HTTP from standard attrs", () => {
		expect(
			getHttpInfo({
				spanName: "ignored",
				spanAttributes: {
					"http.method": "POST",
					"http.route": "/checkout",
					"http.status_code": "201",
				},
			}),
		).toEqual({
			method: "POST",
			route: "/checkout",
			statusCode: 201,
			isError: false,
			kind: "server",
		})
	})

	it("detects HTTP from semantic convention attrs", () => {
		expect(
			getHttpInfo({
				spanName: "ignored",
				spanAttributes: {
					"http.request.method": "PATCH",
					"url.path": "/users/123",
					"http.response.status_code": "503",
				},
			}),
		).toEqual({
			method: "PATCH",
			route: "/users/123",
			statusCode: 503,
			isError: true,
			kind: "server",
		})
	})

	it("detects HTTP from name-only overview values", () => {
		expect(getHttpInfo({ spanName: "GET /checkout" })).toEqual({
			method: "GET",
			route: "/checkout",
			statusCode: null,
			isError: false,
			kind: "server",
		})
	})

	it("detects HTTP from http.server span names", () => {
		expect(getHttpInfo({ spanName: "http.server GET /checkout" })).toEqual({
			method: "GET",
			route: "/checkout",
			statusCode: null,
			isError: false,
			kind: "server",
		})
	})

	it("returns null for non-http spans", () => {
		expect(getHttpInfo({ spanName: "CheckoutService.createOrder" })).toBeNull()
	})

	it("prefers attrs when name and attrs disagree", () => {
		expect(
			getHttpInfo({
				spanName: "GET /checkout",
				spanAttributes: {
					"http.method": "DELETE",
					"http.route": "/orders/:id",
					"http.status_code": "404",
				},
			}),
		).toEqual({
			method: "DELETE",
			route: "/orders/:id",
			statusCode: 404,
			isError: false,
			kind: "server",
		})
	})

	it("extracts host+path from url.full for client spans", () => {
		expect(
			getHttpInfo({
				spanName: "http.client GET",
				spanAttributes: {
					"http.request.method": "GET",
					"url.full": "https://api.tinybird.co/v1/spans?x=1",
					"http.response.status_code": "200",
				},
			}),
		).toEqual({
			method: "GET",
			route: "api.tinybird.co/v1/spans",
			statusCode: 200,
			isError: false,
			kind: "client",
		})
	})

	it("extracts host+path from legacy http.url for client spans", () => {
		expect(
			getHttpInfo({
				spanName: "http.client POST",
				spanAttributes: {
					"http.method": "POST",
					"http.url": "https://api.example.com/users/123",
				},
			}),
		).toEqual({
			method: "POST",
			route: "api.example.com/users/123",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("composes host+path from server.address and url.path", () => {
		expect(
			getHttpInfo({
				spanName: "http.client GET",
				spanAttributes: {
					"http.request.method": "GET",
					"server.address": "api.tinybird.co",
					"url.path": "/v0/sql",
				},
			}),
		).toEqual({
			method: "GET",
			route: "api.tinybird.co/v0/sql",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("parses http.client span name with full URL tail", () => {
		expect(getHttpInfo({ spanName: "http.client GET https://api.tinybird.co/v1/spans" })).toEqual({
			method: "GET",
			route: "api.tinybird.co/v1/spans",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("prefers url.full over a scheme-tainted server.address", () => {
		expect(
			getHttpInfo({
				spanName: "http.client GET",
				spanAttributes: {
					"http.request.method": "GET",
					"server.address": "http://prd-artifacts-api",
					"url.path": "/config-api/read",
					"url.full": "http://prd-artifacts-api/config-api/read",
				},
			}),
		).toEqual({
			method: "GET",
			route: "prd-artifacts-api/config-api/read",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("strips a scheme prefix from server.address when url.full is absent", () => {
		expect(
			getHttpInfo({
				spanName: "http.client GET",
				spanAttributes: {
					"http.request.method": "GET",
					"server.address": "http://prd-artifacts-api",
					"url.path": "/config-api/read",
				},
			}),
		).toEqual({
			method: "GET",
			route: "prd-artifacts-api/config-api/read",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("server spans keep path-only when only http.route is set", () => {
		expect(
			getHttpInfo({
				spanName: "http.server GET",
				spanAttributes: {
					"http.method": "GET",
					"http.route": "/v1/spans",
					"server.address": "api.tinybird.co",
				},
			}),
		).toEqual({
			method: "GET",
			route: "/v1/spans",
			statusCode: null,
			isError: false,
			kind: "server",
		})
	})

	// Regression: the span-hierarchy query rewrites a client span named "GET" into
	// "GET /v0/sql", so the "http.client " prefix is gone and there's no url.full.
	// The name heuristic alone would misclassify it as a server span and emit
	// path-only — dropping the host. A real SPAN_KIND_CLIENT must override that and
	// reconstruct host+path so the detail view matches the list.
	it("uses SPAN_KIND_CLIENT to reconstruct host+path despite a rewritten name", () => {
		expect(
			getHttpInfo({
				spanName: "GET /v0/sql",
				spanKind: "SPAN_KIND_CLIENT",
				spanAttributes: {
					"http.request.method": "GET",
					"server.address": "api.tinybird.co",
					"url.path": "/v0/sql",
				},
			}),
		).toEqual({
			method: "GET",
			route: "api.tinybird.co/v0/sql",
			statusCode: null,
			isError: false,
			kind: "client",
		})
	})

	it("treats an empty-string method attr as absent (no blank method badge)", () => {
		// Some emitters send http.request.method: "" alongside a route. Without guarding,
		// Option.fromNullishOr("") returns Some("") and renders an empty method badge.
		expect(
			getHttpInfo({
				spanName: "/subscriptions-api/public/v1/redeem",
				spanKind: "SPAN_KIND_SERVER",
				spanAttributes: {
					"http.request.method": "",
					"http.route": "/subscriptions-api/public/v1/redeem",
				},
			}),
		).toBeNull()
	})

	it("falls back to a non-empty method source when the first attr is blank", () => {
		expect(
			getHttpInfo({
				spanName: "ignored",
				spanAttributes: {
					"http.method": "",
					"http.request.method": "POST",
					"http.route": "/checkout",
				},
			}),
		).toEqual({
			method: "POST",
			route: "/checkout",
			statusCode: null,
			isError: false,
			kind: "server",
		})
	})

	it("uses SPAN_KIND_SERVER to keep path-only even when host attrs are present", () => {
		expect(
			getHttpInfo({
				spanName: "GET /v1/spans",
				spanKind: "SPAN_KIND_SERVER",
				spanAttributes: {
					"http.request.method": "GET",
					"server.address": "api.tinybird.co",
					"url.path": "/v1/spans",
				},
			}),
		).toEqual({
			method: "GET",
			route: "/v1/spans",
			statusCode: null,
			isError: false,
			kind: "server",
		})
	})
})
