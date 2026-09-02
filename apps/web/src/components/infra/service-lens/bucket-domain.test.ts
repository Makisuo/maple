import { describe, expect, it } from "vitest"

import { unifiedBucketDomain } from "./bucket-domain"

const ISO = ["2026-08-31T10:00:00.000Z", "2026-08-31T10:05:00.000Z", "2026-08-31T10:10:00.000Z"]
const WAREHOUSE = ["2026-08-31 10:00:00", "2026-08-31 10:05:00", "2026-08-31 10:10:00"]

describe("unifiedBucketDomain", () => {
	it("treats the two warehouse spellings of one instant as one bucket", () => {
		// The bug: 3 + 3 became 6 positions, not 3.
		expect(unifiedBucketDomain([ISO, WAREHOUSE])).toEqual(ISO)
	})

	it("stays chronological across mixed formats", () => {
		// A naive sort puts every space-format bucket before every ISO one, so
		// the axis replays the window: 10:00, 10:05, 10:10, 10:00, 10:05, 10:10.
		const domain = unifiedBucketDomain([[ISO[2]!, WAREHOUSE[0]!], [WAREHOUSE[1]!]])
		expect(domain).toEqual([ISO[0], ISO[1], ISO[2]])
		expect(domain.every((v, i, a) => i === 0 || a[i - 1]! < v)).toBe(true)
	})

	it("survives a source with no buckets", () => {
		expect(unifiedBucketDomain([ISO, []])).toEqual(ISO)
		expect(unifiedBucketDomain([])).toEqual([])
	})

	it("is stable when both sources already agree", () => {
		expect(unifiedBucketDomain([ISO, ISO])).toEqual(ISO)
	})
})
