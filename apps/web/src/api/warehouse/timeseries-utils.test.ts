import { describe, expect, it } from "vitest"
import {
	buildBucketTimeline,
	computeBucketSeconds,
	firstFullBucketIso,
	toIsoBucket,
	trimSparseLeadingBuckets,
} from "@/api/warehouse/timeseries-utils"

describe("timeseries-utils", () => {
	it("normalizes Tinybird datetime strings as UTC buckets", () => {
		expect(toIsoBucket("2026-02-01 00:00:00")).toBe("2026-02-01T00:00:00.000Z")
		expect(toIsoBucket("2026-02-01T00:00:00Z")).toBe("2026-02-01T00:00:00.000Z")
	})

	it("builds deterministic bucket timelines", () => {
		expect(buildBucketTimeline("2026-02-01 00:00:00", "2026-02-01 00:10:00", 300)).toEqual([
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:05:00.000Z",
			"2026-02-01T00:10:00.000Z",
		])
	})

	it("drops the partial leading bucket when startTime is not bucket-aligned", () => {
		// 00:01:30 falls inside the 00:00:00–00:05:00 bucket. That bucket would only
		// receive a partial slice of the query window (the query filter is
		// Timestamp >= startTime), so it'd render as a near-zero leading point.
		// Skip it and start at the next full bucket boundary.
		expect(buildBucketTimeline("2026-02-01 00:01:30", "2026-02-01 00:15:00", 300)).toEqual([
			"2026-02-01T00:05:00.000Z",
			"2026-02-01T00:10:00.000Z",
			"2026-02-01T00:15:00.000Z",
		])
	})

	it("keeps the trailing partial bucket so incomplete segments still render", () => {
		// 00:12:30 falls inside the 00:10:00–00:15:00 bucket. The trailing bucket
		// must be kept so markIncompleteSegments can render the dashed "current"
		// segment at the right edge.
		expect(buildBucketTimeline("2026-02-01 00:00:00", "2026-02-01 00:12:30", 300)).toEqual([
			"2026-02-01T00:00:00.000Z",
			"2026-02-01T00:05:00.000Z",
			"2026-02-01T00:10:00.000Z",
		])
	})

	it("trimSparseLeadingBuckets drops ramp-up leading buckets but preserves diurnal dips", () => {
		const v = (n: number) => ({ value: n })
		const get = (row: { value: number }) => row.value
		// Single zero-value leading bucket (zero-filled by fillServiceDetailPoints).
		expect(trimSparseLeadingBuckets([v(0), v(100), v(120)], get)).toEqual([v(100), v(120)])
		// Ingestion ramp-up: 423 events vs 8.3M next (real numbers from the bug repro).
		expect(trimSparseLeadingBuckets([v(423), v(8_329_454), v(8_024_536)], get)).toEqual([
			v(8_329_454),
			v(8_024_536),
		])
		// Multiple sparse leading buckets all get trimmed.
		expect(trimSparseLeadingBuckets([v(0), v(1), v(10_000), v(9_500)], get)).toEqual([
			v(10_000),
			v(9_500),
		])
		// Diurnal dip (3-AM at ~30% of peak) is preserved.
		expect(trimSparseLeadingBuckets([v(300), v(1_000), v(1_500)], get)).toEqual([
			v(300),
			v(1_000),
			v(1_500),
		])
		// Edge case: a single bucket is returned as-is — nothing to compare against.
		expect(trimSparseLeadingBuckets([v(0)], get)).toEqual([v(0)])
		// Edge case: all-zero series — leave it alone, the chart has its own empty state.
		expect(trimSparseLeadingBuckets([v(0), v(0), v(0)], get)).toEqual([v(0), v(0), v(0)])
	})

	it("firstFullBucketIso returns the first bucket on-or-after startTime", () => {
		// Already bucket-aligned: returns the same instant in ISO form.
		expect(firstFullBucketIso("2026-02-01 00:00:00", 300)).toBe("2026-02-01T00:00:00.000Z")
		// Mid-bucket: rounds up to the next full bucket.
		expect(firstFullBucketIso("2026-02-01 00:01:30", 300)).toBe("2026-02-01T00:05:00.000Z")
		// Larger bucket size.
		expect(firstFullBucketIso("2026-02-01 03:43:21", 3600)).toBe("2026-02-01T04:00:00.000Z")
		// Undefined startTime is a no-op signal.
		expect(firstFullBucketIso(undefined, 300)).toBeNull()
	})

	it("keeps auto bucket sizing deterministic for common ranges", () => {
		// ~100-point target keeps charts dense enough for manual investigation.
		expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 00:30:00")).toBe(60)
		expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 01:00:00")).toBe(60)
		expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-01 06:00:00")).toBe(300)
		expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-02 00:00:00")).toBe(900)
		expect(computeBucketSeconds("2026-02-01 00:00:00", "2026-02-08 00:00:00")).toBe(3600)
	})

	it("never returns an empty timeline for a window narrower than a bucket", () => {
		// 90s window with a 5-min bucket would round to an empty range; the shared
		// helper anchors a single bucket at the window start instead.
		expect(buildBucketTimeline("2026-02-01 00:00:30", "2026-02-01 00:02:00", 300)).toEqual([
			"2026-02-01T00:00:00.000Z",
		])
	})
})
