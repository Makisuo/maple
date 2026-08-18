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
		// …and the refusal has to leave `hidden` empty, because the legend renders
		// `hidden` directly. A struck-through row over a painted series is a lie.
		expect(result.current.hidden.size).toBe(0)
	})

	it("keeps the legend's `hidden` and the plot's `visible` in agreement", () => {
		// Clicking every row in turn used to leave `hidden` holding all three keys
		// while `visible` fell back to painting all three: the legend struck through
		// series the chart was still drawing. Whatever the floor is, the two sides
		// have to describe the same picture.
		const { result } = renderHook(() => useSeriesVisibility(SERIES))

		act(() => result.current.toggle("s1"))
		act(() => result.current.toggle("s2"))
		act(() => result.current.toggle("s3"))

		expect(result.current.visibleKeys).toEqual(["s3"])
		expect([...result.current.hidden].sort()).toEqual(["s1", "s2"])
		expect(result.current.visibleKeys.some((key) => result.current.hidden.has(key))).toBe(false)
	})

	it("lets the refused series be hidden once another comes back", () => {
		const { result } = renderHook(() => useSeriesVisibility([{ key: "s1" }, { key: "s2" }]))

		act(() => result.current.toggle("s1"))
		act(() => result.current.toggle("s2"))
		expect(result.current.visibleKeys).toEqual(["s2"])

		// Un-hide s1, and s2 becomes hideable again — the floor is on the state
		// transition, not a permanent pin on whichever series survived.
		act(() => result.current.toggle("s1"))
		act(() => result.current.toggle("s2"))
		expect(result.current.visibleKeys).toEqual(["s1"])
	})

	it("counts the floor over the current series, not the hidden set's size", () => {
		// `hidden` outlives a query change that swaps the keys, so a stale key must
		// not be mistaken for one of the survivors and block a legitimate hide.
		const { result, rerender } = renderHook(({ series }) => useSeriesVisibility(series), {
			initialProps: { series: [{ key: "s1" }, { key: "s2" }] },
		})

		act(() => result.current.toggle("s1"))
		rerender({ series: [{ key: "s2" }, { key: "s3" }] })

		// s1 is still in `hidden` but no longer a series; s2 and s3 are both visible,
		// so hiding one of them must be allowed.
		act(() => result.current.toggle("s2"))
		expect(result.current.visibleKeys).toEqual(["s3"])
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
