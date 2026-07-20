import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { QueryEngineExecuteResponse } from "../query-engine"
import { EdgeCacheIOError, EdgeCacheService, makeEdgeCacheService, type EdgeCacheBackend } from "./edge-cache"

/**
 * In-memory backend that mirrors the Workers cache JSON-roundtrip:
 * `put` stringifies, `get` parses. This is what the production Workers
 * backend does — necessary to exercise the schema decode path that the
 * default in-process memory backend (which stores by reference) never hits.
 */
const makeJsonRoundtripBackend = (): EdgeCacheBackend & {
	store: Map<string, string>
} => {
	const store = new Map<string, string>()
	const composite = (bucket: string, hash: string) => `${bucket}:${hash}`
	return {
		store,
		get: async (bucket, hash) => {
			const raw = store.get(composite(bucket, hash))
			if (raw === undefined) return undefined
			return JSON.parse(raw) as unknown
		},
		put: async (bucket, hash, value) => {
			store.set(composite(bucket, hash), JSON.stringify(value))
		},
		delete: async (bucket, hash) => {
			store.delete(composite(bucket, hash))
		},
	}
}

const makeLayer = (backend: EdgeCacheBackend, readTimeoutMs?: number) =>
	Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend, readTimeoutMs))

describe("EdgeCacheService.getOrCompute (no schema)", () => {
	it.live("fails open to computation when a backend read exceeds its deadline", () => {
		let computeCalls = 0
		const backend: EdgeCacheBackend = {
			get: async () => await new Promise<never>(() => {}),
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const result = yield* cache.getOrCompute(
				{ bucket: "slow", key: "k1", ttlSeconds: 30 },
				Effect.sync(() => {
					computeCalls += 1
					return "computed"
				}),
			)

			assert.deepStrictEqual(result, { value: "computed", hit: false })
			assert.strictEqual(computeCalls, 1)
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(200))
	})

	it.live("shares the complete slow read-or-compute operation across concurrent callers", () => {
		let getCalls = 0
		let computeCalls = 0
		const backend: EdgeCacheBackend = {
			get: async () => {
				getCalls += 1
				return await new Promise<never>(() => {})
			},
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const options = { bucket: "slow", key: "shared", ttlSeconds: 30 } as const
			const compute = Effect.sync(() => {
				computeCalls += 1
				return "computed"
			})
			const results = yield* Effect.all(
				[cache.getOrCompute(options, compute), cache.getOrCompute(options, compute)],
				{ concurrency: "unbounded" },
			)

			assert.strictEqual(getCalls, 1)
			assert.strictEqual(computeCalls, 1)
			assert.deepStrictEqual(
				results.map(({ value }) => value),
				["computed", "computed"],
			)
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(200))
	})

	it.effect("round-trips a plain object through the JSON cache backend", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return { hello: "world", n: 42 }
			})
			const first = yield* cache.getOrCompute({ bucket: "plain", key: "k1", ttlSeconds: 30 }, compute)
			const second = yield* cache.getOrCompute({ bucket: "plain", key: "k1", ttlSeconds: 30 }, compute)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(first.hit, false)
			assert.deepStrictEqual(first.value, { hello: "world", n: 42 })
			assert.strictEqual(second.hit, true)
			assert.deepStrictEqual(second.value, { hello: "world", n: 42 })
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("derives the TTL from the computed value when ttlSeconds is a function", () => {
		const puts: number[] = []
		const backend: EdgeCacheBackend = {
			get: async () => undefined, // force a miss → always computes → always writes
			put: async (_bucket, _hash, _value, ttlSeconds) => {
				puts.push(ttlSeconds)
			},
			delete: async () => {},
		}
		const ttlBySize = (value: { n: number }) => (value.n > 10 ? 300 : 15)

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			yield* cache.getOrCompute(
				{ bucket: "ttl", key: "big", ttlSeconds: ttlBySize },
				Effect.succeed({ n: 42 }),
			)
			yield* cache.getOrCompute(
				{ bucket: "ttl", key: "small", ttlSeconds: ttlBySize },
				Effect.succeed({ n: 3 }),
			)

			// The resolver runs against each freshly computed value, not a constant.
			assert.deepStrictEqual(puts, [300, 15])
		}).pipe(Effect.provide(makeLayer(backend)))
	})
})

describe("EdgeCacheService.rawGet", () => {
	it.live("reports hit, miss, and timeout outcomes without collapsing them", () => {
		const backend: EdgeCacheBackend = {
			get: async (bucket) => {
				if (bucket === "hit") return { value: 42 }
				if (bucket === "slow") return await new Promise<never>(() => {})
				return undefined
			},
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const hit = yield* cache.rawGetDetailed<{ value: number }>("hit", "key")
			const miss = yield* cache.rawGetDetailed("miss", "key")
			const timeout = yield* cache.rawGetDetailed("slow", "key")

			assert.strictEqual(hit.status, "hit")
			assert.isTrue(Option.isSome(hit.value))
			assert.strictEqual(miss.status, "miss")
			assert.isTrue(Option.isNone(miss.value))
			assert.strictEqual(timeout.status, "timeout")
			assert.isTrue(Option.isNone(timeout.value))
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(200))
	})

	it.live("treats a backend read timeout as a cache miss", () => {
		const backend: EdgeCacheBackend = {
			get: async () => await new Promise<never>(() => {}),
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const result = yield* cache.rawGet("slow", "key")
			assert.isTrue(Option.isNone(result))
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(200))
	})

	it.effect("retains EdgeCacheIOError for backend failures", () => {
		const backend: EdgeCacheBackend = {
			get: async () => {
				throw new Error("kv unavailable")
			},
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const error = yield* cache.rawGet("failing", "key").pipe(Effect.flip)
			assert.instanceOf(error, EdgeCacheIOError)
			assert.strictEqual(error.cause, "kv unavailable")
		}).pipe(Effect.provide(makeLayer(backend, 10)))
	})
})

