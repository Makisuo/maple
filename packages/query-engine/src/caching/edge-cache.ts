import { Clock, Config, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { CacheBackend, type EdgeCacheBackend } from "./cache-backend"

export { CacheBackend, type EdgeCacheBackend } from "./cache-backend"

export class EdgeCacheIOError extends Schema.TaggedErrorClass<EdgeCacheIOError>()(
	"@maple/api/EdgeCacheIOError",
	{
		op: Schema.Literals(["get", "put"]),
		bucket: Schema.String,
		key: Schema.String,
		cause: Schema.String,
	},
) {}

export interface EdgeCacheGetOrComputeOptions<A = unknown, I = unknown> {
	readonly bucket: string
	readonly key: string
	/** Cache TTL (seconds), or a function deriving it from the computed value — run once on write, never on a hit. */
	readonly ttlSeconds: number | ((value: A) => number)
	/**
	 * Optional codec used to (a) encode the value into a JSON-safe form before
	 * `backend.put`, and (b) decode the cached bytes back into the original
	 * shape on `backend.get`. Required when the cached value is a
	 * `Schema.Class` instance or contains branded/transformed fields, since the
	 * Workers cache backend round-trips through `JSON.stringify` /
	 * `response.json()` and would otherwise return a plain object that fails
	 * downstream schema-typed boundaries (e.g. HTTP success encoding).
	 *
	 * Decode failures are treated as a cache miss (recompute + overwrite) so
	 * that a deploy with an incompatible schema change cannot poison reads.
	 * Encode failures fail loud — they indicate a programmer bug.
	 */
	readonly schema?: Schema.Codec<A, I, never, never>
}

export interface EdgeCacheResult<A> {
	readonly value: A
	readonly hit: boolean
}

interface DeferredAwaiter<A = unknown, E = unknown> {
	readonly await: Effect.Effect<A, E>
}

export interface EdgeCacheInvalidateOptions {
	readonly bucket: string
	readonly key: string
}

export type EdgeCacheReadStatus = "hit" | "miss" | "timeout"

export interface EdgeCacheReadResult<A> {
	readonly status: EdgeCacheReadStatus
	readonly value: Option.Option<A>
	readonly readMs: number
}

export interface EdgeCacheServiceShape {
	readonly getOrCompute: <A, E, R, I = unknown>(
		options: EdgeCacheGetOrComputeOptions<A, I>,
		compute: Effect.Effect<A, E, R>,
	) => Effect.Effect<EdgeCacheResult<A>, E, R>
	/**
	 * Evict a `getOrCompute` entry. Pass the SAME `{ bucket, key }` used to
	 * populate it — `invalidate` derives the storage hash identically
	 * (`sha256Hex(key)`), so the keys line up. Best-effort: a backend delete
	 * failure is logged and swallowed (the entry simply expires via its TTL).
	 */
	readonly invalidate: (options: EdgeCacheInvalidateOptions) => Effect.Effect<void>
	readonly rawGetDetailed: <A>(
		bucket: string,
		key: string,
	) => Effect.Effect<EdgeCacheReadResult<A>, EdgeCacheIOError>
	readonly rawGet: <A>(bucket: string, key: string) => Effect.Effect<Option.Option<A>, EdgeCacheIOError>
	readonly rawPut: (
		bucket: string,
		key: string,
		value: unknown,
		ttlSeconds: number,
	) => Effect.Effect<void, EdgeCacheIOError>
}

const sha256Hex = async (input: string): Promise<string> => {
	const bytes = new TextEncoder().encode(input)
	const digest = await crypto.subtle.digest("SHA-256", bytes)
	const view = new Uint8Array(digest)
	let out = ""
	for (let i = 0; i < view.length; i++) {
		out += view[i]!.toString(16).padStart(2, "0")
	}
	return out
}

/**
 * Build an `EdgeCacheServiceShape` against a specific backend. Exported for
 * tests so they can substitute a fake backend (e.g. a JSON-roundtripping one)
 * without going through `detectWorkersCache`.
 */
export const DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS = 250

export const makeEdgeCacheService = (
	backend: EdgeCacheBackend,
	readTimeoutMs = DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS,
): EdgeCacheServiceShape => {
	const boundedReadTimeoutMs = Number.isFinite(readTimeoutMs)
		? Math.max(1, Math.floor(readTimeoutMs))
		: DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS
	const readBackend = (
		bucket: string,
		key: string,
		nowMs: number,
	): Promise<{ readonly value: unknown | undefined; readonly timedOut: boolean }> => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<{ readonly value: undefined; readonly timedOut: true }>((resolve) => {
			timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), boundedReadTimeoutMs)
		})
		const read = Promise.resolve()
			.then(() => backend.get(bucket, key, nowMs))
			.then((value) => ({ value, timedOut: false as const }))
		return Promise.race([read, deadline]).finally(() => {
			if (timer !== undefined) clearTimeout(timer)
		})
	}
	// Heterogeneous in-flight map keyed by bucket+hash; each entry stores a
	// pre-typed awaiter Effect so callers never need to cast Deferred<any, any>.
	const inFlight = new Map<string, DeferredAwaiter<any, any>>()

	const getOrCompute = Effect.fn("EdgeCacheService.getOrCompute")(function* <A, E, R, I = unknown>(
		options: EdgeCacheGetOrComputeOptions<A, I>,
		compute: Effect.Effect<A, E, R>,
	) {
		const hash = yield* Effect.promise(() => sha256Hex(options.key))
		const composite = `${options.bucket}:${hash}`
		yield* Effect.annotateCurrentSpan({
			"cache.bucket": options.bucket,
			"cache.hit": false,
			"cache.read_ms": 0,
			"cache.read_status": "pending",
			"cache.read_timed_out": false,
		})

		const existing = inFlight.get(composite)
		if (existing) {
			const value = (yield* existing.await) as A
			yield* Effect.annotateCurrentSpan({
				"cache.hit": true,
				"cache.dedup.waited": true,
				"cache.read_status": "deduplicated",
			})
			return { value, hit: true }
		}

		const deferred = yield* Deferred.make<A, E>()
		const awaiter = {
			await: Deferred.await(deferred),
		}
		inFlight.set(composite, awaiter)

		const writeAndPublish = Effect.fnUntraced(function* (value: A) {
			const stored: unknown = options.schema
				? yield* Schema.encodeUnknownEffect(options.schema)(value).pipe(Effect.orDie)
				: value
			const ttlSeconds =
				typeof options.ttlSeconds === "function" ? options.ttlSeconds(value) : options.ttlSeconds
			const writeNowMs = yield* Clock.currentTimeMillis
			yield* Effect.tryPromise({
				try: () => backend.put(options.bucket, hash, stored, ttlSeconds, writeNowMs),
				catch: (error) => error,
			}).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Edge cache put failed; continuing without cache").pipe(
						Effect.annotateLogs({
							bucket: options.bucket,
							key: options.key,
							hash,
							error: String(error),
						}),
					),
				),
				Effect.ignore,
			)
			yield* Deferred.succeed(deferred, value)
		})

		const body = Effect.gen(function* () {
			const readStartedAt = yield* Clock.currentTimeMillis
			const nowMs = readStartedAt
			const read = yield* Effect.tryPromise({
				try: () => readBackend(options.bucket, hash, nowMs),
				catch: (error) => error,
			}).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Edge cache get failed; treating as miss").pipe(
						Effect.annotateLogs({
							bucket: options.bucket,
							key: options.key,
							hash,
							error: String(error),
						}),
					),
				),
				Effect.orElseSucceed(() => ({ value: undefined, timedOut: false as const })),
			)
			const readMs = (yield* Clock.currentTimeMillis) - readStartedAt
			yield* Effect.annotateCurrentSpan({
				"cache.read_ms": readMs,
				"cache.read_status": read.timedOut ? "timeout" : read.value === undefined ? "miss" : "hit",
				"cache.read_timed_out": read.timedOut,
			})

			if (read.value !== undefined) {
				if (options.schema) {
					const decoded = yield* Schema.decodeUnknownEffect(options.schema)(read.value).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Edge cache decode failed; treating as miss").pipe(
								Effect.annotateLogs({
									bucket: options.bucket,
									key: options.key,
									hash,
									error: String(error),
								}),
							),
						),
						Effect.option,
					)
					if (Option.isSome(decoded)) {
						yield* Deferred.succeed(deferred, decoded.value)
						yield* Effect.annotateCurrentSpan("cache.hit", true)
						return { value: decoded.value, hit: true }
					}
					// Fall through to recompute on decode failure (poisoned/stale entry).
					yield* Effect.annotateCurrentSpan("cache.read_status", "decode_miss")
				} else {
					const value = read.value as A
					yield* Deferred.succeed(deferred, value)
					yield* Effect.annotateCurrentSpan("cache.hit", true)
					return { value, hit: true }
				}
			}

			const value = yield* compute
			yield* writeAndPublish(value)
			return { value, hit: false }
		}).pipe(
			Effect.tapError((error) => Deferred.fail(deferred, error)),
			Effect.onInterrupt(() => Deferred.interrupt(deferred)),
			Effect.ensuring(
				Effect.sync(() => {
					if (inFlight.get(composite) === awaiter) inFlight.delete(composite)
				}),
			),
		)

		return yield* body
	})

	const invalidate = Effect.fn("EdgeCacheService.invalidate")(function* (
		options: EdgeCacheInvalidateOptions,
	) {
		const hash = yield* Effect.promise(() => sha256Hex(options.key))
		// Drop any in-flight single-flight awaiter so NEW callers don't join an
		// in-progress compute and get handed the value we're evicting. This does
		// NOT stop a compute already past its get/inFlight check: its backend.put
		// can still land after the backend.delete below and re-publish the evicted
		// value, stale until the TTL (the next read then recomputes). Acceptable as
		// best-effort display/gating state; closing the window fully would need an
		// invalidation epoch, which is overkill for a 5-min-TTL hot-path cache.
		inFlight.delete(`${options.bucket}:${hash}`)
		yield* Effect.tryPromise({
			try: () => backend.delete(options.bucket, hash),
			catch: (error) => error,
		}).pipe(
			Effect.tapError((error) =>
				Effect.logWarning("Edge cache delete failed; entry will expire via TTL").pipe(
					Effect.annotateLogs({
						bucket: options.bucket,
						key: options.key,
						hash,
						error: String(error),
					}),
				),
			),
			Effect.ignore,
		)
	})

	const rawGetDetailed = Effect.fn("EdgeCache.rawGetDetailed")(function* <A>(bucket: string, key: string) {
		yield* Effect.annotateCurrentSpan({
			"cache.bucket": bucket,
			"cache.hit": false,
			"cache.read_ms": 0,
			"cache.read_timed_out": false,
		})
		const readStartedAt = yield* Clock.currentTimeMillis
		const nowMs = readStartedAt
		const read = yield* Effect.tryPromise({
			try: () => readBackend(bucket, key, nowMs),
			catch: (cause) =>
				new EdgeCacheIOError({
					op: "get",
					bucket,
					key,
					cause: cause instanceof Error ? cause.message : String(cause),
				}),
		})
		const value = read.value === undefined ? Option.none<A>() : Option.some(read.value as A)
		const status: EdgeCacheReadStatus = read.timedOut ? "timeout" : Option.isSome(value) ? "hit" : "miss"
		const readMs = (yield* Clock.currentTimeMillis) - readStartedAt
		yield* Effect.annotateCurrentSpan({
			"cache.hit": Option.isSome(value),
			"cache.read_ms": readMs,
			"cache.read_status": status,
			"cache.read_timed_out": read.timedOut,
		})
		return { status, value, readMs } satisfies EdgeCacheReadResult<A>
	})

	const rawGet = Effect.fn("EdgeCache.rawGet")(function* <A>(bucket: string, key: string) {
		return (yield* rawGetDetailed<A>(bucket, key)).value
	})

	const rawPut = Effect.fn("EdgeCache.rawPut")(function* (
		bucket: string,
		key: string,
		value: unknown,
		ttlSeconds: number,
	) {
		const nowMs = yield* Clock.currentTimeMillis
		return yield* Effect.tryPromise({
			try: () => backend.put(bucket, key, value, ttlSeconds, nowMs),
			catch: (cause) =>
				new EdgeCacheIOError({
					op: "put",
					bucket,
					key,
					cause: cause instanceof Error ? cause.message : String(cause),
				}),
		})
	})

	return { getOrCompute, invalidate, rawGetDetailed, rawGet, rawPut } satisfies EdgeCacheServiceShape
}

export class EdgeCacheService extends Context.Service<EdgeCacheService, EdgeCacheServiceShape>()(
	"@maple/api/lib/EdgeCacheService",
) {
	/**
	 * Backed by the injected `CacheBackend` (Workers KV in prod, in-memory in
	 * tests/dev — supplied by the host app). The runtime binding never enters
	 * this package, keeping `globalThis.caches` out of the web/cli bundles.
	 */
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const backend = yield* CacheBackend
			const readTimeoutMs = yield* Config.number("EDGE_CACHE_READ_TIMEOUT_MS").pipe(
				Config.withDefault(DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS),
			)
			return EdgeCacheService.of(makeEdgeCacheService(backend, readTimeoutMs))
		}),
	)
}
