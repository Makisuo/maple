import { focusGroupX } from "@tanstack/charts/focus"
import type { ChartPoint } from "@tanstack/charts"
import { describe, expect, it } from "vitest"

import { UNBOUNDED_FOCUS_DISTANCE } from "../plot-frame"

/**
 * The library's own focus resolver, driven directly.
 *
 * Pointer events do not reach the renderer under jsdom — it never lays anything
 * out and its `PointerEvent` support is partial — so a hover cannot be staged in
 * a component test. The behaviour under test is not ours anyway: it is what
 * `maxFocusDistance` does to `focusGroupX`, and that is exactly what this
 * exercises, with the constant the charts actually pass.
 */
function pointAt(x: number, index: number): ChartPoint<{ index: number }, number, number> {
	return {
		key: `p${index}`,
		markId: "series",
		group: "series",
		groupLabel: "series",
		datum: { index },
		datumIndex: index,
		xValue: x,
		yValue: 10,
		x,
		y: 100,
		color: "#000",
	}
}

/** 7 day-buckets across an 800px plot: 133px apart, so 66px from a midpoint. */
const points = [0, 133, 266, 399, 532, 665, 798].map(pointAt)

describe("UNBOUNDED_FOCUS_DISTANCE", () => {
	it("resolves a bucket further away than the library's 48px default", () => {
		// The regression this exists for: halfway between two day buckets is 66px
		// from either, so the default cap leaves the tooltip, the crosshair and the
		// focus dot all dead — in more than half of the plot's width.
		expect(focusGroupX.resolve(points, { x: 66, y: 100, maxDistance: 48 })).toEqual([])

		const resolved = focusGroupX.resolve(points, {
			x: 66,
			y: 100,
			maxDistance: UNBOUNDED_FOCUS_DISTANCE,
		})
		expect(resolved[0]?.xValue).toBe(0)
	})

	it("still resolves the NEAREST bucket, not merely some bucket", () => {
		const resolved = focusGroupX.resolve(points, {
			x: 500,
			y: 100,
			maxDistance: UNBOUNDED_FOCUS_DISTANCE,
		})
		expect(resolved[0]?.xValue).toBe(532)
	})

	it("is a finite cap that behaves like no cap", () => {
		// Finite on purpose — the renderer squares this value and subtracts it in
		// several places, and a finite number cannot come out of that arithmetic as
		// NaN. It has to resolve identically to the honest `Infinity` it stands in
		// for, which is what this pins.
		expect(Number.isFinite(UNBOUNDED_FOCUS_DISTANCE)).toBe(true)
		const capped = focusGroupX.resolve(points, {
			x: 66,
			y: 100,
			maxDistance: UNBOUNDED_FOCUS_DISTANCE,
		})
		const uncapped = focusGroupX.resolve(points, {
			x: 66,
			y: 100,
			maxDistance: Number.POSITIVE_INFINITY,
		})
		expect(capped.map((point) => point.key)).toEqual(uncapped.map((point) => point.key))
	})
})