describe("EdgeCacheService.invalidate", () => {
	it.effect("evicts an entry so the next getOrCompute recomputes", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return { n: computeCalls }
			})
			const opts = { bucket: "autumn-customer", key: "org_123", ttlSeconds: 300 }

			const first = yield* cache.getOrCompute(opts, compute)
			const cached = yield* cache.getOrCompute(opts, compute)
			// Invalidate with the SAME { bucket, key } — must hash identically and hit.
			yield* cache.invalidate({ bucket: opts.bucket, key: opts.key })
			const afterInvalidate = yield* cache.getOrCompute(opts, compute)

			assert.strictEqual(first.hit, false)
			assert.strictEqual(cached.hit, true)
			assert.strictEqual(afterInvalidate.hit, false)
			assert.strictEqual(computeCalls, 2)
			assert.deepStrictEqual(afterInvalidate.value, { n: 2 })
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("is a no-op when the entry does not exist", () => {
		const backend = makeJsonRoundtripBackend()
		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			yield* cache.invalidate({ bucket: "autumn-customer", key: "missing" })
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("swallows backend delete failures (best-effort)", () => {
		const failing: EdgeCacheBackend = {
			get: async () => undefined,
			put: async () => {},
			delete: async () => {
				throw new Error("kv unavailable")
			},
		}
		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			// Must not fail the effect — invalidate is best-effort.
			yield* cache.invalidate({ bucket: "autumn-customer", key: "org_123" })
		}).pipe(Effect.provide(makeLayer(failing)))
	})
})

describe("EdgeCacheService.getOrCompute (with Schema.Class schema)", () => {
	it.effect("revives a Schema.Class instance after a JSON-roundtrip cache hit", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		const buildResponse = () =>
			new QueryEngineExecuteResponse({
				result: {
					kind: "timeseries" as const,
					source: "metrics" as const,
					data: [
						{ bucket: "2026-04-23T22:00:00.000Z", series: {} },
						{ bucket: "2026-04-23T23:00:00.000Z", series: { v: 1 } },
					],
				},
			})

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return buildResponse()
			})
			const first = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k1",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)
			const second = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k1",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(first.hit, false)
			assert.instanceOf(first.value, QueryEngineExecuteResponse)
			assert.strictEqual(second.hit, true)
			// The whole point of the fix: the cache HIT must give us back a real
			// class instance, not a plain object — otherwise the HTTP API encoder
			// rejects it with `Expected QueryEngineExecuteResponse, got {...}`.
			assert.instanceOf(second.value, QueryEngineExecuteResponse)
			assert.strictEqual(second.value.result.kind, "timeseries")
			if (second.value.result.kind === "timeseries") {
				assert.strictEqual(second.value.result.data.length, 2)
			}
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("treats a stale-shape cache entry as a miss and recomputes", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			// Pre-populate the cache with a value that does NOT match the schema.
			// The schema-aware decode should fail and the call should fall through
			// to the compute path, then overwrite the bad entry.
			const composite = "qe:" // bucket prefix
			const sha256Hex = (input: string): Promise<string> =>
				crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then((digest) => {
					const view = new Uint8Array(digest)
					let out = ""
					for (let i = 0; i < view.length; i++) {
						out += view[i]!.toString(16).padStart(2, "0")
					}
					return out
				})
			const hash = yield* Effect.promise(() => sha256Hex("k-stale"))
			backend.store.set(`${composite}${hash}`, JSON.stringify({ wrong: "shape" }))

			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries" as const,
						source: "logs" as const,
						data: [{ bucket: "2026-04-23T22:00:00.000Z", series: { c: 7 } }],
					},
				})
			})
			const result = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k-stale",
					ttlSeconds: 30,
					schema: QueryEngineExecuteResponse,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(result.hit, false)
			assert.instanceOf(result.value, QueryEngineExecuteResponse)
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.effect("dedupes concurrent callers; both receive a class instance", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sync(() => {
				computeCalls += 1
				return new QueryEngineExecuteResponse({
					result: {
						kind: "timeseries" as const,
						source: "traces" as const,
						data: [{ bucket: "2026-04-23T22:00:00.000Z", series: { x: 5 } }],
					},
				})
			})
			const opts = {
				bucket: "qe",
				key: "k-concurrent",
				ttlSeconds: 30,
				schema: QueryEngineExecuteResponse,
			} as const
			const [a, b] = yield* Effect.all(
				[cache.getOrCompute(opts, compute), cache.getOrCompute(opts, compute)],
				{ concurrency: "unbounded" },
			)

			// Compute should run at most once thanks to in-flight dedup. Both
			// results must be live class instances (the dedup path returns the
			// pre-encode value without going through decode).
			assert.strictEqual(computeCalls, 1)
			assert.instanceOf(a.value, QueryEngineExecuteResponse)
			assert.instanceOf(b.value, QueryEngineExecuteResponse)
		}).pipe(Effect.provide(makeLayer(backend)))
	})
})
