import { Context, Deferred, Effect, Layer } from "effect"

export interface EdgeCacheGetOrComputeOptions {
  readonly bucket: string
  readonly key: string
  readonly ttlSeconds: number
}

export interface EdgeCacheResult<A> {
  readonly value: A
  readonly hit: boolean
}

export interface EdgeCacheServiceShape {
  readonly getOrCompute: <A, E, R>(
    options: EdgeCacheGetOrComputeOptions,
    compute: Effect.Effect<A, E, R>,
  ) => Effect.Effect<EdgeCacheResult<A>, E, R>
}

interface EdgeCacheBackend {
  readonly get: (bucket: string, hash: string) => Promise<unknown | undefined>
  readonly put: (
    bucket: string,
    hash: string,
    value: unknown,
    ttlSeconds: number,
  ) => Promise<void>
}

const SYNTHETIC_HOST = "https://maple-api.internal"

const buildCacheUrl = (bucket: string, hash: string): string =>
  `${SYNTHETIC_HOST}/cache/${bucket}/${hash}`

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

const detectWorkersCache = (): Cache | null => {
  try {
    const g = globalThis as { caches?: { default?: Cache } }
    return g.caches?.default ?? null
  } catch {
    return null
  }
}

const makeWorkersBackend = (cache: Cache): EdgeCacheBackend => ({
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
})

interface MemoryEntry {
  readonly value: unknown
  readonly expiresAt: number
}

const makeMemoryBackend = (): EdgeCacheBackend => {
  const store = new Map<string, MemoryEntry>()
  const composite = (bucket: string, hash: string) => `${bucket}:${hash}`

  return {
    get: async (bucket, hash) => {
      const entry = store.get(composite(bucket, hash))
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        store.delete(composite(bucket, hash))
        return undefined
      }
      return entry.value
    },
    put: async (bucket, hash, value, ttlSeconds) => {
      store.set(composite(bucket, hash), {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      })
    },
  }
}

const makeService = (backend: EdgeCacheBackend): EdgeCacheServiceShape => {
  const inFlight = new Map<string, Deferred.Deferred<unknown, unknown>>()

  const getOrCompute = <A, E, R>(
    options: EdgeCacheGetOrComputeOptions,
    compute: Effect.Effect<A, E, R>,
  ): Effect.Effect<EdgeCacheResult<A>, E, R> =>
    Effect.gen(function* () {
      const hash = yield* Effect.promise(() => sha256Hex(options.key))
      const composite = `${options.bucket}:${hash}`

      const cached = yield* Effect.promise(() =>
        backend.get(options.bucket, hash),
      )
      if (cached !== undefined) {
        return { value: cached as A, hit: true }
      }

      const existing = inFlight.get(composite)
      if (existing) {
        const awaited = Deferred.await(existing) as Effect.Effect<A, E>
        const value = yield* awaited
        return { value, hit: true }
      }

      const deferred = yield* Deferred.make<A, E>()
      inFlight.set(composite, deferred as Deferred.Deferred<unknown, unknown>)

      const writeAndPublish = (value: A) =>
        Effect.andThen(
          Effect.promise(() =>
            backend.put(options.bucket, hash, value, options.ttlSeconds),
          ),
          Deferred.succeed(deferred, value),
        )

      const tapped: Effect.Effect<A, E, R> = Effect.tap(compute, writeAndPublish)
      const tappedError: Effect.Effect<A, E, R> = Effect.tapError(
        tapped,
        (error: E) => Deferred.fail(deferred, error),
      )
      const cleanup: Effect.Effect<A, E, R> = Effect.ensuring(
        tappedError,
        Effect.sync(() => {
          inFlight.delete(composite)
        }),
      )

      const value = yield* cleanup
      return { value, hit: false }
    })

  return { getOrCompute }
}

export class EdgeCacheService extends Context.Service<
  EdgeCacheService,
  EdgeCacheServiceShape
>()("EdgeCacheService") {
  static readonly layer = Layer.sync(this, () => {
    const workers = detectWorkersCache()
    return makeService(workers ? makeWorkersBackend(workers) : makeMemoryBackend())
  })

  static readonly Live = this.layer
  static readonly Default = this.layer
}
