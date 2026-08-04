import { describe, expect, it } from "vitest"

import { rollingCountBuckets } from "./rolling-counts"

const MINUTE = 60_000
const STEP = 5 * MINUTE
const WINDOW = 30 * MINUTE

describe("rollingCountBuckets", () => {
	it("builds rolling 30-minute values every five minutes", () => {
		const rows = Array.from({ length: 7 }, (_, index) => ({
			bucketMs: index * STEP,
			count: index + 1,
		}))

		expect(
			rollingCountBuckets(rows, {
				startMs: 30 * MINUTE,
				endMs: 40 * MINUTE,
				stepMs: STEP,
				windowMs: WINDOW,
			}),
		).toEqual([
			{ bucketMs: 30 * MINUTE, count: 21 },
			{ bucketMs: 35 * MINUTE, count: 27 },
			{ bucketMs: 40 * MINUTE, count: 25 },
		])
	})

	it("zero-fills missing source buckets and empty windows", () => {
		expect(
			rollingCountBuckets(
				[
					{ bucketMs: 0, count: 2 },
					{ bucketMs: 10 * MINUTE, count: 3 },
				],
				{
					startMs: 5 * MINUTE,
					endMs: 40 * MINUTE,
					stepMs: STEP,
					windowMs: WINDOW,
				},
			),
		).toEqual([
			{ bucketMs: 5 * MINUTE, count: 2 },
			{ bucketMs: 10 * MINUTE, count: 2 },
			{ bucketMs: 15 * MINUTE, count: 5 },
			{ bucketMs: 20 * MINUTE, count: 5 },
			{ bucketMs: 25 * MINUTE, count: 5 },
			{ bucketMs: 30 * MINUTE, count: 5 },
			{ bucketMs: 35 * MINUTE, count: 3 },
			{ bucketMs: 40 * MINUTE, count: 3 },
		])

		expect(
			rollingCountBuckets([], {
				startMs: 0,
				endMs: 10 * MINUTE,
				stepMs: STEP,
				windowMs: WINDOW,
			}),
		).toEqual([
			{ bucketMs: 0, count: 0 },
			{ bucketMs: 5 * MINUTE, count: 0 },
			{ bucketMs: 10 * MINUTE, count: 0 },
		])
	})

	it("rejects invalid ranges and intervals", () => {
		expect(
			rollingCountBuckets([], {
				startMs: 10,
				endMs: 0,
				stepMs: STEP,
				windowMs: WINDOW,
			}),
		).toEqual([])
		expect(
			rollingCountBuckets([], {
				startMs: 0,
				endMs: 10,
				stepMs: 0,
				windowMs: WINDOW,
			}),
		).toEqual([])
	})
})
