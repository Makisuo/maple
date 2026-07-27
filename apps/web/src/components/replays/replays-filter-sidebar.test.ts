import { describe, expect, it } from "vitest"

import { toDurationBuckets } from "./replays-filter-sidebar"

// The warehouse buckets session length into half-octaves from 1s and returns
// only the non-empty ones. If the client's reconstruction disagrees with that
// formula, the histogram silently mislabels its own axis.

describe("toDurationBuckets", () => {
	it("converts a bucket floor in ms to a seconds range ending at floor × √2", () => {
		const [bucket] = toDurationBuckets([{ name: "1000", count: 12 }])
		expect(bucket).toEqual({ from: 1, to: Math.SQRT2, count: 12 })
	})

	it("recovers the octave index the warehouse rounded to", () => {
		// 30s lands in the bucket the server writes as 22627ms (2^4.5 seconds).
		const [bucket] = toDurationBuckets([{ name: "22627", count: 3 }])
		expect(bucket!.from).toBeCloseTo(22.627, 3)
		expect(bucket!.to).toBeCloseTo(32, 3)
		expect(bucket!.from).toBeLessThan(30)
		expect(bucket!.to).toBeGreaterThan(30)
	})

	it("fills empty buckets so the axis stays continuous", () => {
		// 1s and 8s, three half-octaves apart, with nothing in between.
		const buckets = toDurationBuckets([
			{ name: "8000", count: 5 },
			{ name: "1000", count: 9 },
		])
		expect(buckets).toHaveLength(7)
		expect(buckets.map((b) => b.count)).toEqual([9, 0, 0, 0, 0, 0, 5])
		expect(buckets[0]!.from).toBeCloseTo(1, 6)
		expect(buckets[6]!.from).toBeCloseTo(8, 6)
	})

	it("returns buckets in ascending order regardless of row order", () => {
		const buckets = toDurationBuckets([
			{ name: "4000", count: 1 },
			{ name: "1000", count: 2 },
			{ name: "2000", count: 3 },
		])
		expect(buckets.map((b) => b.from)).toEqual(buckets.map((b) => b.from).sort((a, b) => a - b))
	})

	it("each bucket's ceiling is the next bucket's floor", () => {
		const buckets = toDurationBuckets([
			{ name: "1000", count: 1 },
			{ name: "16000", count: 1 },
		])
		for (let i = 0; i < buckets.length - 1; i++) {
			expect(buckets[i]!.to).toBeCloseTo(buckets[i + 1]!.from, 6)
		}
	})

	// One abandoned tab measured in days stretches a log axis past 500h and
	// squashes every genuine session into the first few pixels.
	it("folds a far outlier into one unbounded bar instead of stretching the axis", () => {
		const buckets = toDurationBuckets([
			{ name: "1000", count: 500 },
			{ name: "2000", count: 500 },
			// A ~24-day session, 21 octaves out.
			{ name: "2097152000", count: 1 },
		])
		const last = buckets[buckets.length - 1]!
		expect(last.unbounded).toBe(true)
		expect(last.count).toBe(1)
		expect(last.to).toBe(Number.POSITIVE_INFINITY)
		// The axis now ends just past the real data rather than 21 octaves out.
		expect(buckets.length).toBeLessThan(6)
	})

	it("keeps the tail inline when it is not an outlier", () => {
		const buckets = toDurationBuckets([
			{ name: "1000", count: 1 },
			{ name: "2000", count: 1 },
			{ name: "4000", count: 1 },
		])
		expect(buckets.some((b) => b.unbounded)).toBe(false)
		expect(buckets.at(-1)!.to).toBeCloseTo(4 * Math.SQRT2, 6)
	})

	it("never reports a bucket the warehouse had no sessions for as the overflow", () => {
		const buckets = toDurationBuckets([{ name: "1000", count: 7 }])
		expect(buckets).toEqual([{ from: 1, to: Math.SQRT2, count: 7 }])
	})

	it("drops rows that aren't a usable bucket floor", () => {
		expect(toDurationBuckets([{ name: "p50", count: 4200 }])).toEqual([])
		expect(toDurationBuckets([{ name: "0", count: 3 }])).toEqual([])
		expect(toDurationBuckets([])).toEqual([])
	})
})
