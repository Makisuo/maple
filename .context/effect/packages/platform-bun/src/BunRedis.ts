/**
 * @since 1.0.0
 */
import { RedisClient, type RedisOptions } from "bun"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as ServiceMap from "effect/ServiceMap"
import * as Redis from "effect/unstable/persistence/Redis"

/**
 * @since 1.0.0
 * @category Service
 */
export class BunRedis extends ServiceMap.Service<BunRedis, {
  readonly client: RedisClient
  readonly use: <A>(f: (client: RedisClient) => Promise<A>) => Effect.Effect<A, Redis.RedisError>
}>()("@effect/platform-bun/BunRedis") {}

const make = Effect.fnUntraced(function*(
  options?: {
    readonly url?: string
  } & RedisOptions
) {
  const scope = yield* Effect.scope
  yield* Scope.addFinalizer(scope, Effect.sync(() => client.close()))
  const client = new RedisClient(options?.url, options)

  const use = <A>(f: (client: RedisClient) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(client),
      catch: (cause) => new Redis.RedisError({ cause })
    })

  const redis = yield* Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => client.send(command, args as Array<string>) as Promise<A>,
        catch: (cause) => new Redis.RedisError({ cause })
      })
  })

  const bunRedis = Fn.identity<BunRedis["Service"]>({
    client,
    use
  })

  return ServiceMap.make(BunRedis, bunRedis).pipe(
    ServiceMap.add(Redis.Redis, redis)
  )
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = (
  options?: ({ readonly url?: string } & RedisOptions) | undefined
): Layer.Layer<Redis.Redis | BunRedis> => Layer.effectServices(make(options))

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerConfig = (
  options: Config.Wrap<{ readonly url?: string } & RedisOptions>
): Layer.Layer<Redis.Redis | BunRedis, Config.ConfigError> =>
  Layer.effectServices(
    Config.unwrap(options).asEffect().pipe(
      Effect.flatMap(make)
    )
  )
