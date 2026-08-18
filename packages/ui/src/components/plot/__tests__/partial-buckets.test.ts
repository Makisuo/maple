import { describe, expect, it } from "vitest"

import { findFirstPartialIndex, splitAtFirstPartial, trimEmptyTrailingBuckets } from "../partial-buckets"

interface Row {
	bucket: string
	partial?: boolean
	throughput?: number | null
	errors?: number | null
}

function row(bucket: string, values: Partial<Row> = {}): Row {
	return { bucket, ...values }
}

/** An ISO timestamp `hours` before `now`. */
function hoursAgo(hours: number, now: number): string {
	return new Date(now - hours * 3600_000).toISOString()
}

describe("findFirstPartialIndex", () => {
	it("finds nothing when every bucket has closed", () => {
		const now = Date.now()
		// 1h buckets; the last ends 1h ago.
		const rows = [4, 3, 2].map((h) => row(hoursAgo(h, now), { throughput: 10 }))
		expect(findFirstPartialIndex(rows, { now })).toBe(-1)
	})

	it("flags the in-flight trailing bucket by wall clock", () => {
		const now = Date.now()
		const rows = [2, 1, 0].map((h) => row(hoursAgo(h, now), { throughput: 10 }))
		// The bucket starting now ends in the future.
		expect(findFirstPartialIndex(rows, { now })).toBe(2)
	})

	it("prefers an explicit `partial` flag over the wall-clock heuristic", () => {
		const now = Date.now()
		// Every bucket closed long ago, so wall clock alone would find nothing —
		// but the pipeline knows about ingestion lag and says otherwise.
		const rows = [
			row(hoursAgo(4, now), { throughput: 10 }),
			row(hoursAgo(3, now), { throughput: 20 }),
			row(hoursAgo(2, now), { throughput: 30, partial: true }),
		]
		expect(findFirstPartialIndex(rows, { now })).toBe(2)
	})

	it("gives up when the interval cannot be inferred from one point", () => {
		const now = Date.now()
		expect(findFirstPartialIndex([row(hoursAgo(1, now), { throughput: 1 })], { now })).toBe(-1)
		expect(findFirstPartialIndex([], { now })).toBe(-1)
	})
})

describe("trimEmptyTrailingBuckets", () => {
	/**
	 * The current interval is usually queried before any of its data lands, so it
	 * returns empty or zero-filled. Plotting it draws a cliff to zero at the right
	 * edge that reads as an outage — and `fillNulls: 0` produces the same picture,
	 * so no presentation setting fixes it.
	 */
	it("drops an empty trailing partial bucket", () => {
		const rows = [row("a", { throughput: 10 }), row("b", { throughput: 20 }), row("c", { throughput: 0 })]
		expect(trimEmptyTrailingBuckets(rows, ["throughput"], 2)).toHaveLength(2)
	})

	it("keeps a trailing partial bucket that reported real data", () => {
		const rows = [row("a", { throughput: 10 }), row("b", { throughput: 20 }), row("c", { throughput: 5 })]
		expect(trimEmptyTrailingBuckets(rows, ["throughput"], 2)).toHaveLength(3)
	})

	it("trims only the empty tail when several partial buckets follow", () => {
		const rows = [
			row("a", { throughput: 10 }),
			row("b", { throughput: 7 }),
			row("c", { throughput: 0 }),
			row("d", { throughput: null }),
		]
		expect(trimEmptyTrailingBuckets(rows, ["throughput"], 1)).toHaveLength(2)
	})

	it("treats a row as empty only when EVERY value key is empty", () => {
		const rows = [row("a", { throughput: 10, errors: 1 }), row("b", { throughput: 0, errors: 3 })]
		expect(trimEmptyTrailingBuckets(rows, ["throughput", "errors"], 1)).toHaveLength(2)
	})

	it("is identity when nothing is partial", () => {
		const rows = [row("a", { throughput: 0 })]
		expect(trimEmptyTrailingBuckets(rows, ["throughput"], -1)).toBe(rows)
	})
})

describe("splitAtFirstPartial", () => {
	it("returns everything solid when no bucket is in flight", () => {
		const rows = [row("a", { throughput: 1 }), row("b", { throughput: 2, partial: false })]
		const split = splitAtFirstPartial(rows, ["throughput"], { now: Date.parse("2030-01-01") })
		expect(split.hasPartial).toBe(false)
		expect(split.solid).toBe(rows)
		expect(split.dashed).toEqual([])
	})

	it("shares a bridge row so the dashed tail starts where the solid run ends", () => {
		const rows = [
			row("a", { throughput: 1 }),
			row("b", { throughput: 2 }),
			row("c", { throughput: 3, partial: true }),
		]
		const split = splitAtFirstPartial(rows, ["throughput"])
		expect(split.hasPartial).toBe(true)
		expect(split.solid.map((r) => r.bucket)).toEqual(["a", "b"])
		// "b" appears in BOTH slices — that overlap is the bridge, and without it
		// the dashed segment would start one bucket late, leaving a visible gap.
		expect(split.dashed.map((r) => r.bucket)).toEqual(["b", "c"])
	})

	it("puts the whole series in the dashed slice when nothing has closed", () => {
		const rows = [row("a", { throughput: 1, partial: true }), row("b", { throughput: 2 })]
		const split = splitAtFirstPartial(rows, ["throughput"])
		expect(split.solid).toEqual([])
		expect(split.dashed).toHaveLength(2)
	})

	it("reports no partial segment when every in-flight bucket was empty", () => {
		const rows = [
			row("a", { throughput: 10 }),
			row("b", { throughput: 20 }),
			row("c", { throughput: 0, partial: true }),
		]
		const split = splitAtFirstPartial(rows, ["throughput"])
		// The empty tail is trimmed, so there is nothing left to draw dashed and
		// the series simply ends at the last bucket that reported.
		expect(split.hasPartial).toBe(false)
		expect(split.dashed).toEqual([])
		expect(split.solid.map((r) => r.bucket)).toEqual(["a", "b"])
	})
})
