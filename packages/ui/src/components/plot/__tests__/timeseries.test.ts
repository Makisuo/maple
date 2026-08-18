import { describe, expect, it } from "vitest"

import {
	HARD_SERIES_LIMIT,
	asFiniteNumber,
	normaliseTimeseriesRows,
	scaleTimeseriesRates,
	timeseriesYAxis,
	type TimeseriesRow,
} from "../timeseries"

const HOUR_MS = 3_600_000

function bucketAt(index: number): string {
	return new Date(index * HOUR_MS).toISOString()
}

describe("normaliseTimeseriesRows", () => {
	it("discovers series in first-seen order across ALL rows, not just the first", () => {
		// A sparse group-by omits a key from the buckets where it had no events, so
		// reading the first row alone would never draw `late`.
		const { seriesDefinitions } = normaliseTimeseriesRows([
			{ bucket: bucketAt(0), beta: 1, alpha: 2 },
			{ bucket: bucketAt(1), alpha: 3, late: 4 },
		])

		expect(seriesDefinitions).toEqual([
			{ rawKey: "beta", chartKey: "s1" },
			{ rawKey: "alpha", chartKey: "s2" },
			{ rawKey: "late", chartKey: "s3" },
		])
	})

	it("never treats bucket or partial as a series", () => {
		const { seriesDefinitions } = normaliseTimeseriesRows([
			{ bucket: bucketAt(0), partial: true, hits: 1 },
		])
		expect(seriesDefinitions.map((definition) => definition.rawKey)).toEqual(["hits"])
	})

	it("remaps every series onto s1..sN and copies the values across", () => {
		const { rows } = normaliseTimeseriesRows([{ bucket: bucketAt(0), "demo-api": 7, "web.app": "12" }])

		expect(rows).toHaveLength(1)
		expect(rows[0].s1).toBe(7)
		// Wire values arrive as strings from some warehouse backends; a non-finite
		// one becomes 0 rather than NaN, which would blank the whole scale.
		expect(rows[0].s2).toBe(12)
	})

	it("caps the series count at the hard render limit", () => {
		const wide = new Map<string, unknown>([["bucket", bucketAt(0)]])
		for (let index = 0; index < HARD_SERIES_LIMIT + 25; index += 1) wide.set(`k${index}`, index)

		const { rows, seriesDefinitions } = normaliseTimeseriesRows([Object.fromEntries(wide)])

		expect(seriesDefinitions).toHaveLength(HARD_SERIES_LIMIT)
		expect(seriesDefinitions.at(-1)).toEqual({
			rawKey: `k${HARD_SERIES_LIMIT - 1}`,
			chartKey: `s${HARD_SERIES_LIMIT}`,
		})
		// The dropped columns are not carried on the rows either — a key past the
		// cap would still widen the y domain if it survived normalisation.
		expect(rows[0][`s${HARD_SERIES_LIMIT + 1}`]).toBeUndefined()
		expect(rows[0].k60).toBeUndefined()
	})

	it("drops rows whose bucket has no parseable epoch", () => {
		const { rows } = normaliseTimeseriesRows([
			{ bucket: bucketAt(0), hits: 1 },
			{ bucket: "not-a-date", hits: 2 },
			{ hits: 3 },
			{ bucket: bucketAt(1), hits: 4 },
		])

		expect(rows.map((row) => row.s1)).toEqual([1, 4])
		expect(rows.every((row) => Number.isFinite(row.date.getTime()))).toBe(true)
	})

	it("carries the partial flag through, and only when it is true", () => {
		const { rows } = normaliseTimeseriesRows([
			{ bucket: bucketAt(0), partial: false, hits: 1 },
			{ bucket: bucketAt(1), partial: true, hits: 2 },
		])
		expect(rows[0].partial).toBeUndefined()
		expect(rows[1].partial).toBe(true)
	})

	it("yields nothing at all when handed something that is not an array", () => {
		// A share page handing over an envelope where an array belongs must draw an
		// empty plot, not sample curves labelled "A" and "B".
		expect(normaliseTimeseriesRows(undefined)).toEqual({ rows: [], seriesDefinitions: [] })
	})
})

