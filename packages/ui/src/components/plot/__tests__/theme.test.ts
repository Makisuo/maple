import { afterEach, describe, expect, it } from "vitest"

import { resolvePlotColor } from "../theme"

const TOKENS = ["--chart-p95", "--severity-error", "--chart-1"] as const

afterEach(() => {
	for (const token of TOKENS) document.documentElement.style.removeProperty(token)
})

describe("resolvePlotColor", () => {
	/**
	 * The regression this file exists for. `resolveSeriesColors` returns WRAPPED
	 * tokens for every semantically named series — `p50`/`p95`/`p99`, `ok`/`error`,
	 * the severity levels, and the ungrouped names `value`/`count`/`all` — and only
	 * the hashed identity palette comes back as a literal. Accepting nothing but a
	 * bare `--token` let every one of those through untouched, into the chart
	 * definition, where the dev-only colour assertion threw mid-render.
	 */
	it("resolves a wrapped var() token", () => {
		document.documentElement.style.setProperty("--chart-p95", "oklch(0.7 0.15 250)")
		expect(resolvePlotColor("var(--chart-p95)", "#000")).toBe("oklch(0.7 0.15 250)")
	})

	it("tolerates whitespace inside the wrapper", () => {
		document.documentElement.style.setProperty("--severity-error", "oklch(0.6 0.2 25)")
		expect(resolvePlotColor("var( --severity-error )", "#000")).toBe("oklch(0.6 0.2 25)")
	})

	it("still resolves a bare token", () => {
		document.documentElement.style.setProperty("--chart-1", "oklch(0.5 0.1 200)")
		expect(resolvePlotColor("--chart-1", "#000")).toBe("oklch(0.5 0.1 200)")
	})

	it("falls back when a wrapped token resolves to nothing", () => {
		expect(resolvePlotColor("var(--chart-p95)", "#6366f1")).toBe("#6366f1")
	})

	/**
	 * A literal has to survive untouched — the identity palette is already
	 * `oklch(...)` by the time it gets here.
	 */
	it("passes a literal colour through", () => {
		expect(resolvePlotColor("oklch(0.5 0.1 200)", "#000")).toBe("oklch(0.5 0.1 200)")
		expect(resolvePlotColor("#ef4444", "#000")).toBe("#ef4444")
	})

	/**
	 * `var()` with a fallback is not unwrapped to a custom-property name, so it
	 * must not be mistaken for one and must reach the renderer intact.
	 */
	it("leaves a var() carrying its own fallback alone", () => {
		expect(resolvePlotColor("var(--missing, #abcdef)", "#000")).toBe("var(--missing, #abcdef)")
	})
})
