/**
 * @since 1.0.0
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Redis from "effect/unstable/persistence/Redis"
import * as IoRedis from "ioredis"

/**
 * @since 1.0.0
 * @category Service
 */
export class NodeRedis extends Context.Service<NodeRedis, {
  readonly client: IoRedis.Redis
  readonly use: <A>(f: (client: IoRedis.Redis) => Promise<A>) => Effect.Effect<A, Redis.RedisError>
}>()("@effect/platform-node/NodeRedis") {}

const make = Effect.fnUntraced(function*(
  options?: IoRedis.RedisOptions
) {
  const scope = yield* Effect.scope
  yield* Scope.addFinalizer(scope, Effect.promise(() => client.quit()))
  const client = new IoRedis.Redis(options ?? {})

  const use = <A>(f: (client: IoRedis.Redis) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(client),
      catch: (cause) => new Redis.RedisError({ cause })
    })

  const redis = yield* Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => client.call(command, ...args) as Promise<A>,
        catch: (cause) => new Redis.RedisError({ cause })
      })
  })

  const nodeRedis = Fn.identity<NodeRedis["Service"]>({
    client,
    use
  })

  return Context.make(NodeRedis, nodeRedis).pipe(
    Context.add(Redis.Redis, redis)
  )
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer = (
  options?: IoRedis.RedisOptions | undefined
): Layer.Layer<Redis.Redis | NodeRedis> => Layer.effectContext(make(options))

/**
 * @since 1.0.0
 * @category Layers
 */
export const layerConfig: (
  options: Config.Wrap<IoRedis.RedisOptions>
) => Layer.Layer<Redis.Redis | NodeRedis, Config.ConfigError> = (
  options: Config.Wrap<IoRedis.RedisOptions>
): Layer.Layer<Redis.Redis | NodeRedis, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(options).asEffect().pipe(
      Effect.flatMap(make)
    )
  )
