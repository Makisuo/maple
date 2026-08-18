import { describe, expect, it } from "vitest"

import { bucketTimeScale, integerTickValues, linearYDomain, logYScale } from "../plot-scales"

const LATENCY_ROWS = [
	{ bucket: "a", p50: 40, p99: 600 },
	{ bucket: "b", p50: 45, p99: 700 },
]

describe("linearYDomain", () => {
	it("anchors at zero, which TanStack does not do on its own", () => {
		// The inferred domain would start at 40 and pin the p50 line to the floor.
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p50", "p99"] })).toEqual([0, 700])
	})

	it("starts at the padded data minimum under fitYAxisToData", () => {
		const [min, max] = linearYDomain({
			rows: LATENCY_ROWS,
			keys: ["p50", "p99"],
			fitYAxisToData: true,
		})
		expect(max).toBe(700)
		// 40 - (700 - 40) * 0.1
		expect(min).toBeCloseTo(-26, 5)
	})

	it("unions thresholds into the domain, replacing ifOverflow=extendDomain", () => {
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p50"], thresholds: [{ value: 250 }] })).toEqual([
			0, 250,
		])
	})

	it("honours softMin and softMax only when they widen the domain", () => {
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p99"], softMax: 1000 })).toEqual([0, 1000])
		// A softMax INSIDE the data must not clip the series.
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p99"], softMax: 100 })).toEqual([0, 700])
	})

	it("widens a degenerate domain rather than collapsing the series to one line", () => {
		expect(linearYDomain({ rows: [{ bucket: "a", v: 0 }], keys: ["v"] })).toEqual([0, 1])
	})

	it("falls back to [0, 1] when there are no finite readings", () => {
		expect(linearYDomain({ rows: [{ bucket: "a", v: null }], keys: ["v"] })).toEqual([0, 1])
		expect(linearYDomain({ rows: [], keys: ["v"] })).toEqual([0, 1])
	})
})

describe("logYScale", () => {
	it("returns a configured INSTANCE, so the domain is pinned rather than inferred", () => {
		const scale = logYScale(1000)
		// The library treats `typeof fn === "function" && !("copy" in fn)` as a
		// factory and infers its domain. `copy` lives on the instance.
		expect("copy" in scale).toBe(true)
		expect(scale.domain()).toEqual([1, 1000])
	})

	it("floors the domain at 1 — log is undefined at zero", () => {
		expect(logYScale(0).domain()[0]).toBe(1)
	})
})

describe("bucketTimeScale", () => {
	it("is a local time scale, matching the local-time bucket formatter", () => {
		const start = new Date("2026-08-18T00:00:00Z")
		const end = new Date("2026-08-18T06:00:00Z")
		const scale = bucketTimeScale([start, end])
		expect(scale.domain()).toEqual([start, end])
		// scaleUtc would place ticks against a different clock than the one
		// printing the labels, drifting them by the browser's offset.
		expect(scale.range()).toEqual([0, 1])
	})
})

describe("integerTickValues", () => {
	it("emits only whole numbers — there is no allowDecimals option", () => {
		const ticks = integerTickValues([0, 4])
		expect(ticks).toEqual([0, 1, 2, 3, 4])
		expect(ticks.every(Number.isInteger)).toBe(true)
	})

	it("widens the step rather than emitting fractions on a large range", () => {
		const ticks = integerTickValues([0, 100], 5)
		expect(ticks.every(Number.isInteger)).toBe(true)
		expect(ticks[0]).toBe(0)
		expect(ticks.at(-1)).toBeGreaterThanOrEqual(100)
	})

	it("terminates on a degenerate range instead of looping on a zero step", () => {
		expect(integerTickValues([3, 3])).toEqual([3])
	})
})
