import { describe, expect, it } from "vitest"

import {
	HARD_SERIES_LIMIT,
	asFiniteNumber,
	normaliseTimeseriesRows,
	scaleTimeseriesRates,
	timeseriesXAxis,
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
		// The fit puts the floor at 38 — 40 minus 10% of the 40..60 extent — and
		// the axis is then NICED to 35, because the renderer nices a pinned domain
		// too. The reported domain has to be the one that is drawn: a band fills
		// from `domain[0]`, so reporting the pre-nice 38 would leave a blank strip
		// under the whole series.
		expect(axis.domain[0]).toBeCloseTo(35)
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

describe("the shared x axis' label spacing", () => {
	// The port dropped Recharts' `minTickGap={24}` and took the library's 4px
	// thinning default, which packed "01:00 AM 01:30 AM 02:00 AM" nearly edge to
	// edge on a card. `spacing` is the fix — it widens the tick CANDIDATES, so the
	// labels stay on round clock boundaries and evenly spaced — and the gap is the
	// backstop for a tile too narrow for even those.
	it("spaces tick candidates wide enough for a bucket label", () => {
		const axis = timeseriesXAxis({ rangeMs: 6 * 3_600_000, bucketSeconds: 1800 })
		// A bucket label ("01:00 AM") runs ~55px at the axis font size.
		expect(axis.axis.ticks.spacing).toBeGreaterThan(55 * 1.5)
	})

	it("keeps a legible gap when labels still collide", () => {
		const axis = timeseriesXAxis({ rangeMs: 6 * 3_600_000, bucketSeconds: 1800 })
		expect(axis.axis.tickLabels.thin.minGap).toBeGreaterThanOrEqual(12)
	})
})

/**
 * The overhang that read as "the axis is wider than the chart".
 *
 * A centred label on a tick sitting at the domain edge hangs half its width past
 * the plot; the layout solver reserves that as margin and the series ends ~50px
 * short of where its own labels run. Measured in the browser at 49px of right
 * gap on a 672px card, against 4px once the edge label is anchored inward.
 */
describe("the shared x axis' edge tick labels", () => {
	const DAY = 86_400_000
	// The production shape: a six-day window ending at midnight, which is the
	// phase that puts a two-day tick candidate on the last bucket.
	const start = Date.UTC(2026, 7, 13)
	const end = Date.UTC(2026, 7, 19)
	const context = { rangeMs: end - start, bucketSeconds: 3600, domainMs: [start, end] as const }

	const anchorAt = (ms: number) =>
		timeseriesXAxis(context).axis.tickLabels.anchor?.({ value: new Date(ms) })

	it("right-anchors a label on the last bucket so it cannot overhang", () => {
		expect(anchorAt(end)).toBe("end")
	})

	it("left-anchors one on the first bucket", () => {
		expect(anchorAt(start)).toBe("start")
	})

	/**
	 * The tick that triggered this in production sat TWO HOURS inside a six-day
	 * domain — negligible in bucket terms, and still 45px of overhang. A
	 * bucket-sized threshold missed it; the threshold is half a label.
	 */
	it("right-anchors one a rounding error inside the domain", () => {
		expect(anchorAt(end - 2 * 3_600_000)).toBe("end")
	})

	it("leaves an interior label centred on its tick", () => {
		expect(anchorAt(start + 3 * DAY)).toBe("middle")
	})

	/**
	 * Without a domain there is nothing to measure against, and the library's
	 * centred default is right — the query-builder charts that predate this pass
	 * no `domainMs` and must be untouched.
	 */
	it("does not anchor at all when the drawn domain is unknown", () => {
		const axis = timeseriesXAxis({ rangeMs: 6 * DAY, bucketSeconds: 3600 })
		expect(axis.axis.tickLabels.anchor).toBeUndefined()
	})
})
