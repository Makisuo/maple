import { describe, expect, it } from "vitest"
import { OPERATIONS_LIMIT } from "./service-operations"
import {
	endpointDetailSearch,
	endpointSpanName,
	methodTone,
	serviceEndpointsQueryInput,
	splitRouteForDisplay,
} from "./service-endpoints"

describe("serviceEndpointsQueryInput", () => {
	const args = {
		serviceName: "api",
		effectiveStartTime: "2026-08-14 00:00:00",
		effectiveEndTime: "2026-08-14 12:00:00",
	}

	it("matches the operations query's bucket sizing and limit", () => {
		// The two tables sit side by side; divergent sizing would read as a data bug.
		const input = serviceEndpointsQueryInput(args)
		expect(input.limit).toBe(OPERATIONS_LIMIT)
		// 12h / 50 = 864s, rounded to the nearest whole minute (the rollup's grain).
		expect(input.bucketSeconds).toBe(840)
		expect(input.bucketSeconds! % 60).toBe(0)
	})

	it("omits an empty environment filter so the key stays stable", () => {
		expect(serviceEndpointsQueryInput({ ...args, environments: [] }).environments).toBeUndefined()
		expect(serviceEndpointsQueryInput({ ...args, environments: ["prod"] }).environments).toEqual(["prod"])
	})
})

describe("endpointSpanName", () => {
	it("recomposes the display name the warehouse keys on", () => {
		expect(endpointSpanName("GET", "/v1/users")).toBe("GET /v1/users")
	})

	it("round-trips a route containing path parameters and slashes", () => {
		const route = "/v1/orgs/{orgId}/users/{userId}"
		expect(endpointSpanName("DELETE", route)).toBe(`DELETE ${route}`)
	})
})

describe("splitRouteForDisplay", () => {
	it("keeps the last segment as the fixed tail", () => {
		// The shared prefix is what a table of sibling routes can afford to lose.
		expect(splitRouteForDisplay("/subscriptions/v2/{id}/cancel")).toEqual({
			head: "/subscriptions/v2/{id}",
			tail: "/cancel",
		})
	})

	it("treats a single-segment route as all tail, so nothing truncates", () => {
		expect(splitRouteForDisplay("/lander")).toEqual({ head: "", tail: "/lander" })
	})

	it("handles a route with no leading slash", () => {
		expect(splitRouteForDisplay("health")).toEqual({ head: "", tail: "health" })
	})

	it("handles a trailing slash without emitting an empty tail-only split", () => {
		expect(splitRouteForDisplay("/api/v1/")).toEqual({ head: "/api/v1", tail: "/" })
	})

	it("round-trips: head + tail is always the original route", () => {
		for (const route of ["/a/b/c", "/lander", "/", "", "/api/match", "no-slash"]) {
			const { head, tail } = splitRouteForDisplay(route)
			expect(head + tail).toBe(route)
		}
	})
})

describe("methodTone", () => {
	it("groups verbs by effect, not by verb", () => {
		expect(methodTone("GET")).toBe(methodTone("HEAD"))
		expect(methodTone("POST")).toBe(methodTone("PATCH"))
		expect(methodTone("DELETE")).not.toBe(methodTone("POST"))
		expect(methodTone("get")).toBe(methodTone("GET"))
	})

	it("falls back for an unrecognized or empty method", () => {
		expect(methodTone("")).toContain("muted")
		expect(methodTone("TRACE")).toContain("muted")
	})
})

describe("endpointDetailSearch", () => {
	it("drops an empty environment list rather than serializing it", () => {
		expect(
			endpointDetailSearch({ method: "GET", route: "/x", environments: [] }).environments,
		).toBeUndefined()
	})
})
