import { describe, expect, it } from "@effect/vitest"
import { makeKvBackend } from "./CacheBackendLive"

/**
 * Stand-in for a Workers KV binding with the two semantics that matter here:
 * values are stored as strings and round-trip through JSON, and a missing key
 * reads back as `null` — indistinguishable, without care, from a stored `null`.
 */
const makeFakeKv = () => {
	const store = new Map<string, string>()
	return {
		store,
		get: async (key: string, _type: "json") => {
			const raw = store.get(key)
			return raw === undefined ? null : (JSON.parse(raw) as unknown)
		},
		put: async (key: string, value: string, _options?: { expirationTtl?: number }) => {
			store.set(key, value)
		},
		delete: async (key: string) => {
			store.delete(key)
		},
	}
}

describe("makeKvBackend", () => {
	// The regression this guards: `EdgeCacheBackend` signals "not cached" with
	// `undefined`, but a cached `null` is a real value — and on the org-config
	// bucket it is the common one ("managed org, use Tinybird"). KV returns
	// `null` for a missing key, so a bare `null` write would make every managed
	// org a permanent miss and send it to Postgres forever.
	it("round-trips a cached null as a hit, not a miss", async () => {
		const kv = makeFakeKv()
		const backend = makeKvBackend(kv)

		await backend.put("org-clickhouse-config", "hash", null, 3600, Date.now())

		expect(await backend.get("org-clickhouse-config", "hash", Date.now())).toBeNull()
	})

	it("reports an absent key as undefined", async () => {
		const backend = makeKvBackend(makeFakeKv())

		expect(await backend.get("org-clickhouse-config", "never-written", Date.now())).toBeUndefined()
	})

	it("round-trips a struct value and drops it on delete", async () => {
		const kv = makeFakeKv()
		const backend = makeKvBackend(kv)
		const value = { chUrl: "https://a.example", schemaVersion: "4" }

		await backend.put("org-clickhouse-config", "hash", value, 3600, Date.now())
		expect(await backend.get("org-clickhouse-config", "hash", Date.now())).toEqual(value)

		await backend.delete("org-clickhouse-config", "hash")
		expect(await backend.get("org-clickhouse-config", "hash", Date.now())).toBeUndefined()
	})

	// KV rejects a TTL below 60s; the query-result buckets use shorter ones.
	it("raises a sub-minute TTL to KV's 60s floor", async () => {
		const puts: Array<{ expirationTtl?: number }> = []
		const kv = makeFakeKv()
		const backend = makeKvBackend({
			...kv,
			put: async (key, value, options) => {
				puts.push(options ?? {})
				await kv.put(key, value, options)
			},
		})

		await backend.put("qe-direct", "hash", { a: 1 }, 15, Date.now())
		await backend.put("org-clickhouse-config", "hash", { a: 1 }, 3600, Date.now())

		expect(puts[0]?.expirationTtl).toBe(60)
		expect(puts[1]?.expirationTtl).toBe(3600)
	})
})
