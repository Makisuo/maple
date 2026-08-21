import { describe, expect, it } from "vitest"

import { isolatedPointIndexes, MIN_PX_PER_POINT_FOR_DOTS, pointsFit } from "../sparse-series"

const rows = (values: ReadonlyArray<number>) => values.map((s1) => ({ s1 }))

describe("isolatedPointIndexes", () => {
	it("picks only the non-zero points whose neighbours are both zero", () => {
		const isolated = isolatedPointIndexes(rows([0, 0, 5, 0, 0, 3, 4, 0, 0, 7]), ["s1"])
		expect([...(isolated.get("s1") ?? [])]).toEqual([2, 9])
	})

	it("treats the ends of the series as zero neighbours", () => {
		const isolated = isolatedPointIndexes(rows([9, 0, 0]), ["s1"])
		expect([...(isolated.get("s1") ?? [])]).toEqual([0])
	})

	it("omits series with nothing isolated — a dense line needs no dots", () => {
		const isolated = isolatedPointIndexes(rows([1, 2, 3, 4, 5]), ["s1"])
		expect(isolated.has("s1")).toBe(false)
	})

	it("is per series — one series' spike does not dot the others", () => {
		const data = [
			{ s1: 0, s2: 1 },
			{ s1: 5, s2: 2 },
			{ s1: 0, s2: 3 },
		]
		const isolated = isolatedPointIndexes(data, ["s1", "s2"])
		expect([...(isolated.get("s1") ?? [])]).toEqual([1])
		expect(isolated.has("s2")).toBe(false)
	})

	it("ignores non-numeric and non-finite values", () => {
		const data = [{ s1: Number.NaN }, { s1: 4 }, { s1: "x" }]
		expect([...(isolatedPointIndexes(data, ["s1"]).get("s1") ?? [])]).toEqual([1])
	})
})

describe("pointsFit", () => {
	it("dots every point only when consecutive points are two diameters apart", () => {
		expect(pointsFit(1000, 60)).toBe(true) // ~17px each — an hour in the editor preview
		expect(pointsFit(1000, 1000 / MIN_PX_PER_POINT_FOR_DOTS)).toBe(true)
		expect(pointsFit(700, 60)).toBe(false) // ~12px each — the same hour on a half-row tile
		expect(pointsFit(1000, 144)).toBe(false) // ~7px each — the 12h/5m case
		expect(pointsFit(1400, 720)).toBe(false)
	})

	it("says no while the container is unmeasured or empty", () => {
		expect(pointsFit(0, 10)).toBe(false)
		expect(pointsFit(500, 0)).toBe(false)
	})
})
