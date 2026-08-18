import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { linearYDomain } from "../plot-scales"
import { useSeriesVisibility } from "../series-visibility"

const SERIES = [{ key: "s1" }, { key: "s2" }, { key: "s3" }]

/** Three services stacking to 60 in every bucket. */
const ROWS = [
	{ bucket: "2026-08-18T00:00:00", s1: 10, s2: 20, s3: 30 },
	{ bucket: "2026-08-18T00:01:00", s1: 10, s2: 20, s3: 30 },
]

describe("useSeriesVisibility", () => {
	it("toggles a key in and out of the hidden set", () => {
		const { result } = renderHook(() => useSeriesVisibility(SERIES))
		expect(result.current.hidden.size).toBe(0)
		expect(result.current.visibleKeys).toEqual(["s1", "s2", "s3"])

		act(() => result.current.toggle("s2"))
		expect(result.current.hidden.has("s2")).toBe(true)
		expect(result.current.visibleKeys).toEqual(["s1", "s3"])

		act(() => result.current.toggle("s2"))
		expect(result.current.hidden.size).toBe(0)
		expect(result.current.visibleKeys).toEqual(["s1", "s2", "s3"])
	})

	it("keeps the array identity stable while nothing is hidden", () => {
		// A fresh array per render would rebuild the scene on every commit.
		const { result, rerender } = renderHook(() => useSeriesVisibility(SERIES))
		const first = result.current.visible
		rerender()
		expect(result.current.visible).toBe(first)
	})

	it("refuses to hide the last visible series", () => {
		// An empty plot with a collapsed axis reads as a broken chart, not a choice.
		const { result } = renderHook(() => useSeriesVisibility([{ key: "only" }]))
		act(() => result.current.toggle("only"))
		expect(result.current.visibleKeys).toEqual(["only"])
	})
})

describe("restack contract", () => {
	/**
	 * THE regression test for this migration.
	 *
	 * `interactiveColorLegend`'s `filterMark` runs on the resolved scene, after
	 * `stackValues` has assigned every segment its offsets and after the y domain
	 * has been inferred — so hiding a band there leaves a hole on the baseline and
	 * an axis that does not rescale. Filtering the DATA instead is what makes the
	 * stack recompute. These two assertions are the difference.
	 */
	it("recomputes the stacked domain from the visible series only", () => {
		const all = linearYDomain({ rows: ROWS, keys: ["s1", "s2", "s3"], stacked: true })
		expect(all).toEqual([0, 60])

		// Hide the bottom band (s1 = 10): the stack total must drop to 50, not stay
		// at 60 with a 10-unit gap at the baseline.
		const withoutS1 = linearYDomain({ rows: ROWS, keys: ["s2", "s3"], stacked: true })
		expect(withoutS1).toEqual([0, 50])
	})

	it("recomputes an unstacked domain from the visible series only", () => {
		const all = linearYDomain({ rows: ROWS, keys: ["s1", "s2", "s3"] })
		expect(all).toEqual([0, 30])

		const withoutTallest = linearYDomain({ rows: ROWS, keys: ["s1", "s2"] })
		expect(withoutTallest).toEqual([0, 20])
	})
})
