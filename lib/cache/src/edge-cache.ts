import { Clock, Config, Context, Effect, Layer, Option, Schema } from "effect"
import { CacheBackend, type EdgeCacheBackend } from "./cache-backend"

export { CacheBackend, type EdgeCacheBackend } from "./cache-backend"

export class EdgeCacheIOError extends Schema.TaggedError<EdgeCacheIOError>()(
	"@maple/cache/EdgeCacheIOError",
	{
		op: Schema.Literals(["get", "put"]),
		bucket: Schema.String,
		key: Schema.String,
		cause: Schema.String,
	},
) {
	override get message(): string {
		return `Edge cache ${this.op} failed for ${this.bucket}/${this.key}: ${this.cause}`
	}
}

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
	/**
	 * Override the read deadline for this call, in ms. Defaults to the service's.
	 *
	 * Worth setting when this entry's `compute` is expensive relative to waiting:
	 * the deadline's whole premise is that abandoning a read is cheap, and that
	 * only holds when `compute` was going to open a connection anyway. See
	 * `DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS`.
	 */
	readonly readTimeoutMs?: number
}

export interface EdgeCacheResult<A> {
	readonly value: A
	readonly hit: boolean
}

export interface EdgeCacheInvalidateOptions {
	readonly bucket: string
	readonly key: string
}

export type EdgeCacheReadStatus = "hit" | "miss" | "timeout" | "skipped"

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
 * Deadline for a single backend read before it is abandoned and treated as a
 * miss.
 *
 * Sized from prod telemetry (`cache.read_ms` on `EdgeCacheService.getOrCompute`,
 * 7 days), which is sharply bimodal rather than long-tailed:
 *
 *   <10ms   3170 reads     40-80ms      6 reads
 *   10-20ms  623 reads     80-150ms    12 reads
 *   20-40ms   65 reads     150-249ms    8 reads
 *   >=249ms 1255 reads (1145 of them abandoned at the deadline)
 *
 * A read that is going to succeed has done so by ~20ms; the 40-249ms band holds
 * 26 reads out of ~5,100 (0.5%). Reads past that are hung, not slow, so the old
 * 250ms deadline bought almost no extra hits and charged the full 250ms to every
 * hung read — 22% of all reads. 40ms sits above the real read distribution and
 * below the hang floor.
 *
 * The gap is empty because of how Cloudflare meters connections, not because
 * the cache is bimodally slow: `cache.match()` counts against the Worker's
 * six-simultaneous-connection limit while it waits for response headers, and a
 * seventh call is queued until one of the six gets its headers. So a read
 * either finds a free slot and returns in ~10ms, or it queues behind whatever
 * holds the slots — usually warehouse `fetch()` calls, which take 110ms to
 * several seconds to return headers. There is no middle. Measured: reads issued
 * while a warehouse query is in flight time out 29.9% of the time vs 16.6%
 * otherwise, and the rate climbs with the number of cache reads in the request
 * (1 read 8.4%, 4 reads 35.9%).
 *
 * Lowering this deadline therefore costs almost no hits: a queued read was
 * never going to arrive at 45ms. It does NOT fix the queueing itself.
 * https://developers.cloudflare.com/workers/platform/limits/
 *
 * The deadline's premise is that abandoning a read is cheap. That holds only
 * when `compute` was going to open a connection anyway — and it is false in the
 * worst case, because `Promise.race` cannot cancel the loser and a Workers
 * `cache.match()` is not cancellable at all. An abandoned read keeps its
 * connection slot until it finally resolves, so `compute` opens a *seventh*
 * connection and queues behind the read we just gave up on. Measured over 7
 * days: reads that completed cost a span p50 of 26ms on the org-config bucket,
 * reads abandoned at this deadline cost 2547ms — same compute, 98x apart.
 *
 * Two mitigations follow from that, both below: `readTimeoutMs` lets a caller
 * whose `compute` is expensive wait longer, and `READ_BREAKER_*` stops issuing
 * reads on a bucket that is timing out, since each one is a slot the rest of
 * the request cannot use.
 */
export const DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS = 40

/**
 * Consecutive timeouts on one bucket before reads are skipped, and how long to
 * skip them for.
 *
 * At a high timeout rate the reads are not merely useless, they are actively
 * harmful: each abandoned `cache.match()` holds one of the Worker's six
 * connection slots until it resolves, which is what makes the sibling reads
 * time out in the first place. Skipping is therefore self-correcting — fewer
 * reads in flight, fewer slots held, and the next read after the window has a
 * free slot to land in.
 *
 * Deliberately cheap to recover from: a single successful read resets the
 * counter, so a bucket that was momentarily contended is not penalised beyond
 * one window.
 */
const READ_BREAKER_TIMEOUTS = 2
const READ_BREAKER_WINDOW_MS = 2_000

/**
 * Build an `EdgeCacheServiceShape` against a specific backend. Exported for
 * tests so they can substitute a fake backend (e.g. a JSON-roundtripping one)
 * without going through `detectWorkersCache`.
 */
