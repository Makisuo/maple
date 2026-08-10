import { Effect, Layer, Metric } from "effect"
import { WorkersCache } from "@maple/effect-cloudflare/workers-cache"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { CacheBackend, type EdgeCacheBackend, makeMemoryBackend } from "@maple/cache"
import * as QueryEngineMetrics from "@/observability/QueryEngineMetrics"

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

/**
 * Minimal structural view of a Workers KV binding — enough for the three
 * `EdgeCacheBackend` operations. Duck-typed rather than importing
 * `@cloudflare/workers-types`, matching how `worker.ts` reads `MCP_SESSIONS`.
 */
interface KvLike {
	get(key: string, type: "json"): Promise<unknown | null>
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
	delete(key: string): Promise<void>
}

const isKvLike = (candidate: unknown): candidate is KvLike =>
	typeof candidate === "object" &&
	candidate !== null &&
	"get" in candidate &&
	"put" in candidate &&
	"delete" in candidate

// KV rejects an `expirationTtl` below 60s.
const KV_MIN_TTL_SECONDS = 60

/**
 * Workers KV as the edge-cache backend, trialled against `caches.default`.
 *
 * The Cache API is not slow — measured on 2026-08-10, a completed `cache.match()`
 * costs a p50 of 7ms. The problem is that 15% of reads never complete: a
 * `cache.match()` holds one of the Worker's six simultaneous-connection slots
 * while it waits for response headers, and it is **not cancellable**, so the
 * 40ms deadline abandons the wait but not the slot — `compute` then opens a
 * seventh connection and queues behind the read it just gave up on (p95 16.4s,
 * 1003s of blocked wall time in one day). See `DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS`.
 *
 * KV is worth trying because a `get` is an ordinary subrequest rather than an
 * uncancellable cache read, so abandoning one is closer to actually free. That
 * is the hypothesis, NOT a measured fact — if KV turns out to contend for the
 * same six slots it will show the same bimodal split. `cache.backend` is on
 * every `getOrCompute` span precisely so the two can be compared; check the
 * `cache.read_status` distribution per backend before trusting this.
 *
 * `cacheTtl` is left at the KV default (60s). Raising it would buy more
 * colo-local hits, but a colo that has the key cached would keep serving it for
 * that long after an explicit `delete` — and invalidation-on-mutation is the
 * property the org config cache is relying on.
 *
 * Values are stored wrapped as `{ v, exp }`, which the other two backends do not
 * need:
 *
 * - `v` because `EdgeCacheBackend` uses `undefined` to mean "not cached" while a
 *   cached `null` is a legitimate value — for the org config bucket it is the
 *   COMMON one ("this org is managed, use Tinybird"), and caching it is the
 *   single biggest win there. KV's `get` returns `null` for a missing key, so
 *   storing a bare `null` would make every managed org a permanent miss.
 * - `exp` because KV refuses an `expirationTtl` under 60s, and real buckets ask
 *   for less (`qe-evaluate` and the integrations routes use 30s). The other
 *   backends carry their own deadline (`Cache-Control: max-age`, `expiresAt`),
 *   so without this a 30s entry would be served for 60s. `expirationTtl` still
 *   goes out at the 60s floor to bound storage; `exp` is what expires the read.
 */
export const makeKvBackend = (kv: KvLike): EdgeCacheBackend => {
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`

	return {
		name: "workers-kv",
		get: async (bucket, hash, nowMs) => {
			const envelope = await kv.get(composite(bucket, hash), "json")
			if (envelope === null || typeof envelope !== "object" || !("v" in envelope)) return undefined
			const { v, exp } = envelope as { v: unknown; exp?: number }
			// KV cannot expire an entry sooner than 60s, so short-TTL buckets carry
			// their real deadline in the envelope and expire on read.
			if (typeof exp === "number" && nowMs >= exp) return undefined
			return v
		},
		put: async (bucket, hash, value, ttlSeconds, nowMs) => {
			const ttl = Math.floor(ttlSeconds)
			await kv.put(
				composite(bucket, hash),
				JSON.stringify({ v: value, exp: nowMs + ttl * 1_000 }),
				{ expirationTtl: Math.max(KV_MIN_TTL_SECONDS, ttl) },
			)
		},
		delete: async (bucket, hash) => {
			await kv.delete(composite(bucket, hash))
		},
	}
}

export const CacheBackendLive = Layer.effect(
	CacheBackend,
	Effect.gen(function* () {
		const env = yield* WorkerEnvironment
		const kv = env.EDGE_CACHE
		if (isKvLike(kv)) {
			return CacheBackend.of(makeKvBackend(kv))
		}

		const cache = yield* WorkersCache
		if (!cache) {
			// The fallback is per-isolate, so nothing is shared across requests that
			// land elsewhere. Silent selection made this indistinguishable from a
			// working edge cache; log it once per isolate, count it so the condition
			// is visible in metrics rather than only in logs, and tag every span via
			// `cache.backend`.
			yield* Effect.logWarning(
				"Workers cache unavailable — edge cache falling back to per-isolate memory",
			)
			yield* Metric.update(QueryEngineMetrics.cacheBackendMemoryFallback, 1)
			return CacheBackend.of(makeMemoryBackend())
		}
		return CacheBackend.of(makeWorkersBackend(cache))
	}),
).pipe(Layer.provide(Layer.mergeAll(WorkersCache.layer, WorkerEnvironment.layer)))
