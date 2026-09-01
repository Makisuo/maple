import { describe, expect, it } from "vitest"

import {
	NICE_TICK_COUNT,
	bucketTimeScale,
	integerTickValues,
	linearYDomain,
	logYDomain,
	logYScale,
	minBarLength,
	niceLinearDomain,
} from "../plot-scales"

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

	it("moves the axis floor to softMin, overriding the zero anchor", () => {
		// The bug this replaces: `softMin` was only consulted when it was BELOW the
		// running minimum, which for positive data was already zero — so the
		// setting a user typed into the y-axis rail did nothing at all.
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p50"], softMin: 40 })).toEqual([40, 45])
	})

	it("yields to data that goes beyond a soft bound rather than clipping it", () => {
		// Soft, not a clamp: nothing clips a mark in TanStack, so an axis that
		// refused to show the data would paint it over the tick labels instead of
		// hiding it. `min`/`max` are the separate hard pair in the widget schema.
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p50"], softMin: 100 })).toEqual([40, 45])
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p99"], softMax: 100 })).toEqual([0, 700])
	})

	it("honours softMin and softMax when they widen the domain", () => {
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p99"], softMax: 1000 })).toEqual([0, 1000])
		expect(linearYDomain({ rows: LATENCY_ROWS, keys: ["p50"], softMin: -10 })).toEqual([-10, 45])
	})

	it("keeps a soft bound from hiding a threshold", () => {
		// Thresholds are unioned LAST, so a rule outside every other bound still
		// lands inside the plot instead of painting over the axis labels.
		expect(
			linearYDomain({
				rows: LATENCY_ROWS,
				keys: ["p50"],
				softMin: 40,
				thresholds: [{ value: 20 }],
			}),
		).toEqual([20, 45])
	})

	it("keeps negative readings inside the plot instead of below the axis", () => {
		// The zero anchor means zero is IN the domain, not that zero is the floor.
		// Pinning `min` to 0 drew a period-comparison delta under the x tick labels,
		// because marks are not clipped.
		expect(
			linearYDomain({
				rows: [
					{ bucket: "a", delta: -30 },
					{ bucket: "b", delta: 12 },
				],
				keys: ["delta"],
			}),
		).toEqual([-30, 12])
		// All-negative data keeps zero as its ceiling for the same reason a
		// positive series keeps zero as its floor: the baseline stays visible.
		expect(linearYDomain({ rows: [{ bucket: "a", delta: -30 }], keys: ["delta"] })).toEqual([-30, 0])
	})

	it("widens a degenerate domain rather than collapsing the series to one line", () => {
		expect(linearYDomain({ rows: [{ bucket: "a", v: 0 }], keys: ["v"] })).toEqual([0, 1])
	})

	it("falls back to [0, 1] when there are no finite readings", () => {
		expect(linearYDomain({ rows: [{ bucket: "a", v: null }], keys: ["v"] })).toEqual([0, 1])
		expect(linearYDomain({ rows: [], keys: ["v"] })).toEqual([0, 1])
	})
})

describe("niceLinearDomain", () => {
	it("returns the domain the axis is DRAWN with, not the raw data extent", () => {
		// The measured regression: `fitYAxisToData` over 41–97 yields [35.4, 97],
		// the renderer nices that to [30, 100], and an area band filling from the
		// returned 35.4 floats above the real axis floor.
		const raw = linearYDomain({
			rows: [
				{ bucket: "a", v: 41 },
				{ bucket: "b", v: 97 },
			],
			keys: ["v"],
			fitYAxisToData: true,
		})
		expect(raw[0]).toBeCloseTo(35.4, 5)
		expect(niceLinearDomain(raw)).toEqual([30, 100])
	})

	it("is idempotent, so an axis may still declare `nice` on top of it", () => {
		const once = niceLinearDomain([35.4, 97])
		expect(niceLinearDomain(once)).toEqual(once)
	})

	it("leaves an already-round domain alone", () => {
		expect(niceLinearDomain([0, 700])).toEqual([0, 700])
	})

	it("keeps the caller's domain when nicing cannot produce a usable one", () => {
		expect(niceLinearDomain([5, 5])).toEqual([5, 5])
	})

	it("rounds to the tick count the axis must pin", () => {
		// The count is exported because the renderer otherwise derives it from the
		// plot's pixel height, which would make the two disagree at some sizes.
		expect(NICE_TICK_COUNT).toBe(5)
		expect(niceLinearDomain([35.4, 97], NICE_TICK_COUNT)).toEqual([30, 100])
	})
})

describe("logYDomain", () => {
	it("does not waste a decade of height on a small peak", () => {
		// The old `Math.max(max, 10)` drew a 3-count histogram's tallest bucket at
		// log(3)/log(10) ≈ 44% of the plot.
		expect(logYDomain(3)).toEqual([1, 3])
	})

	it("still widens a domain that would collapse to a single point", () => {
		// A log scale over [1, 1] has a zero span and maps every value to NaN.
		expect(logYDomain(1)).toEqual([1, 10])
		expect(logYDomain(0)).toEqual([1, 10])
		expect(logYDomain(Number.NaN)).toEqual([1, 10])
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

describe("minBarLength", () => {
	// 1.5% of a 0–1000 domain.
	const lift = minBarLength([0, 1000])

	it("lifts a value too small to paint up to the floor", () => {
		expect(lift(1)).toBe(15)
		expect(lift(0.001)).toBe(15)
	})

	it("leaves a value that already clears the floor alone", () => {
		expect(lift(15)).toBe(15)
		expect(lift(400)).toBe(400)
	})

	it("keeps a null null — a bucket the source never reported paints nothing", () => {
		// `barY` skips a null y, and the stacked histograms mask one lane with it.
		// Lifting a null would invent a bar where there is no reading at all.
		expect(lift(null)).toBeNull()
	})

	it("keeps a true zero flat — zero is a reading, not a rounding error", () => {
		expect(lift(0)).toBe(0)
	})

	it("floors a negative value away from zero rather than across it", () => {
		// A period-comparison delta runs below the axis; the lift has to make it
		// visible on its own side.
		expect(minBarLength([-1000, 1000])(-1)).toBe(-30)
	})

	it("is a no-op on a domain with no span, rather than dividing into one", () => {
		expect(minBarLength([5, 5])(1)).toBe(1)
		expect(minBarLength([0, Number.POSITIVE_INFINITY])(1)).toBe(1)
	})

	it("scales the floor with the domain, so it holds at any plot height", () => {
		expect(minBarLength([0, 100])(0.5)).toBe(1.5)
		expect(minBarLength([0, 10_000])(0.5)).toBe(150)
	})

	it("takes an explicit fraction for a chart that wants a different floor", () => {
		expect(minBarLength([0, 1000], 0.05)(1)).toBe(50)
	})
})
