import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { EdgeCacheIOError, EdgeCacheService, makeEdgeCacheService, type EdgeCacheBackend } from "./edge-cache"
import { makeOutboundSlotsCell, trackOutboundSlot, type OutboundSlotsCell } from "./outbound-slots"

// A stand-in for whatever a caller caches. These tests used to reach for
// `CachedPayload`, which tied a generic cache to a query type; the
// property under test is that ANY `Schema.Class` survives the JSON round trip
// as a real instance, so a local class states it directly.
class CachedPayload extends Schema.Class<CachedPayload>("CachedPayload")({
	result: Schema.Struct({
		kind: Schema.Literals(["timeseries"]),
		source: Schema.String,
		data: Schema.Array(
			Schema.Struct({
				bucket: Schema.String,
				series: Schema.Record(Schema.String, Schema.Number),
			}),
		),
	}),
}) {}

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
		name: "memory",
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

const makeLayer = (backend: EdgeCacheBackend, readTimeoutMs?: number, slots?: OutboundSlotsCell) =>
	Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend, readTimeoutMs, slots))

describe("EdgeCacheService.getOrCompute (no schema)", () => {
	it.live("fails open to computation when a backend read exceeds its deadline", () => {
		let computeCalls = 0
		const backend: EdgeCacheBackend = {
			name: "memory",
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

	it.live("keeps slow read-or-compute work independent across concurrent callers", () => {
		let getCalls = 0
		let computeCalls = 0
		const backend: EdgeCacheBackend = {
			name: "memory",
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

			// The service is Worker-isolate scoped. Sharing either operation here
			// would let one Cloudflare request await I/O owned by another request.
			assert.strictEqual(getCalls, 2)
			assert.strictEqual(computeCalls, 2)
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
			name: "memory",
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
			name: "memory",
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
			name: "memory",
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
			name: "memory",
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
			name: "memory",
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
			new CachedPayload({
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
					schema: CachedPayload,
				},
				compute,
			)
			const second = yield* cache.getOrCompute(
				{
					bucket: "qe",
					key: "k1",
					ttlSeconds: 30,
					schema: CachedPayload,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(first.hit, false)
			assert.instanceOf(first.value, CachedPayload)
			assert.strictEqual(second.hit, true)
			// The whole point of the fix: the cache HIT must give us back a real
			// class instance, not a plain object — otherwise the HTTP API encoder
			// rejects it with `Expected CachedPayload, got {...}`.
			assert.instanceOf(second.value, CachedPayload)
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
				return new CachedPayload({
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
					schema: CachedPayload,
				},
				compute,
			)

			assert.strictEqual(computeCalls, 1)
			assert.strictEqual(result.hit, false)
			assert.instanceOf(result.value, CachedPayload)
		}).pipe(Effect.provide(makeLayer(backend)))
	})

	it.live("keeps concurrent schema-backed computations request-local", () => {
		const backend = makeJsonRoundtripBackend()
		let computeCalls = 0

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.sleep("5 millis").pipe(
				Effect.andThen(
					Effect.sync(() => {
						computeCalls += 1
						return new CachedPayload({
							result: {
								kind: "timeseries" as const,
								source: "traces" as const,
								data: [{ bucket: "2026-04-23T22:00:00.000Z", series: { x: 5 } }],
							},
						})
					}),
				),
			)
			const opts = {
				bucket: "qe",
				key: "k-concurrent",
				ttlSeconds: 30,
				schema: CachedPayload,
			} as const
			const [a, b] = yield* Effect.all(
				[cache.getOrCompute(opts, compute), cache.getOrCompute(opts, compute)],
				{ concurrency: "unbounded" },
			)

			assert.strictEqual(computeCalls, 2)
			assert.instanceOf(a.value, CachedPayload)
			assert.instanceOf(b.value, CachedPayload)
		}).pipe(Effect.provide(makeLayer(backend)))
	})
})

describe("EdgeCacheService read deadline", () => {
	// A backend whose `get` hangs for the first `hangCount` calls and then
	// resolves normally — the shape of a bucket under connection pressure that
	// later recovers.
	const makeHangingThenHealthyBackend = (hangCount: number) => {
		const store = new Map<string, unknown>()
		const composite = (bucket: string, hash: string) => `${bucket}:${hash}`
		let getCalls = 0
		const backend: EdgeCacheBackend = {
			name: "memory",
			get: async (bucket, hash) => {
				getCalls += 1
				if (getCalls <= hangCount) return await new Promise<never>(() => {})
				return store.get(composite(bucket, hash))
			},
			put: async (bucket, hash, value) => {
				store.set(composite(bucket, hash), value)
			},
			delete: async (bucket, hash) => {
				store.delete(composite(bucket, hash))
			},
		}
		return { backend, store, getCalls: () => getCalls }
	}

	// A backend whose reads take `readDelayMs` — slower than a tight service
	// deadline, well inside a generous per-call one.
	const makeSlowReadBackend = (readDelayMs: number): EdgeCacheBackend => {
		const store = new Map<string, unknown>()
		const composite = (bucket: string, hash: string) => `${bucket}:${hash}`
		return {
			name: "memory",
			get: async (bucket, hash) => {
				await new Promise((resolve) => setTimeout(resolve, readDelayMs))
				return store.get(composite(bucket, hash))
			},
			put: async (bucket, hash, value) => {
				store.set(composite(bucket, hash), value)
			},
			delete: async (bucket, hash) => {
				store.delete(composite(bucket, hash))
			},
		}
	}

	it.live("abandons a read slower than the service deadline", () => {
		// Baseline for the next test: at the service default this read never lands,
		// so the stored entry is invisible and the value is recomputed.
		const backend = makeSlowReadBackend(60)

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const opts = { bucket: "slow-default", key: "k", ttlSeconds: 30 } as const
			yield* cache.getOrCompute(opts, Effect.succeed("first"))
			const second = yield* cache.getOrCompute(opts, Effect.succeed("recomputed"))

			assert.deepStrictEqual(second, { value: "recomputed", hit: false })
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(2000))
	})

	it.live("lets a call override the service deadline and wait for the read", () => {
		// Same backend, same 10ms service default — only the per-call override
		// differs, and it is what turns the miss above into a hit.
		const backend = makeSlowReadBackend(60)

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const opts = { bucket: "slow-override", key: "k", ttlSeconds: 30, readTimeoutMs: 500 } as const
			yield* cache.getOrCompute(opts, Effect.succeed("first"))
			const second = yield* cache.getOrCompute(opts, Effect.succeed("recomputed"))

			assert.deepStrictEqual(second, { value: "first", hit: true })
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(2000))
	})

	it.live("stops reading a bucket whose reads keep timing out, then resumes after a success", () => {
		// Two timeouts take the decaying ratio past the open threshold (0.556) and
		// meet the minimum sample count, so the third call must not issue a read at
		// all — that read would only occupy a connection slot the rest of the
		// request needs.
		//
		// Two rather than three is load-bearing, not a tuning nudge: the requests
		// that actually suffer this contention make exactly two cache reads, so a
		// three-sample gate could never close in time to protect them. At three
		// this breaker never fired in production at all.
		const { backend, getCalls } = makeHangingThenHealthyBackend(3)

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.succeed("computed")
			const opts = { bucket: "hot", key: "k", ttlSeconds: 30 } as const

			yield* cache.getOrCompute(opts, compute)
			yield* cache.getOrCompute(opts, compute)
			assert.strictEqual(getCalls(), 2, "both reads were attempted and timed out")

			yield* cache.getOrCompute(opts, compute)
			assert.strictEqual(getCalls(), 2, "breaker skipped the read instead of issuing it")
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(2000))
	})

	it.live("opens the breaker on interleaved timeouts, not just consecutive ones", () => {
		// The regression this exists for: the breaker used to count *consecutive*
		// timeouts and reset to zero on any single success. Production timeouts
		// arrive interleaved (measured 61 timeouts against 45 hits and 236 misses
		// over 24h), so that counter never reached its threshold and every other
		// read kept paying the full deadline. A decaying ratio remembers the run.
		//
		// Alternating timeout/success at a 60% failure rate must open it.
		let call = 0
		const store = new Map<string, unknown>()
		const backend: EdgeCacheBackend = {
			name: "memory",
			get: async (bucket, hash) => {
				call += 1
				// Odd calls hang (timeout), even calls answer — T,S,T,S,T.
				if (call % 2 === 1) return await new Promise<never>(() => {})
				return store.get(`${bucket}:${hash}`)
			},
			put: async (bucket, hash, value) => {
				store.set(`${bucket}:${hash}`, value)
			},
			delete: async (bucket, hash) => {
				store.delete(`${bucket}:${hash}`)
			},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			const compute = Effect.succeed("computed")
			const opts = { bucket: "flappy", key: "k", ttlSeconds: 30 } as const

			for (let i = 0; i < 5; i++) {
				yield* cache.getOrCompute(opts, compute)
			}
			assert.strictEqual(call, 5, "all five reads were attempted")

			yield* cache.getOrCompute(opts, compute)
			assert.strictEqual(call, 5, "breaker opened despite the interleaved successes")
		}).pipe(Effect.provide(makeLayer(backend, 10)), Effect.timeout(2000))
	})

	it.live("skips the read when outbound slots are held and the bucket opts in", () => {
		const slots = makeOutboundSlotsCell()
		let getCalls = 0
		const backend: EdgeCacheBackend = {
			name: "memory",
			get: async () => {
				getCalls += 1
				return { cached: true }
			},
			put: async () => {},
			delete: async () => {},
		}

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			slots.acquire()

			// Opted-in bucket under pressure: no read, straight to compute.
			const skipped = yield* cache.getOrCompute(
				{ bucket: "cfg", key: "k", ttlSeconds: 30, skipReadWhenSlotsHeld: true },
				Effect.succeed("computed"),
			)
			assert.deepStrictEqual(skipped, { value: "computed", hit: false })
			assert.strictEqual(getCalls, 0)

			// The same pressure leaves a bucket that did NOT opt in untouched.
			const read = yield* cache.getOrCompute(
				{ bucket: "qe", key: "k", ttlSeconds: 30 },
				Effect.succeed("computed"),
			)
			assert.strictEqual(getCalls, 1)
			assert.strictEqual(read.hit, true)

			// Pressure gone: the opted-in bucket reads again.
			slots.release()
			yield* cache.getOrCompute(
				{ bucket: "cfg", key: "k", ttlSeconds: 30, skipReadWhenSlotsHeld: true },
				Effect.succeed("computed"),
			)
			assert.strictEqual(getCalls, 2)
		}).pipe(Effect.provide(makeLayer(backend, 50, slots)), Effect.timeout(2000))
	})

	it.live("counts an abandoned read as a held slot until the backend settles", () => {
		const slots = makeOutboundSlotsCell()
		let getCalls = 0
		let settleFirstRead: (() => void) | undefined
		const backend: EdgeCacheBackend = {
			name: "memory",
			get: async () => {
				getCalls += 1
				if (getCalls === 1) {
					// Hangs past the deadline; the test settles it explicitly later —
					// the shape of an uncancellable cache.match that resolves long
					// after the read abandoned it.
					return await new Promise<undefined>((resolve) => {
						settleFirstRead = () => resolve(undefined)
					})
				}
				return undefined
			},
			put: async () => {},
			delete: async () => {},
		}
		const opts = { bucket: "cfg", key: "k", ttlSeconds: 30, skipReadWhenSlotsHeld: true } as const

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService

			// No pressure yet, so the opted-in bucket reads — and the read hangs.
			const first = yield* cache.getOrCompute(opts, Effect.succeed("computed"))
			assert.strictEqual(first.hit, false)
			assert.strictEqual(getCalls, 1)
			assert.strictEqual(slots.held(), 1, "abandoned read still holds its slot")

			// The zombie alone is pressure: the next read is skipped, not issued.
			yield* cache.getOrCompute(opts, Effect.succeed("computed"))
			assert.strictEqual(getCalls, 1)

			// Once the underlying read finally settles, the slot frees and reads resume.
			settleFirstRead?.()
			// Macrotask hop: the release is chained a few microtasks behind the settle.
			yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
			assert.strictEqual(slots.held(), 0)
			yield* cache.getOrCompute(opts, Effect.succeed("computed"))
			assert.strictEqual(getCalls, 2)
		}).pipe(Effect.provide(makeLayer(backend, 10, slots)), Effect.timeout(2000))
	})

	it.effect("trackOutboundSlot holds the slot for exactly the effect's lifetime", () => {
		const slots = makeOutboundSlotsCell()
		return Effect.gen(function* () {
			const during = yield* trackOutboundSlot(
				Effect.sync(() => slots.held()),
				slots,
			)
			assert.strictEqual(during, 1)
			assert.strictEqual(slots.held(), 0)

			// Released on failure too.
			yield* trackOutboundSlot(Effect.fail("boom" as const), slots).pipe(Effect.flip)
			assert.strictEqual(slots.held(), 0)
		})
	})

	it.live("keeps serving hits from a bucket that never times out", () => {
		// Guards against the breaker firing on a healthy bucket: with no timeouts
		// the failure ratio stays at zero, so it can never reach the open
		// threshold no matter how many reads the bucket serves.
		const { backend } = makeHangingThenHealthyBackend(0)

		return Effect.gen(function* () {
			const cache = yield* EdgeCacheService
			yield* cache.getOrCompute({ bucket: "warm", key: "k", ttlSeconds: 30 }, Effect.succeed("v"))
			for (let i = 0; i < 5; i++) {
				const result = yield* cache.getOrCompute(
					{ bucket: "warm", key: "k", ttlSeconds: 30 },
					Effect.succeed("recomputed"),
				)
				assert.deepStrictEqual(result, { value: "v", hit: true })
			}
		}).pipe(Effect.provide(makeLayer(backend, 50)), Effect.timeout(2000))
	})
})
