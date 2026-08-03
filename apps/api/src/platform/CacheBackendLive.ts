import { Effect, Layer } from "effect"
import { WorkersCache } from "@maple/effect-cloudflare/workers-cache"
import { CacheBackend, type EdgeCacheBackend, makeMemoryBackend } from "@maple/cache"

// ---------------------------------------------------------------------------
// Concrete `CacheBackend` implementation for the API runtime.
//
// The edge-cache logic (and the pure in-memory fallback) lives in
// `@maple/cache`; only the Cloudflare Workers backend lives here,
// so the Workers runtime API never enters the query-engine package (and thus
// never the web/cli bundles). The default cache is obtained via the
// `WorkersCache` Effect service from `@maple/effect-cloudflare` — prod gets the
// Workers cache; tests/dev get `null` and fall back to the in-memory backend.
// ---------------------------------------------------------------------------

const SYNTHETIC_HOST = "https://maple-api.internal"

const buildCacheUrl = (bucket: string, hash: string): string => `${SYNTHETIC_HOST}/cache/${bucket}/${hash}`

const makeWorkersBackend = (cache: Cache): EdgeCacheBackend => ({
	name: "workers-cache",
	get: async (bucket, hash) => {
		const response = await cache.match(buildCacheUrl(bucket, hash))
		if (!response) return undefined
		try {
			return (await response.json()) as unknown
		} catch {
			return undefined
		}
	},
	put: async (bucket, hash, value, ttlSeconds) => {
		const body = JSON.stringify(value)
		const response = new Response(body, {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": `max-age=${ttlSeconds}`,
			},
		})
		await cache.put(buildCacheUrl(bucket, hash), response)
	},
	delete: async (bucket, hash) => {
		await cache.delete(buildCacheUrl(bucket, hash))
	},
})

export const CacheBackendLive = Layer.effect(
	CacheBackend,
	Effect.gen(function* () {
		const cache = yield* WorkersCache
		if (!cache) {
			// The fallback is per-isolate, so nothing is shared across requests that
			// land elsewhere. Silent selection made this indistinguishable from a
			// working edge cache; log it once per isolate and tag every span via
			// `cache.backend`.
			yield* Effect.logWarning(
				"Workers cache unavailable — edge cache falling back to per-isolate memory",
			)
			return CacheBackend.of(makeMemoryBackend())
		}
		return CacheBackend.of(makeWorkersBackend(cache))
	}),
).pipe(Layer.provide(WorkersCache.layer))
