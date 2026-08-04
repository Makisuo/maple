import { afterEach, describe, expect, it, vi } from "vitest"
import { encodeKey } from "@/lib/cache-key"
import { REPLAYS_PAGE_SIZE } from "@/hooks/use-infinite-replays"
import { replaysFilterInputs, type ReplaysSearchState } from "./replays-filter-inputs"

/**
 * The route's `loader` prefetches both list queries and the component then reads
 * them. That only pays off if the two produce the *same* atom-family key — a
 * mismatch silently doubles the requests instead of halving the latency, and
 * nothing else in the app would notice. These lock the invariant down.
 */
describe("replaysFilterInputs", () => {
	const listKey = (search: ReplaysSearchState) =>
		encodeKey({ ...replaysFilterInputs(search), limit: REPLAYS_PAGE_SIZE, offset: 0 })
	const facetsKey = (search: ReplaysSearchState) => encodeKey(replaysFilterInputs(search))

	afterEach(() => {
		vi.useRealTimers()
	})

	it("keys identically across the loader/component gap for a relative preset", () => {
		// The loader resolves `now`, then the component resolves it again after the
		// route chunk evaluates. `encodeKey` snaps to a 15s grid, so both land on one
		// entry — this is what makes the prefetch a prefetch rather than a duplicate.
		// Pinned to the start of a bucket and advanced 14s, which is far more than the
		// real gap and keeps the assertion off a grid boundary.
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"))
		const search: ReplaysSearchState = { timePreset: "24h" }

		const loaderList = listKey(search)
		const loaderFacets = facetsKey(search)
		vi.advanceTimersByTime(14_000)

		expect(listKey(search)).toBe(loaderList)
		expect(facetsKey(search)).toBe(loaderFacets)
	})

	it("keys identically with no search params at all (the default 24h entry)", () => {
		expect(listKey({})).toBe(listKey({ timePreset: "24h" }))
	})

	it("keys identically for an absolute window", () => {
		const search: ReplaysSearchState = {
			startTime: "2026-08-01 00:00:00",
			endTime: "2026-08-02 00:00:00",
		}

		expect(listKey(search)).toBe(listKey(search))
		expect(replaysFilterInputs(search)).toMatchObject({
			startTime: "2026-08-01 00:00:00",
			endTime: "2026-08-02 00:00:00",
		})
	})

	it("separates the list and facets keys, which query different shapes", () => {
		const search: ReplaysSearchState = { timePreset: "24h" }

		expect(listKey(search)).not.toBe(facetsKey(search))
	})

	it("changes the key when a filter changes", () => {
		const base: ReplaysSearchState = { startTime: "2026-08-01 00:00:00", endTime: "2026-08-02 00:00:00" }

		expect(listKey({ ...base, browser: "Chrome" })).not.toBe(listKey(base))
		expect(listKey({ ...base, hasErrors: true })).not.toBe(listKey(base))
		expect(listKey({ ...base, q: "checkout" })).not.toBe(listKey(base))
	})

	it("converts the whole-second URL params the warehouse wants in milliseconds", () => {
		const inputs = replaysFilterInputs({
			startTime: "2026-08-01 00:00:00",
			endTime: "2026-08-02 00:00:00",
			durationMin: 30,
			durationMax: 600,
			activeMin: 5,
			activeMax: 120,
		})

		expect(inputs).toMatchObject({
			durationMinMs: 30_000,
			durationMaxMs: 600_000,
			activeTimeMinMs: 5_000,
			activeTimeMaxMs: 120_000,
		})
	})

	it("leaves unset bounds undefined rather than sending 0", () => {
		const inputs = replaysFilterInputs({
			startTime: "2026-08-01 00:00:00",
			endTime: "2026-08-02 00:00:00",
		})

		expect(inputs.durationMinMs).toBeUndefined()
		expect(inputs.activeTimeMaxMs).toBeUndefined()
	})
})
