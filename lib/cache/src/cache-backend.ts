import { Context, Layer } from "effect"

/**
 * Internal storage interface for the edge cache. The concrete implementation is
 * injected as a `CacheBackend` layer. The bundle-sensitive Cloudflare Workers
 * backend (which closes over `globalThis.caches`) lives in the host app; the
 * pure in-memory backend below ships here so tests/dev and non-Workers hosts
 * have a default without pulling a runtime binding into the package.
 */
export interface EdgeCacheBackend {
	/**
	 * Which storage is actually behind this backend, surfaced on every
	 * `EdgeCacheService.getOrCompute` span as `cache.backend`. Without it there is
	 * no signal distinguishing the shared Workers cache from the per-isolate
	 * `memory` fallback — which is silently selected whenever `caches` is
	 * undefined, and makes every cross-request hit disappear.
	 */
	readonly name: "workers-cache" | "workers-kv" | "memory"
	readonly get: (bucket: string, hash: string, nowMs: number) => Promise<unknown | undefined>
	readonly put: (
		bucket: string,
		hash: string,
		value: unknown,
		ttlSeconds: number,
		nowMs: number,
	) => Promise<void>
	readonly delete: (bucket: string, hash: string) => Promise<void>
}

/**
 * Injected edge-cache storage backend (Workers KV in prod, in-memory in
 * tests/dev).
 *
 * The tag string still names the old home. Tags are identity, not
 * documentation — `EdgeCacheIOError` next door is a `Schema.TaggedError`
 * whose tag is its serialized `_tag`, so renaming this family for tidiness
 * would be a wire-contract change for no behavioural gain.
 */
export class CacheBackend extends Context.Service<CacheBackend, EdgeCacheBackend>()(
	"@maple/cache/CacheBackend",
) {}

interface MemoryEntry {
	readonly value: unknown
	readonly expiresAt: number
}

/** A pure in-process `EdgeCacheBackend` — used for tests, dev, and non-Workers hosts. */
export const makeMemoryBackend = (): EdgeCacheBackend => {
	const store = new Map<string, MemoryEntry>()
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`

	return {
		name: "memory",
		get: async (bucket, hash, nowMs) => {
			const entry = store.get(composite(bucket, hash))
			if (!entry) return undefined
			if (entry.expiresAt <= nowMs) {
				store.delete(composite(bucket, hash))
				return undefined
			}
			return entry.value
		},
		put: async (bucket, hash, value, ttlSeconds, nowMs) => {
			store.set(composite(bucket, hash), {
				value,
				expiresAt: nowMs + ttlSeconds * 1000,
			})
		},
		delete: async (bucket, hash) => {
			store.delete(composite(bucket, hash))
		},
	}
}

/** `CacheBackend` layer backed by a fresh in-memory store. */
export const MemoryCacheBackendLive = Layer.sync(CacheBackend, () => CacheBackend.of(makeMemoryBackend()))
