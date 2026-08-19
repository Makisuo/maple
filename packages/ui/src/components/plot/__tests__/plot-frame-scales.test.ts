import { describe, expect, it } from "vitest"
import type { ResolvedScale } from "@tanstack/charts"

import { plotScalesInterchangeable, type PlotScales } from "../plot-frame"

/**
 * A resolved scale is mostly a `map` closure plus the descriptors that determine
 * it. These fixtures vary one descriptor at a time, because the whole point of
 * `plotScalesInterchangeable` is which differences it is allowed to ignore.
 */
function scale(overrides: Partial<ResolvedScale> = {}): ResolvedScale {
	return {
		id: "x",
		type: "time",
		domain: [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T06:00:00Z")],
		map: () => 0,
		ticks: [],
		bandwidth: 0,
		...overrides,
	}
}

const scales = (entries: Record<string, ResolvedScale>): PlotScales => entries

describe("plotScalesInterchangeable", () => {
	it("never treats a missing snapshot as interchangeable", () => {
		expect(plotScalesInterchangeable(null, scales({ x: scale() }))).toBe(false)
	})

	/**
	 * The load-bearing case. The scene hands back a fresh `scales` record — with
	 * fresh `Date` objects and a fresh `map` closure — on every update, including
	 * every pointer tick. Comparing by identity here would notify subscribers
	 * constantly and put a render on the hover hot path.
	 */
	it("ignores rebuilt Date domains and rebuilt map closures", () => {
		const before = scales({ x: scale() })
		const after = scales({
			x: scale({
				domain: [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T06:00:00Z")],
				map: () => 999,
			}),
		})
		expect(plotScalesInterchangeable(before, after)).toBe(true)
	})

	it("reports a changed domain", () => {
		const before = scales({ x: scale() })
		const after = scales({
			x: scale({ domain: [new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z")] }),
		})
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	it("reports a changed domain length", () => {
		const before = scales({ x: scale({ type: "band", domain: ["a", "b"] }) })
		const after = scales({ x: scale({ type: "band", domain: ["a", "b", "c"] }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	it("reports a changed bandwidth even when the domain is untouched", () => {
		const before = scales({ x: scale({ type: "band", domain: ["a", "b"], bandwidth: 40 }) })
		const after = scales({ x: scale({ type: "band", domain: ["a", "b"], bandwidth: 20 }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	it("reports a changed scale type", () => {
		expect(
			plotScalesInterchangeable(scales({ y: scale({ id: "y", type: "linear" }) }), {
				y: scale({ id: "y", type: "log" }),
			}),
		).toBe(false)
	})

	it("reports an added or removed scale", () => {
		const before = scales({ x: scale() })
		const after = scales({ x: scale(), y: scale({ id: "y", type: "linear", domain: [0, 10] }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
		expect(plotScalesInterchangeable(after, before)).toBe(false)
	})

	it("reports a renamed scale rather than matching on key count alone", () => {
		const before = scales({ x: scale() })
		const after = scales({ x2: scale({ id: "x2" }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	/**
	 * A pan shifts the mapping while leaving the content domain alone — precisely
	 * what a domain-only check would miss, and the reason `viewport` is compared.
	 */
	it("reports a viewport translate change on an unchanged domain", () => {
		const viewport = {
			contentDomain: [0, 100],
			domain: [0, 50] as [number, number],
			translate: 0,
			map: () => 0,
		}
		const before = scales({ x: scale({ viewport }) })
		const after = scales({ x: scale({ viewport: { ...viewport, translate: 12 } }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	it("reports a viewport window change", () => {
		const viewport = {
			contentDomain: [0, 100],
			domain: [0, 50] as [number, number],
			translate: 0,
			map: () => 0,
		}
		const before = scales({ x: scale({ viewport }) })
		const after = scales({ x: scale({ viewport: { ...viewport, domain: [25, 75] } }) })
		expect(plotScalesInterchangeable(before, after)).toBe(false)
	})

	it("reports a viewport appearing or disappearing", () => {
		const viewport = {
			contentDomain: [0, 100],
			domain: [0, 50] as [number, number],
			translate: 0,
			map: () => 0,
		}
		const withViewport = scales({ x: scale({ viewport }) })
		const without = scales({ x: scale() })
		expect(plotScalesInterchangeable(withViewport, without)).toBe(false)
		expect(plotScalesInterchangeable(without, withViewport)).toBe(false)
	})
})
