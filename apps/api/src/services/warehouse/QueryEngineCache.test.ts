import { describe, expect, it } from "vitest"
import { cacheTtlForQueryKind, snapToWindow, snapWindowForQueryKind } from "@maple/query-engine/runtime"

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