describe("scaleTimeseriesRates", () => {
	const rows: TimeseriesRow[] = [
		{ bucket: bucketAt(0), date: new Date(0), s1: 600, s2: 60 },
		{ bucket: bucketAt(1), date: new Date(HOUR_MS), partial: true, s1: 1200, s2: 0 },
	]

	it("divides every series by the bucket length for requests_per_sec", () => {
		const scaled = scaleTimeseriesRates(rows, ["s1", "s2"], "requests_per_sec", 60)

		expect(scaled.map((row) => row.s1)).toEqual([10, 20])
		expect(scaled.map((row) => row.s2)).toEqual([1, 0])
		// The bucket, its date and its partial flag survive the conversion.
		expect(scaled[1].bucket).toBe(rows[1].bucket)
		expect(scaled[1].date).toBe(rows[1].date)
		expect(scaled[1].partial).toBe(true)
		expect(scaled[0].partial).toBeUndefined()
	})

	it("returns the SAME array for any other unit, so downstream memos hold", () => {
		expect(scaleTimeseriesRates(rows, ["s1"], "ms", 60)).toBe(rows)
		expect(scaleTimeseriesRates(rows, ["s1"], undefined, 60)).toBe(rows)
	})

	it("returns the same array when the bucket length could not be inferred", () => {
		// A single-point series has no spacing to measure; dividing by an unknown
		// would be a silent order-of-magnitude error.
		expect(scaleTimeseriesRates(rows, ["s1"], "requests_per_sec", undefined)).toBe(rows)
	})
})

describe("asFiniteNumber", () => {
	it("coerces numeric strings and floors everything unusable at zero", () => {
		expect(asFiniteNumber(3)).toBe(3)
		expect(asFiniteNumber("3.5")).toBe(3.5)
		expect(asFiniteNumber(null)).toBe(0)
		expect(asFiniteNumber(undefined)).toBe(0)
		expect(asFiniteNumber("nope")).toBe(0)
		expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBe(0)
	})
})

describe("timeseriesYAxis", () => {
	const rows: TimeseriesRow[] = [
		{ bucket: bucketAt(0), date: new Date(0), s1: 40, s2: 30 },
		{ bucket: bucketAt(1), date: new Date(HOUR_MS), s1: 60, s2: 10 },
	]

	/** What the axis will actually scale by, read back off the pinned instance. */
	const scaleDomain = (axis: ReturnType<typeof timeseriesYAxis>): number[] => [...axis.y.scale.domain()]

	it("returns the domain its own scale was pinned to", () => {
		// The whole point of returning it: a stacked band fills from the axis
		// FLOOR, and a floor that disagrees with the scale is a band drawn off the
		// bottom of the plot.
		const axis = timeseriesYAxis({ rows, visibleKeys: ["s1", "s2"] })
		expect(axis.domain).toEqual([0, 60])
		expect(scaleDomain(axis)).toEqual([...axis.domain])
	})

	it("reports the fitted floor rather than zero", () => {
		const axis = timeseriesYAxis({ rows, visibleKeys: ["s1"], fitYAxisToData: true })
		// 40 minus 10% of the 40..60 extent.
		expect(axis.domain[0]).toBeCloseTo(38)
		expect(scaleDomain(axis)).toEqual([...axis.domain])
	})

	it("reports the soft minimum rather than zero", () => {
		const axis = timeseriesYAxis({ rows, visibleKeys: ["s1"], softMin: -20 })
		expect(axis.domain[0]).toBe(-20)
		expect(scaleDomain(axis)).toEqual([...axis.domain])
	})

	it("reports the log floor of 1, never zero", () => {
		// `scales.y.map(0)` on a log axis is -Infinity and nothing downstream
		// clamps it, so a caller filling from "zero" would blow up the path.
		const axis = timeseriesYAxis({ rows, visibleKeys: ["s1"], logScale: true })
		expect(axis.domain[0]).toBe(1)
		expect(scaleDomain(axis)).toEqual([...axis.domain])
	})

	it("widens to the stack total when stacked", () => {
		const axis = timeseriesYAxis({ rows, visibleKeys: ["s1", "s2"], stacked: true })
		expect(axis.domain).toEqual([0, 70])
	})
})
