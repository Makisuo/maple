import { assert, describe, it } from "@effect/vitest"
import { makeTimeRangeCachePolicy, timeRangeCache } from "./cache-policy"
import { buildDirectRouteCacheKey } from "./query-engine"

/**
 * `timeRangeCache` replaced a flat 15s TTL whose snap window was also 15s, so a
 * cache key expired as fast as it churned. In production that combination hit
 * **zero times in 73 reads** on the `qe-direct` bucket: two requests only ever
 * shared an entry if they landed inside the same 15-second wall-clock window,
 * which concurrent widgets on one page load can do but interactive navigation
 * never does.
 *
 * What these tests pin is the trade the fix makes — staleness is allowed to grow
 * only in proportion to the window being asked about, so a live "last 15
 * minutes" view keeps its 15s floor while a 24h view, where a minute of lag is
 * invisible, is allowed to snap to five minutes and actually accumulate hits.
 */

/** `YYYY-MM-DD HH:MM:SS`, the warehouse datetime format `snapToWindow` expects. */
const at = (epochMs: number): string => {
	const iso = new Date(epochMs).toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

const NOW_MS = Date.parse("2026-08-16T12:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A window of `spanMs` ending exactly at `NOW_MS` — the live dashboard case. */
const liveRange = (spanMs: number) => ({
	startTime: at(NOW_MS - spanMs),
	endTime: at(NOW_MS),
})

describe("timeRangeCache", () => {
	it("keeps the 15s floor for a narrow live window, where freshness is the product", () => {
		const policy = timeRangeCache(liveRange(15 * MINUTE), NOW_MS)
		assert.strictEqual(policy.ttlSeconds, 15)
		assert.strictEqual(policy.snapWindowSeconds, 15)
	})

	it("scales the snap window with the span so a 24h view snaps to five minutes", () => {
		const policy = timeRangeCache(liveRange(24 * HOUR), NOW_MS)
		assert.strictEqual(policy.snapWindowSeconds, 300)
		// TTL matches the snap window: an entry only has to outlive the key that
		// addresses it, and that key changes once per window.
		assert.strictEqual(policy.ttlSeconds, 300)
	})

	it("caps the snap window below the 3600s ceiling `snapToWindow` silently ignores", () => {
		// A 30d range would otherwise derive a ~2.5h window, and `snapToWindow`
		// returns the timestamp UNCHANGED above 3600s — the key would stop snapping
		// altogether rather than snapping coarsely.
		const policy = timeRangeCache(liveRange(30 * 24 * HOUR), NOW_MS)
		assert.strictEqual(policy.snapWindowSeconds, 900)
	})

	it("holds a settled window far longer, because its key is fixed", () => {
		// Ends well behind now, so ingestion lag has settled and the absolute
		// timestamps snap to themselves — a revisit hits the same entry directly.
		const policy = timeRangeCache(
			{ startTime: at(NOW_MS - 25 * HOUR), endTime: at(NOW_MS - 24 * HOUR) },
			NOW_MS,
		)
		assert.strictEqual(policy.ttlSeconds, 900)
	})

	it("does not treat a just-closed window as settled", () => {
		// Spans keep arriving for a window after it closes. One minute back is
		// still moving, so it must not earn the long TTL.
		const policy = timeRangeCache(
			{ startTime: at(NOW_MS - HOUR - MINUTE), endTime: at(NOW_MS - MINUTE) },
			NOW_MS,
		)
		assert.strictEqual(policy.ttlSeconds, 15)
	})

	it("falls back to the conservative default rather than guessing from unreadable input", () => {
		for (const payload of [
			{},
			{ startTime: "not-a-date", endTime: at(NOW_MS) },
			{ startTime: at(NOW_MS), endTime: at(NOW_MS) },
			// Inverted range.
			{ startTime: at(NOW_MS), endTime: at(NOW_MS - HOUR) },
		]) {
			const policy = timeRangeCache(payload, NOW_MS)
			assert.strictEqual(policy.ttlSeconds, 15, JSON.stringify(payload))
		}
	})

	it("holds the cache key steady across a revisit, which is the whole point", () => {
		// The property the production 0-hit reading actually reduces to: leave a
		// 24h dashboard and come back 30 seconds later, and the second request must
		// address the SAME entry. Under the flat 15s policy the snapped start and
		// end had both moved on, minting a fresh key every time, so the cache could
		// never be asked a question it had already answered.
		//
		// `NOW_MS` is deliberately aligned to a 300s boundary so the assertion turns
		// on the policy rather than on where the clock happened to fall.
		const aligned = Math.floor(NOW_MS / 300_000) * 300_000
		const revisitMs = aligned + 30_000
		const keyAt = (nowMs: number) =>
			buildDirectRouteCacheKey(
				"org_test",
				"serviceOverview",
				{ startTime: at(nowMs - 24 * HOUR), endTime: at(nowMs) },
				timeRangeCache({ startTime: at(nowMs - 24 * HOUR), endTime: at(nowMs) }, nowMs),
			)

		assert.strictEqual(keyAt(aligned), keyAt(revisitMs))

		// And the same revisit under the policy this replaced, so the guard cannot
		// quietly pass by testing nothing: a flat 15s snap churned the key.
		const legacyKeyAt = (nowMs: number) =>
			buildDirectRouteCacheKey(
				"org_test",
				"serviceOverview",
				{ startTime: at(nowMs - 24 * HOUR), endTime: at(nowMs) },
				15,
			)
		assert.notStrictEqual(legacyKeyAt(aligned), legacyKeyAt(revisitMs))
	})

	it("still mints a fresh key for a narrow live window 30s on", () => {
		// The other half of the trade. A "last 15 minutes" view must NOT reuse a
		// 30-second-old answer — that is the range where staleness is visible.
		const aligned = Math.floor(NOW_MS / 300_000) * 300_000
		const keyAt = (nowMs: number) =>
			buildDirectRouteCacheKey(
				"org_test",
				"serviceOverview",
				{ startTime: at(nowMs - 15 * MINUTE), endTime: at(nowMs) },
				timeRangeCache({ startTime: at(nowMs - 15 * MINUTE), endTime: at(nowMs) }, nowMs),
			)

		assert.notStrictEqual(keyAt(aligned), keyAt(aligned + 30_000))
	})

	it("carries the version through, so a key-semantics bump still invalidates", () => {
		const versioned = makeTimeRangeCachePolicy({ version: 3 })
		assert.strictEqual(versioned(liveRange(24 * HOUR), NOW_MS).version, 3)
		// Unversioned policies stay on 1, matching `makeDirectRouteCachePolicy`.
		assert.strictEqual(timeRangeCache(liveRange(24 * HOUR), NOW_MS).version, 1)
	})
})
