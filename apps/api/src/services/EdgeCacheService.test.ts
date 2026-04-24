import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { QueryEngineExecuteResponse } from "@maple/query-engine"
import {
  EdgeCacheService,
  makeEdgeCacheService,
  type EdgeCacheBackend,
} from "./EdgeCacheService"

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
  }
}

const makeLayer = (backend: EdgeCacheBackend) =>
  Layer.succeed(EdgeCacheService, makeEdgeCacheService(backend))

describe("EdgeCacheService.getOrCompute (no schema)", () => {
  it("round-trips a plain object through the JSON cache backend", async () => {
    const backend = makeJsonRoundtripBackend()
    let computeCalls = 0

    const program = Effect.gen(function* () {
      const cache = yield* EdgeCacheService
      const compute = Effect.sync(() => {
        computeCalls += 1
        return { hello: "world", n: 42 }
      })
      const first = yield* cache.getOrCompute(
        { bucket: "plain", key: "k1", ttlSeconds: 30 },
        compute,
      )
      const second = yield* cache.getOrCompute(
        { bucket: "plain", key: "k1", ttlSeconds: 30 },
        compute,
      )
      return { first, second }
    })

    const { first, second } = await Effect.runPromise(
      program.pipe(Effect.provide(makeLayer(backend))),
    )

    expect(computeCalls).toBe(1)
    expect(first.hit).toBe(false)
    expect(first.value).toEqual({ hello: "world", n: 42 })
    expect(second.hit).toBe(true)
    expect(second.value).toEqual({ hello: "world", n: 42 })
  })
})

describe("EdgeCacheService.getOrCompute (with Schema.Class schema)", () => {
  it("revives a Schema.Class instance after a JSON-roundtrip cache hit", async () => {
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

    const program = Effect.gen(function* () {
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
      return { first, second }
    })

    const { first, second } = await Effect.runPromise(
      program.pipe(Effect.provide(makeLayer(backend))),
    )

    expect(computeCalls).toBe(1)
    expect(first.hit).toBe(false)
    expect(first.value).toBeInstanceOf(QueryEngineExecuteResponse)
    expect(second.hit).toBe(true)
    // The whole point of the fix: the cache HIT must give us back a real
    // class instance, not a plain object — otherwise the HTTP API encoder
    // rejects it with `Expected QueryEngineExecuteResponse, got {...}`.
    expect(second.value).toBeInstanceOf(QueryEngineExecuteResponse)
    expect(second.value.result.kind).toBe("timeseries")
    if (second.value.result.kind === "timeseries") {
      expect(second.value.result.data).toHaveLength(2)
    }
  })

  it("treats a stale-shape cache entry as a miss and recomputes", async () => {
    const backend = makeJsonRoundtripBackend()
    // Pre-populate the cache with a value that does NOT match the schema.
    // The schema-aware decode should fail and the call should fall through
    // to the compute path, then overwrite the bad entry.
    const composite = "qe:" // bucket prefix
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
    const hash = await sha256Hex("k-stale")
    backend.store.set(`${composite}${hash}`, JSON.stringify({ wrong: "shape" }))

    let computeCalls = 0

    const program = Effect.gen(function* () {
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
      return yield* cache.getOrCompute(
        {
          bucket: "qe",
          key: "k-stale",
          ttlSeconds: 30,
          schema: QueryEngineExecuteResponse,
        },
        compute,
      )
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(makeLayer(backend))),
    )

    expect(computeCalls).toBe(1)
    expect(result.hit).toBe(false)
    expect(result.value).toBeInstanceOf(QueryEngineExecuteResponse)
  })

  it("dedupes concurrent callers; both receive a class instance", async () => {
    const backend = makeJsonRoundtripBackend()
    let computeCalls = 0

    const program = Effect.gen(function* () {
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
      return { a, b }
    })

    const { a, b } = await Effect.runPromise(
      program.pipe(Effect.provide(makeLayer(backend))),
    )

    // Compute should run at most once thanks to in-flight dedup. Both
    // results must be live class instances (the dedup path returns the
    // pre-encode value without going through decode).
    expect(computeCalls).toBe(1)
    expect(a.value).toBeInstanceOf(QueryEngineExecuteResponse)
    expect(b.value).toBeInstanceOf(QueryEngineExecuteResponse)
  })
})
