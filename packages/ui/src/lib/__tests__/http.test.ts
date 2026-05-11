import { describe, expect, it } from "vitest"

import { getHttpInfo } from "../http"

describe("getHttpInfo", () => {
	it("detects HTTP from standard attrs", () => {
		expect(
			getHttpInfo("ignored", {
				"http.method": "POST",
				"http.route": "/checkout",
				"http.status_code": "201",
			}),
		).toEqual({
			method: "POST",
			route: "/checkout",
			statusCode: 201,
			isError: false,
		})
	})

	it("detects HTTP from semantic convention attrs", () => {
		expect(
			getHttpInfo("ignored", {
				"http.request.method": "PATCH",
				"url.path": "/users/123",
				"http.response.status_code": "503",
			}),
		).toEqual({
			method: "PATCH",
			route: "/users/123",
			statusCode: 503,
			isError: true,
		})
	})

	it("detects HTTP from name-only overview values", () => {
		expect(getHttpInfo("GET /checkout", {})).toEqual({
			method: "GET",
			route: "/checkout",
			statusCode: null,
			isError: false,
		})
	})

	it("detects HTTP from http.server span names", () => {
		expect(getHttpInfo("http.server GET /checkout", {})).toEqual({
			method: "GET",
			route: "/checkout",
			statusCode: null,
			isError: false,
		})
	})

	it("returns null for non-http spans", () => {
		expect(getHttpInfo("CheckoutService.createOrder", {})).toBeNull()
	})

	it("prefers attrs when name and attrs disagree", () => {
		expect(
			getHttpInfo("GET /checkout", {
				"http.method": "DELETE",
				"http.route": "/orders/:id",
				"http.status_code": "404",
			}),
		).toEqual({
			method: "DELETE",
			route: "/orders/:id",
			statusCode: 404,
			isError: false,
		})
	})

	it("extracts host+path from url.full for client spans", () => {
		expect(
			getHttpInfo("http.client GET", {
				"http.request.method": "GET",
				"url.full": "https://api.tinybird.co/v1/spans?x=1",
				"http.response.status_code": "200",
			}),
		).toEqual({
			method: "GET",
			route: "api.tinybird.co/v1/spans",
			statusCode: 200,
			isError: false,
		})
	})

	it("extracts host+path from legacy http.url for client spans", () => {
		expect(
			getHttpInfo("http.client POST", {
				"http.method": "POST",
				"http.url": "https://api.example.com/users/123",
			}),
		).toEqual({
			method: "POST",
			route: "api.example.com/users/123",
			statusCode: null,
			isError: false,
		})
	})

	it("composes host+path from server.address and url.path", () => {
		expect(
			getHttpInfo("http.client GET", {
				"http.request.method": "GET",
				"server.address": "api.tinybird.co",
				"url.path": "/v0/sql",
			}),
		).toEqual({
			method: "GET",
			route: "api.tinybird.co/v0/sql",
			statusCode: null,
			isError: false,
		})
	})

	it("parses http.client span name with full URL tail", () => {
		expect(getHttpInfo("http.client GET https://api.tinybird.co/v1/spans", {})).toEqual({
			method: "GET",
			route: "api.tinybird.co/v1/spans",
			statusCode: null,
			isError: false,
		})
	})

	it("server spans keep path-only when only http.route is set", () => {
		expect(
			getHttpInfo("http.server GET", {
				"http.method": "GET",
				"http.route": "/v1/spans",
				"server.address": "api.tinybird.co",
			}),
		).toEqual({
			method: "GET",
			route: "/v1/spans",
			statusCode: null,
			isError: false,
		})
	})
})
