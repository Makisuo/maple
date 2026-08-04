import { describe, expect, it } from "vitest"
import {
	buildCacheKey,
	cacheTtlForQueryKind,
	snapToWindow,
	snapWindowForQueryKind,
} from "@maple/query-engine/runtime"

describe("snapToWindow", () => {
	it("snaps within a single minute when window is 15s", () => {
		expect(snapToWindow("2026-04-27 12:34:42", 15)).toBe("2026-04-27 12:34:30")
		expect(snapToWindow("2026-04-27 12:34:00", 15)).toBe("2026-04-27 12:34:00")
		expect(snapToWindow("2026-04-27 12:34:14", 15)).toBe("2026-04-27 12:34:00")
	})

	it("crosses minute and hour boundaries cleanly for 5-min window", () => {
		expect(snapToWindow("2026-04-27 12:34:42", 300)).toBe("2026-04-27 12:30:00")
		expect(snapToWindow("2026-04-27 12:59:42", 300)).toBe("2026-04-27 12:55:00")
		expect(snapToWindow("2026-04-27 13:01:00", 300)).toBe("2026-04-27 13:00:00")
	})

	it("handles 1-min window across minute boundary", () => {
		expect(snapToWindow("2026-04-27 12:34:42", 60)).toBe("2026-04-27 12:34:00")
		expect(snapToWindow("2026-04-27 12:34:00", 60)).toBe("2026-04-27 12:34:00")
	})

	it("returns input unchanged for malformed dates", () => {
		expect(snapToWindow("not-a-date", 15)).toBe("not-a-date")
		expect(snapToWindow("2026-04-27T12:34:42", 15)).toBe("2026-04-27T12:34:42")
	})

	it("does not throw on a nullish timestamp (cache-key path must degrade, not crash)", () => {
		// A request with an optional/undefined start or end time must not crash
		// EdgeCacheService.getOrCompute with an opaque TypeError; pass it through.
		expect(() => snapToWindow(undefined as unknown as string, 15)).not.toThrow()
		expect(snapToWindow(undefined as unknown as string, 15)).toBeUndefined()
		expect(snapToWindow(null as unknown as string, 15)).toBeNull()
	})

	it("returns input unchanged for invalid windows", () => {
		expect(snapToWindow("2026-04-27 12:34:42", 0)).toBe("2026-04-27 12:34:42")
		expect(snapToWindow("2026-04-27 12:34:42", -5)).toBe("2026-04-27 12:34:42")
		expect(snapToWindow("2026-04-27 12:34:42", 4000)).toBe("2026-04-27 12:34:42")
	})
})

describe("snapWindowForQueryKind", () => {
	it("returns 5-min for attributeKeys", () => {
		expect(snapWindowForQueryKind("attributeKeys")).toBe(300)
	})

	it("returns 15-min for facets — environments / commit SHAs / service names change slowly", () => {
		expect(snapWindowForQueryKind("facets")).toBe(900)
	})

	it("returns 1-min for attributeValues", () => {
		expect(snapWindowForQueryKind("attributeValues")).toBe(60)
	})

	it("returns 15s default for other kinds", () => {
		expect(snapWindowForQueryKind("timeseries")).toBe(15)
		expect(snapWindowForQueryKind("breakdown")).toBe(15)
		expect(snapWindowForQueryKind("list")).toBe(15)
	})
})

describe("cacheTtlForQueryKind", () => {
	it("returns 5-min for attributeKeys", () => {
		expect(cacheTtlForQueryKind("attributeKeys")).toBe(300)
	})

	it("returns 15-min for facets — paired with the snap window", () => {
		expect(cacheTtlForQueryKind("facets")).toBe(900)
	})

	it("returns 1-min for attributeValues", () => {
		expect(cacheTtlForQueryKind("attributeValues")).toBe(60)
	})

	it("returns 15s default for other kinds", () => {
		expect(cacheTtlForQueryKind("timeseries")).toBe(15)
		expect(cacheTtlForQueryKind("breakdown")).toBe(15)
		expect(cacheTtlForQueryKind("list")).toBe(15)
		expect(cacheTtlForQueryKind("count")).toBe(15)
		expect(cacheTtlForQueryKind("stats")).toBe(15)
	})
})

describe("buildCacheKey", () => {
	const request = (query: Record<string, unknown>) =>
		({
			startTime: "2026-04-27 12:00:00",
			endTime: "2026-04-27 13:00:00",
			query,
		}) as never

	// The same widget reaches this path from the dashboard builder, a saved
	// template, and the MCP widget tools, and each builds its QuerySpec with a
	// different key insertion order — which `JSON.stringify` preserves. Hashing
	// that raw output minted one entry per producer for a single query: three
	// cold misses where there should have been one, with nothing in a trace to
	// attribute the loss to.
	it("is insensitive to the query's key insertion order", () => {
		const a = buildCacheKey("org_1", request({ kind: "timeseries", source: "traces", metric: "count" }))
		const b = buildCacheKey("org_1", request({ metric: "count", source: "traces", kind: "timeseries" }))
		expect(a).toBe(b)
	})

	it("is insensitive to key order in nested filter objects", () => {
		const a = buildCacheKey(
			"org_1",
			request({ kind: "timeseries", filters: { env: "prod", service: "api" } }),
		)
		const b = buildCacheKey(
			"org_1",
			request({ kind: "timeseries", filters: { service: "api", env: "prod" } }),
		)
		expect(a).toBe(b)
	})

	it("still separates queries that differ in value, org, or window", () => {
		const base = request({ kind: "timeseries", metric: "count" })
		expect(buildCacheKey("org_1", base)).not.toBe(
			buildCacheKey("org_1", request({ kind: "timeseries", metric: "errors" })),
		)
		expect(buildCacheKey("org_1", base)).not.toBe(buildCacheKey("org_2", base))
	})

	// Array order is meaningful — an ORDER BY list is not a set — so it must
	// stay part of the key, or two genuinely different queries would collide.
	it("keeps queries differing only in array order apart", () => {
		const a = buildCacheKey("org_1", request({ orderBy: ["duration", "name"] }))
		const b = buildCacheKey("org_1", request({ orderBy: ["name", "duration"] }))
		expect(a).not.toBe(b)
	})
})
