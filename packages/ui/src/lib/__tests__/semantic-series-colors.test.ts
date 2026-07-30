import { describe, expect, it } from "vitest"

import { getSeriesColorByIndex, getSemanticSeriesColor, resolveSeriesColor } from "../semantic-series-colors"

describe("getSeriesColorByIndex", () => {
	it("uses the named --chart vars for the first five series", () => {
		expect(getSeriesColorByIndex(0)).toBe("var(--chart-1)")
		expect(getSeriesColorByIndex(4)).toBe("var(--chart-5)")
	})

	it("synthesizes distinct OKLCH colors beyond the named palette", () => {
		const colors = Array.from({ length: 60 }, (_, i) => getSeriesColorByIndex(i))
		// Every index yields a non-empty color string.
		expect(colors.every((c) => typeof c === "string" && c.length > 0)).toBe(true)
		// Generated colors (index >= 5) are unique — no wrap-around collisions.
		const generated = colors.slice(5)
		expect(new Set(generated).size).toBe(generated.length)
		expect(generated[0].startsWith("oklch(")).toBe(true)
	})

	it("clamps negative / fractional indices", () => {
		expect(getSeriesColorByIndex(-3)).toBe("var(--chart-1)")
		expect(getSeriesColorByIndex(2.7)).toBe("var(--chart-3)")
	})
})

describe("getSemanticSeriesColor", () => {
	it("resolves every HTTP status class, including 1xx", () => {
		const classes = ["1xx", "2xx", "3xx", "4xx", "5xx"]
		for (const key of classes) {
			expect(getSemanticSeriesColor(key), key).toMatch(/^oklch\(/)
		}
		// Each class is visually distinct — 1xx must not read as 2xx green or 3xx blue.
		const colors = classes.map((key) => getSemanticSeriesColor(key))
		expect(new Set(colors).size).toBe(classes.length)
	})

	it("resolves individual 1xx codes", () => {
		expect(getSemanticSeriesColor("101")).toMatch(/^oklch\(/)
	})
})

describe("resolveSeriesColor", () => {
	it("prefers a semantic color when the name matches a known pattern", () => {
		// "error" maps to the error severity var regardless of index.
		expect(resolveSeriesColor("error", 7)).toBe(getSemanticSeriesColor("error"))
	})

	it("falls back to the per-index color for unknown names", () => {
		expect(resolveSeriesColor("checkout-service", 0)).toBe("var(--chart-1)")
		expect(resolveSeriesColor("checkout-service", 9)).toBe(getSeriesColorByIndex(9))
	})
})
