import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { createTtlCache } from "./ttl-cache.js"

/**
 * The point of this cache is that expiry FREES memory. Its users hold Slack
 * bot tokens and Maple API keys, so "expired but still in the map" is the bug
 * these tests exist to prevent — including for a key that is never looked up
 * again, which is the case no lazy per-key check can ever reach.
 */

interface Entry {
	readonly expiresAt: number
	readonly value: string
}

const T0 = new Date("2026-07-21T12:00:00Z")
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs)

afterEach(() => {
	setSystemTime() // restore the real clock
})

describe("createTtlCache", () => {
	test("serves an entry until it expires, then forgets it", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 1_000 })
		cache.set("a", { expiresAt: T0.getTime() + 500, value: "A" })

		setSystemTime(at(499))
		expect(cache.get("a")?.value).toBe("A")
		expect(cache.size).toBe(1)

		setSystemTime(at(501))
		expect(cache.get("a")).toBeUndefined()
		// Not merely unserved — dropped, so the credential it held is unreachable.
		expect(cache.size).toBe(0)
	})

	test("a write sweeps entries whose own key is never touched again", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 1_000 })
		cache.set("gone-forever", { expiresAt: T0.getTime() + 500, value: "A" })

		// Some other key resolves later; the abandoned entry goes with the sweep.
		setSystemTime(at(1_500))
		cache.set("b", { expiresAt: at(1_500).getTime() + 500, value: "B" })
		expect(cache.size).toBe(1)
		expect(cache.get("b")?.value).toBe("B")
	})

	test("sweeps are rate-limited but the cap still evicts oldest insertions", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 3, sweepIntervalMs: 60_000 })
		const live = T0.getTime() + 60_000
		cache.set("a", { expiresAt: live, value: "A" })
		cache.set("b", { expiresAt: live, value: "B" })
		cache.set("c", { expiresAt: live, value: "C" })
		expect(cache.size).toBe(3)

		// Nothing has expired, so the cap is what bounds the map.
		cache.set("d", { expiresAt: live, value: "D" })
		expect(cache.size).toBe(3)
		expect(cache.get("a")).toBeUndefined()
		expect(cache.get("d")?.value).toBe("D")
	})

	test("refreshing an existing key does not evict a stranger", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 3, sweepIntervalMs: 60_000 })
		const live = T0.getTime() + 60_000
		cache.set("a", { expiresAt: live, value: "A" })
		cache.set("b", { expiresAt: live, value: "B" })
		cache.set("c", { expiresAt: live, value: "C" })

		cache.set("b", { expiresAt: live, value: "B2" })
		expect(cache.size).toBe(3)
		expect(cache.get("a")?.value).toBe("A")
		expect(cache.get("b")?.value).toBe("B2")
	})

	test("the background sweep drops expired entries with no cache traffic at all", async () => {
		// Real clock here: this is the guarantee an idle process depends on, and
		// it is the timer — not a later get/set — that has to deliver it.
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 5 })
		cache.set("a", { expiresAt: Date.now() + 1, value: "A" })
		expect(cache.size).toBe(1)

		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(cache.size).toBe(0)
	})

	test("delete() drops one entry immediately, ahead of its TTL", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 1_000 })
		cache.set("a", { expiresAt: T0.getTime() + 60_000, value: "A" })
		cache.set("b", { expiresAt: T0.getTime() + 60_000, value: "B" })

		cache.delete("a")
		expect(cache.get("a")).toBeUndefined()
		expect(cache.get("b")?.value).toBe("B")
		expect(cache.size).toBe(1)
	})

	test("delete() on a missing key is a no-op", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 1_000 })
		cache.set("a", { expiresAt: T0.getTime() + 60_000, value: "A" })

		cache.delete("nonexistent")
		expect(cache.size).toBe(1)
	})

	test("clear() empties the cache", () => {
		setSystemTime(T0)
		const cache = createTtlCache<Entry>({ maxEntries: 10, sweepIntervalMs: 1_000 })
		cache.set("a", { expiresAt: T0.getTime() + 60_000, value: "A" })
		cache.clear()
		expect(cache.size).toBe(0)
		expect(cache.get("a")).toBeUndefined()
	})
})
