import { beforeEach, describe, expect, it } from "vitest"

import {
	MAX_ENTRIES,
	MAX_RETAINED_AGE_MS,
	clearRetainedResults,
	nextRetentionNamespace,
	retainResult,
	retainedResult,
	retainedResultCount,
} from "./result-retention"

const T0 = Date.parse("2026-03-08T14:30:00.000Z")

beforeEach(() => {
	clearRetainedResults()
})

describe("retainResult / retainedResult", () => {
	it("returns the retained value with its timestamp", () => {
		retainResult("q", { rows: 3 }, T0)

		expect(retainedResult("q", T0 + 1000)).toEqual({ value: { rows: 3 }, timestamp: T0 })
	})

	it("returns undefined for an identity never seen", () => {
		expect(retainedResult("missing", T0)).toBeUndefined()
	})

	it("overwrites an earlier value for the same identity", () => {
		retainResult("q", "old", T0)
		retainResult("q", "new", T0 + 1000)

		expect(retainedResult("q", T0 + 1000)?.value).toBe("new")
		expect(retainedResultCount()).toBe(1)
	})
})

describe("nextRetentionNamespace", () => {
	it("hands out a distinct namespace per call", () => {
		expect(nextRetentionNamespace()).not.toBe(nextRetentionNamespace())
	})

	// Regression: two queries that take nothing but a time window both reduce to
	// the identity `{}`. Un-namespaced, one served the other's rows as a fallback
	// and the consuming component crashed on the unexpected shape.
	it("keeps same-shaped identities from different families apart", () => {
		const facets = nextRetentionNamespace()
		const overview = nextRetentionNamespace()
		const identity = "org_1:{}"

		retainResult(`${facets}:${identity}`, { environments: ["production"] }, T0)
		retainResult(`${overview}:${identity}`, { services: 20 }, T0)

		expect(retainedResult(`${facets}:${identity}`, T0)?.value).toEqual({
			environments: ["production"],
		})
		expect(retainedResult(`${overview}:${identity}`, T0)?.value).toEqual({ services: 20 })
	})
})

describe("age bound", () => {
	it("serves a value inside MAX_RETAINED_AGE_MS", () => {
		retainResult("q", "v", T0)

		expect(retainedResult("q", T0 + MAX_RETAINED_AGE_MS)?.value).toBe("v")
	})

	it("drops a value past MAX_RETAINED_AGE_MS rather than painting stale data", () => {
		retainResult("q", "v", T0)

		expect(retainedResult("q", T0 + MAX_RETAINED_AGE_MS + 1)).toBeUndefined()
	})

	it("evicts the expired entry on read instead of leaving it resident", () => {
		retainResult("q", "v", T0)
		retainedResult("q", T0 + MAX_RETAINED_AGE_MS + 1)

		expect(retainedResultCount()).toBe(0)
	})
})

describe("LRU bound", () => {
	it("never exceeds the cap", () => {
		for (let i = 0; i < MAX_ENTRIES * 2; i++) retainResult(`q${i}`, i, T0)

		expect(retainedResultCount()).toBeLessThanOrEqual(MAX_ENTRIES)
	})

	it("evicts the least recently used entry first", () => {
		for (let i = 0; i < MAX_ENTRIES; i++) retainResult(`q${i}`, i, T0)

		// Touch the oldest so it is no longer the eviction candidate.
		expect(retainedResult("q0", T0)?.value).toBe(0)

		retainResult("overflow", "x", T0)

		expect(retainedResult("q0", T0)?.value).toBe(0)
		expect(retainedResult("q1", T0)).toBeUndefined()
	})

	it("keeps what the user keeps coming back to", () => {
		retainResult("hot", "v", T0)

		for (let i = 0; i < MAX_ENTRIES * 2; i++) {
			retainResult(`cold${i}`, i, T0)
			retainedResult("hot", T0)
		}

		expect(retainedResult("hot", T0)?.value).toBe("v")
	})
})