export const makeEdgeCacheService = (
	backend: EdgeCacheBackend,
	readTimeoutMs = DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS,
): EdgeCacheServiceShape => {
	const boundedReadTimeoutMs = Number.isFinite(readTimeoutMs)
		? Math.max(1, Math.floor(readTimeoutMs))
		: DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS
	// Per-bucket consecutive-timeout state for the read breaker. Isolate-scoped
	// and intentionally plain data — never an in-flight Promise or I/O handle,
	// which could not be shared across requests (see the note in `getOrCompute`).
	const readBreaker = new Map<string, { timeouts: number; skipUntil: number }>()

	const shouldSkipRead = (bucket: string, nowMs: number): boolean => {
		const state = readBreaker.get(bucket)
		return state !== undefined && nowMs < state.skipUntil
	}

	const recordReadOutcome = (bucket: string, timedOut: boolean, nowMs: number): void => {
		if (!timedOut) {
			readBreaker.delete(bucket)
			return
		}
		const timeouts = (readBreaker.get(bucket)?.timeouts ?? 0) + 1
		readBreaker.set(bucket, {
			timeouts,
			skipUntil: timeouts >= READ_BREAKER_TIMEOUTS ? nowMs + READ_BREAKER_WINDOW_MS : 0,
		})
	}

	const readBackend = (
		bucket: string,
		key: string,
		nowMs: number,
		timeoutMs: number,
	): Promise<{ readonly value: unknown | undefined; readonly timedOut: boolean }> => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<{ readonly value: undefined; readonly timedOut: true }>((resolve) => {
			timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), timeoutMs)
		})
		const read = Promise.resolve()
			.then(() => backend.get(bucket, key, nowMs))
			.then((value) => ({ value, timedOut: false as const }))
		return Promise.race([read, deadline]).finally(() => {
			if (timer !== undefined) clearTimeout(timer)
		})
	}

	const resolveReadTimeoutMs = (override: number | undefined): number =>
		override !== undefined && Number.isFinite(override)
			? Math.max(1, Math.floor(override))
			: boundedReadTimeoutMs
	const getOrCompute = Effect.fn("EdgeCacheService.getOrCompute")(function* <A, E, R, I = unknown>(
		options: EdgeCacheGetOrComputeOptions<A, I>,
		compute: Effect.Effect<A, E, R>,
	) {
		const hash = yield* Effect.promise(() => sha256Hex(options.key))
		yield* Effect.annotateCurrentSpan({
			"cache.bucket": options.bucket,
			"cache.backend": backend.name,
			"cache.hit": false,
			"cache.outcome": "pending",
			"cache.read_ms": 0,
			"cache.read_status": "pending",
			"cache.read_timed_out": false,
		})

		// Do not share an in-flight Effect, Deferred, or Promise here. This
		// service lives for the Worker isolate, while Cloudflare I/O objects are
		// owned by the request that created them. A follower request awaiting a
		// leader's effect can fail with "Cannot perform I/O on behalf of a
		// different request". Independent cold misses are safe; later calls still
		// converge through the cache backend.
		const writeValue = Effect.fnUntraced(function* (value: A) {
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
		})

		const body = Effect.gen(function* () {
			const readStartedAt = yield* Clock.currentTimeMillis
			const nowMs = readStartedAt
			const timeoutMs = resolveReadTimeoutMs(options.readTimeoutMs)
			yield* Effect.annotateCurrentSpan("cache.read_timeout_ms", timeoutMs)
			// The breaker is checked before the read, not after: the point is to NOT
			// occupy a connection slot on a bucket that is currently failing to
			// return one.
			const skipRead = shouldSkipRead(options.bucket, nowMs)
			const read = skipRead
				? { value: undefined, timedOut: false as const }
				: yield* Effect.tryPromise({
						try: () => readBackend(options.bucket, hash, nowMs, timeoutMs),
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
			if (!skipRead) recordReadOutcome(options.bucket, read.timedOut, nowMs)
			yield* Effect.annotateCurrentSpan({
				"cache.read_ms": readMs,
				"cache.read_status": skipRead
					? "skipped"
					: read.timedOut
						? "timeout"
						: read.value === undefined
							? "miss"
							: "hit",
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
						yield* Effect.annotateCurrentSpan({ "cache.hit": true, "cache.outcome": "hit" })
						return { value: decoded.value, hit: true }
					}
					// Fall through to recompute on decode failure (poisoned/stale entry).
					yield* Effect.annotateCurrentSpan("cache.read_status", "decode_miss")
				} else {
					const value = read.value as A
					yield* Effect.annotateCurrentSpan({ "cache.hit": true, "cache.outcome": "hit" })
					return { value, hit: true }
				}
			}

			const value = yield* compute
			yield* writeValue(value)
			yield* Effect.annotateCurrentSpan("cache.outcome", "miss")
			return { value, hit: false }
		})

		return yield* body
	})

	const invalidate = Effect.fn("EdgeCacheService.invalidate")(function* (
		options: EdgeCacheInvalidateOptions,
	) {
		const hash = yield* Effect.promise(() => sha256Hex(options.key))
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
		const skipRead = shouldSkipRead(bucket, nowMs)
		const read = skipRead
			? { value: undefined, timedOut: false as const }
			: yield* Effect.tryPromise({
					try: () => readBackend(bucket, key, nowMs, boundedReadTimeoutMs),
					catch: (cause) =>
						new EdgeCacheIOError({
							op: "get",
							bucket,
							key,
							cause: cause instanceof Error ? cause.message : String(cause),
						}),
				})
		if (!skipRead) recordReadOutcome(bucket, read.timedOut, nowMs)
		const value = read.value === undefined ? Option.none<A>() : Option.some(read.value as A)
		const status: EdgeCacheReadStatus = skipRead
			? "skipped"
			: read.timedOut
				? "timeout"
				: Option.isSome(value)
					? "hit"
					: "miss"
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
	"@maple/cache/EdgeCacheService",
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
